import {
  type AudioPlayer,
  type AudioReceiveStream,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  getVoiceConnections,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  ChannelType,
  type Content,
  EventType,
  type HandlerCallback,
  type Memory,
  ModelType,
  stringToUuid,
  type UUID,
  createUniqueUuid,
  logger,
} from "@elizaos/core";

// See service.ts for detailed documentation on Discord ID handling.
// Key point: Discord snowflake IDs (e.g., "1253563208833433701") are NOT valid UUIDs.
// Use stringToUuid() to convert them, not asUUID() which would throw an error.
import type { ICompatRuntime } from "./compat";
import {
  type BaseGuildVoiceChannel,
  type Channel,
  type Client,
  ChannelType as DiscordChannelType,
  type Guild,
  type GuildMember,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import { EventEmitter } from 'node:events';
import { Readable, pipeline } from 'node:stream';
import prism from 'prism-media';
import type { DiscordService } from './service';
import { getMessageService } from './utils';
import { getDiscordSettings } from './environment';
import { DEFAULT_CHANNEL_CONFIGS } from './audioChannels';
import { DiscordEventTypes } from './types';

// These values are chosen for compatibility with picovoice components
const DECODE_FRAME_SIZE = 1024;
const DECODE_SAMPLE_RATE = 16000;

/**
 * Creates an opus decoder with fallback handling for different opus libraries
 * @param options - Decoder options including channels, rate, and frameSize
 * @returns An opus decoder instance or null if creation fails
 */
function createOpusDecoder(options: {
  channels: number;
  rate: number;
  frameSize: number;
}) {
  try {
    // First try to create decoder with prism-media
    return new prism.opus.Decoder(options);
  } catch (error) {
    // Note: Using global logger here as this is a standalone function without runtime context
    logger.warn(
      {
        src: "plugin:discord:service:voice",
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to create opus decoder",
    );

    // Log available opus libraries for debugging
    try {
      const { generateDependencyReport } = require("@discordjs/voice");
      const report = generateDependencyReport();
      logger.debug(
        { src: "plugin:discord:service:voice", report },
        "Voice dependency report",
      );
    } catch (reportError) {
      logger.warn(
        {
          src: "plugin:discord:service:voice",
          error:
            reportError instanceof Error
              ? reportError.message
              : String(reportError),
        },
        "Could not generate dependency report",
      );
    }

    throw error;
  }
}

/**
 * Generates a WAV file header based on the provided audio parameters.
 * @param {number} audioLength - The length of the audio data in bytes.
 * @param {number} sampleRate - The sample rate of the audio.
 * @param {number} [channelCount=1] - The number of channels (default is 1).
 * @param {number} [bitsPerSample=16] - The number of bits per sample (default is 16).
 * @returns {Buffer} The WAV file header as a Buffer object.
 */
function getWavHeader(
  audioLength: number,
  sampleRate: number,
  channelCount = 1,
  bitsPerSample = 16,
): Buffer {
  const wavHeader = Buffer.alloc(44);
  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + audioLength, 4); // Length of entire file in bytes minus 8
  wavHeader.write("WAVE", 8);
  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16); // Length of format data
  wavHeader.writeUInt16LE(1, 20); // Type of format (1 is PCM)
  wavHeader.writeUInt16LE(channelCount, 22); // Number of channels
  wavHeader.writeUInt32LE(sampleRate, 24); // Sample rate
  wavHeader.writeUInt32LE((sampleRate * bitsPerSample * channelCount) / 8, 28); // Byte rate
  wavHeader.writeUInt16LE((bitsPerSample * channelCount) / 8, 32); // Block align ((BitsPerSample * Channels) / 8)
  wavHeader.writeUInt16LE(bitsPerSample, 34); // Bits per sample
  wavHeader.write("data", 36); // Data chunk header
  wavHeader.writeUInt32LE(audioLength, 40); // Data chunk size
  return wavHeader;
}

/**
 * Class representing an AudioMonitor that listens for audio data from a Readable stream.
 */
export class AudioMonitor {
  private readable: Readable;
  private buffers: Buffer[] = [];
  private maxSize: number;
  private lastFlagged = -1;
  private ended = false;

  /**
   * Constructs an AudioMonitor instance.
   * @param {Readable} readable - The readable stream to monitor for audio data.
   * @param {number} maxSize - The maximum size of the audio buffer.
   * @param {function} onStart - The callback function to be called when audio starts.
   * @param {function} callback - The callback function to process audio data.
   */
  constructor(
    readable: Readable,
    maxSize: number,
    onStart: () => void,
    callback: (buffer: Buffer) => void,
  ) {
    this.readable = readable;
    this.maxSize = maxSize;
    this.readable.on("data", (chunk: Buffer) => {
      if (this.lastFlagged < 0) {
        this.lastFlagged = this.buffers.length;
      }
      this.buffers.push(chunk);
      const currentSize = this.buffers.reduce(
        (acc, cur) => acc + cur.length,
        0,
      );
      while (currentSize > this.maxSize) {
        this.buffers.shift();
        this.lastFlagged--;
      }
    });
    this.readable.on('end', () => {
      // Debug log removed - too noisy for production
      this.ended = true;
      if (this.lastFlagged < 0) {
        return;
      }
      callback(this.getBufferFromStart());
      this.lastFlagged = -1;
    });
    this.readable.on('speakingStopped', () => {
      if (this.ended) return;
      // Debug log removed - too noisy for production
      if (this.lastFlagged < 0) return;
      callback(this.getBufferFromStart());
    });
    this.readable.on("speakingStarted", () => {
      if (this.ended) {
        return;
      }
      onStart();
      // Debug log removed - too noisy for production
      this.reset();
    });
  }

  /**
   * Stops listening to "data", "end", "speakingStopped", and "speakingStarted" events on the readable stream.
   */
  stop() {
    this.readable.removeAllListeners("data");
    this.readable.removeAllListeners("end");
    this.readable.removeAllListeners("speakingStopped");
    this.readable.removeAllListeners("speakingStarted");
  }

  /**
   * Check if the item is flagged.
   * @returns {boolean} True if the item was flagged, false otherwise.
   */
  isFlagged() {
    return this.lastFlagged >= 0;
  }

  /**
   * Returns a Buffer containing all buffers starting from the last flagged index.
   * If the last flagged index is less than 0, returns null.
   *
   * @returns {Buffer | null} The concatenated Buffer or null
   */
  getBufferFromFlag() {
    if (this.lastFlagged < 0) {
      return null;
    }
    const buffer = Buffer.concat(this.buffers.slice(this.lastFlagged));
    return buffer;
  }

  /**
   * Concatenates all buffers in the array and returns a single buffer.
   *
   * @returns {Buffer} The concatenated buffer from the start.
   */
  getBufferFromStart() {
    const buffer = Buffer.concat(this.buffers);
    return buffer;
  }

  /**
   * Resets the buffers array and sets lastFlagged to -1.
   */
  reset() {
    this.buffers = [];
    this.lastFlagged = -1;
  }

  /**
   * Check if the object has ended.
   * @returns {boolean} Returns true if the object has ended; false otherwise.
   */
  isEnded() {
    return this.ended;
  }
}

/**
 * Configuration for an audio channel
 */
export interface AudioChannelConfig {
  channel: number;             // Channel number (0, 1, 2, 3, ...)
  priority: number;            // Higher priority interrupts lower (TTS=100, music=50, sfx=30)
  canPause: boolean;           // Whether channel supports pause/resume
  interruptible: boolean;       // Whether higher priority channels can interrupt
  volume?: number;             // Channel volume (0.0 to 1.0)
  duckVolume?: number;          // Volume when ducked by higher priority (default: 0.3)
}

/**
 * Handle for controlling audio playback
 */
export interface PlaybackHandle {
  finished: Promise<void>;
  cancelled: Promise<void>;
  abort(): void;
}

/**
 * Internal state for a channel player
 */
interface ChannelPlayerState {
  player: AudioPlayer;
  channel: number;
  guildId: string;
  resource: any;
  finished: () => void;
  cancelled: () => void;
  abortController?: AbortController;
  originalVolume?: number;
  duckedVolume?: number;
  volumeTransformer?: any; // VolumeTransformer from AudioResource when inlineVolume is enabled
}

/**
 * VoiceManager - Handles Discord voice connections and audio playback
 * 
 * ## Overview
 * This class manages all voice-related functionality for Discord bots:
 * - Joining and leaving voice channels
 * - Playing audio streams to voice channels
 * - Monitoring user audio (listening/transcription)
 * - Managing voice connection lifecycle
 * 
 * ## Audio Playback Architecture
 * Audio playback follows this pipeline:
 * 
 * ```
 * Audio Source (file/stream)
 *   ↓
 * Clean Stream (no listeners!)
 *   ↓
 * demuxProbe (format detection)
 *   ↓
 * AudioResource (format-specific decoding)
 *   ↓
 * AudioPlayer (packet generation)
 *   ↓
 * VoiceConnection (transmission)
 *   ↓
 * Discord Voice Servers
 * ```
 * 
 * ## Critical Stream Handling
 * ⚠️ Audio streams passed to playAudio() MUST be clean:
 * - NO event listeners (except 'error')
 * - NO stream control methods called (resume(), pause(), etc.)
 * - Let Discord.js handle all stream control
 * 
 * Adding listeners puts streams in paused mode, preventing demuxProbe from
 * reading stream headers and detecting format, which causes playback failure.
 * 
 * @extends EventEmitter
 * 
 * @example
 * ```typescript
 * // Create VoiceManager
 * const voiceManager = new VoiceManager(client, runtime);
 * 
 * // Join a channel
 * await voiceManager.handleUserConnected(guildId, channelId, userId);
 * 
 * // Play audio (stream must be clean!)
 * const stream = createReadStream('audio.opus');
 * await voiceManager.playAudio(stream, { guildId, channel: 1 });
 * ```
 */
export class VoiceManager extends EventEmitter {
  private processingVoice = false;
  private transcriptionTimeout: ReturnType<typeof setTimeout> | null = null;
  private userStates: Map<
    string,
    {
      buffers: Buffer[];
      totalLength: number;
      lastActive: number;
      transcriptionText: string;
    }
  > = new Map();
  private activeAudioPlayer: AudioPlayer | null = null; // Legacy - kept for backward compatibility
  private client: Client | null;
  private runtime: ICompatRuntime;
  private service: DiscordService;
  private streams: Map<string, Readable> = new Map();
  private connections: Map<string, VoiceConnection> = new Map(); // key: guildId
  private activeMonitors: Map<string, { channel: BaseGuildVoiceChannel; monitor: AudioMonitor }> =
    new Map();
  private monitoredUsers: Set<string> = new Set(); // Track which users are currently being monitored
  private voiceActivityStats: Map<
    string,
    {
      count: number;
      minVolume: number;
      maxVolume: number;
      sumVolume: number;
      firstActive: number;
      lastActive: number;
      userName: string;
    }
  > = new Map();
  private voiceStatFlushTimer: NodeJS.Timeout | null = null;
  private ready: boolean;
  private botId: string | null = null;  // Bot ID this VoiceManager belongs to
  private botAlias: string | undefined;  // Optional bot alias

  // Channel-based audio system
  private channels: Map<number, AudioChannelConfig> = new Map();
  private channelPlayers: Map<string, ChannelPlayerState> = new Map(); // key: `${guildId}:${channel}`

  // Desired state tracking: guildId -> channelId that agent should be in
  private desiredChannels: Map<string, string> = new Map(); // key: guildId, value: channelId
  private reconnectTimeouts: Map<string, NodeJS.Timeout> = new Map(); // key: guildId

  // Voice activity ducking state
  private duckedGuilds: Map<
    string,
    {
      originalVolume: number;
      silenceTimer: NodeJS.Timeout | null;
      rampTimer: NodeJS.Timeout | null;
    }
  > = new Map(); // key: guildId
  private duckingConfig: {
    duckVolume: number;
    silenceTimeout: number;
    rampDuration: number;
    speakingThreshold: number;
  };
  // Voice connection health tracking
  private connectionHealth: Map<string, { lastReady: number }> = new Map(); // key: guildId
  private connectionWatchdog: NodeJS.Timeout | null = null;

  // Audio state tracking (server mute/deafen)
  private audioStates: Map<
    string,
    {
      serverMute: boolean;
      serverDeaf: boolean;
      selfMute: boolean;
      selfDeaf: boolean;
      lastUpdated: number;
    }
  > = new Map(); // key: guildId

  /**
   * Get a human-readable identifier for logging (character name or agentId fallback)
   */
  private get agentIdentifier(): string {
    return this.runtime?.character?.name || this.runtime.agentId;
  }

  /**
   * Constructor for initializing a new instance of the class.
   *
   * @param {DiscordService} service - The Discord service to use.
   * @param {ICompatRuntime} runtime - The runtime for the agent (with cross-core compat).
   */
  constructor(service: DiscordService, runtime: ICompatRuntime) {
    super();
    this.client = service.client;
    this.service = service;
    this.runtime = runtime;
    this.ready = false;

    // Load ducking configuration from settings
    const discordSettings = getDiscordSettings(runtime);
    this.duckingConfig = {
      duckVolume: discordSettings.voiceDuckVolume ?? 0.2,
      silenceTimeout: discordSettings.voiceDuckSilenceTimeout ?? 60000,
      rampDuration: discordSettings.voiceDuckRampDuration ?? 3000,
      speakingThreshold: discordSettings.voiceSpeakingThreshold ?? 0.1,
    };

    // Register default audio channels (TTS, Music, SFX, Ambient)
    // WHY REGISTER ON CONSTRUCTION:
    // Ensures all standard channels are available immediately when VoiceManager starts.
    // Other plugins can rely on these channels existing without explicit registration.
    for (const config of Object.values(DEFAULT_CHANNEL_CONFIGS)) {
      this.registerChannel(config);
    }

    // Listen for channel registration requests from plugins
    this.on('registerChannel', (config: AudioChannelConfig) => {
      this.registerChannel(config);
    });

    // Note: Client may be null at construction time if called before login
    // The setClient() method will be called later to set the client and register events
    if (this.client) {
      this.client.on("voiceManagerReady", () => {
        this.setReady(true);
        // Set bot ID when client is ready
        if (this.client?.user) {
          this.botId = this.client.user.id;
        }
      });
    } else {
      this.runtime.logger.error(
        { src: 'plugin:discord:service:voice', agentId: this.agentIdentifier },
        '[VoiceManager] Client not available at construction time - will be set later via setClient()'
      );
      this.ready = false;
    }

    // Start voice stats flush timer
    this.voiceStatFlushTimer = setInterval(() => {
      this.flushVoiceActivityStats();
    }, 30000); // Flush every 30 seconds

    // Start watchdog to detect stale/disconnected voice sessions faster
    this.connectionWatchdog = setInterval(() => {
      this.checkConnectionHealth();
    }, 5000); // Check every 5 seconds
  }

  /**
   * Set the bot identification for this VoiceManager
   * @param botId Discord bot user ID
   * @param botAlias Optional bot alias
   */
  setBotIdentification(botId: string, botAlias?: string) {
    this.botId = botId;
    this.botAlias = botAlias;
    this.runtime.logger.debug(`[VoiceManager] Bot identification set: ${botId} (${botAlias || 'no alias'})`);
  }

  private flushVoiceActivityStats() {
    if (this.voiceActivityStats.size === 0) return;

    this.voiceActivityStats.forEach((stats, _userId) => {
      if (stats.count > 0) {
        const avgVolume = stats.sumVolume / stats.count;
        const timeSpanMs = stats.lastActive - stats.firstActive;
        const timeSpanSec = (timeSpanMs / 1000).toFixed(1);
        logger.info(
          `[VoiceActivity] Summary for ${stats.userName} (${timeSpanSec}s): ${stats.count} detections, vol: ${stats.minVolume.toFixed(3)}-${stats.maxVolume.toFixed(3)} (avg ${avgVolume.toFixed(3)})`
        );
      }
    });

    // Clear stats after flush
    this.voiceActivityStats.clear();
  }

  /**
   * Periodically verify voice connection health and trigger fast recovery
   * Useful when Discord silently drops the voice session without emitting state changes.
   */
  private checkConnectionHealth(): void {
    const now = Date.now();

    for (const [guildId, connection] of this.connections.entries()) {
      // Skip while a scheduled reconnect is in-flight
      if (this.reconnectTimeouts.has(guildId)) {
        continue;
      }

      const status = connection.state.status;
      const health = this.connectionHealth.get(guildId) || { lastReady: now };

      if (status === VoiceConnectionStatus.Ready) {
        // Healthy connection - update last seen time
        health.lastReady = now;
        this.connectionHealth.set(guildId, health);
        continue;
      }

      const timeSinceReady = now - health.lastReady;

      // If we've been away from Ready for too long, attempt recovery
      if (timeSinceReady > 15000) {
        logger.warn(
          `[VoiceManager] Connection for guild ${guildId} stuck in state ${status} for ${timeSinceReady}ms - attempting recovery`
        );

        const desiredChannel = this.desiredChannels.get(guildId);

        if (desiredChannel) {
          this.reconnectToDesiredChannel(guildId, desiredChannel).catch((error) => {
            logger.error(
              `[VoiceManager] Health check reconnect failed for guild ${guildId}: ${error instanceof Error ? error.message : String(error)}`
            );
          });
        } else {
          // No desired state to restore; clean up the bad connection
          connection.destroy();
          this.connections.delete(guildId);
          this.connectionHealth.delete(guildId);
          logger.debug(
            `[VoiceManager] Destroyed stale connection for guild ${guildId} (no desired channel to recover)`
          );
        }
      }
    }

    // Clean up health records for guilds without active connections
    for (const guildId of Array.from(this.connectionHealth.keys())) {
      if (!this.connections.has(guildId)) {
        this.connectionHealth.delete(guildId);
      }
    }
  }

  /**
   * Clean up VoiceManager resources (timers, stats, etc.)
   * Call this when the service is shutting down
   */
  cleanup() {
    // Flush any remaining stats
    this.flushVoiceActivityStats();

    // Clear the flush timer
    if (this.voiceStatFlushTimer) {
      clearInterval(this.voiceStatFlushTimer);
      this.voiceStatFlushTimer = null;
    }

    // Clear the connection watchdog
    if (this.connectionWatchdog) {
      clearInterval(this.connectionWatchdog);
      this.connectionWatchdog = null;
    }

    // Clear reconnect timeouts
    for (const timeout of this.reconnectTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.reconnectTimeouts.clear();

    // Clear ducking timers
    for (const duckState of this.duckedGuilds.values()) {
      if (duckState.silenceTimer) clearTimeout(duckState.silenceTimer);
      if (duckState.rampTimer) clearTimeout(duckState.rampTimer as any);
    }
    this.duckedGuilds.clear();

    // Clean up active bridges
    for (const cleanup of this.activeBridges.values()) {
      cleanup();
    }
    this.activeBridges.clear();

    logger.debug('[VoiceManager] Cleanup completed');
  }

  /**
   * Set the Discord client and register event listeners
   * Called after the client has logged in successfully
   * @param client Discord.js client instance
   */
  setClient(client: Client) {
    this.client = client;

    // Register the voiceManagerReady event listener
    this.client.on('voiceManagerReady', () => {
      this.setReady(true);
      // Set bot ID when client is ready
      if (this.client?.user) {
        this.botId = this.client.user.id;
      }
    });

    logger.debug('[VoiceManager] Client set and event listeners registered');
  }

  /**
   * Get the bot ID this VoiceManager belongs to
   */
  getBotId(): string | null {
    return this.botId;
  }

  /**
   * Asynchronously retrieves the type of the channel.
   * @param {Channel} channel - The channel to get the type for.
   * @returns {Promise<ChannelType>} The type of the channel.
   */
  async getChannelType(channel: Channel): Promise<ChannelType> {
    switch (channel.type) {
      case DiscordChannelType.GuildVoice:
      case DiscordChannelType.GuildStageVoice:
        return ChannelType.VOICE_GROUP;
      default:
        // This function should only be called with GuildVoice or GuildStageVoice channels
        // If it receives another type, it's an unexpected error.
        this.runtime.logger.error(
          {
            src: "plugin:discord:service:voice",
            agentId: this.agentIdentifier,
            channelId: channel.id,
            channelType: channel.type,
          },
          "Unexpected channel type",
        );
        throw new Error(`Unexpected channel type encountered: ${channel.type}`);
    }
  }

  /**
   * Set the ready status of the VoiceManager.
   * @param {boolean} status - The status to set.
   */
  private setReady(status: boolean) {
    this.ready = status;
    this.emit("ready");
    this.runtime.logger.debug(
      {
        src: "plugin:discord:service:voice",
        agentId: this.agentIdentifier,
        ready: this.ready,
      },
      "VoiceManager ready status changed",
    );
  }

  /**
   * Check if the object is ready.
   *
   * @returns {boolean} True if the object is ready, false otherwise.
   */
  isReady() {
    return this.ready;
  }

  /**
   * Handle voice state update event.
   * @param {VoiceState} oldState - The old voice state of the member.
   * @param {VoiceState} newState - The new voice state of the member.
   * @returns {void}
   */
  async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;
    const member = newState.member;
    if (!member) {
      return;
    }
    if (member.id === this.client?.user?.id) {
      return;
    }

    const guildId = member.guild.id;

    // Ignore mute/unmute events
    if (oldChannelId === newChannelId) {
      return;
    }

    // User leaving a channel where the agent is present
    // Check if we have a connection for this guild
    if (oldChannelId && this.connections.has(guildId)) {
      this.stopMonitoringMember(member.id);
    }

    // User joining a channel where the agent is present
    // Check if we have a connection for this guild
    if (newChannelId && this.connections.has(guildId)) {
      await this.monitorMember(member, newState.channel as BaseGuildVoiceChannel);
    }
  }

  /**
   * Joins a voice channel and sets up the necessary connection and event listeners.
   * @param {BaseGuildVoiceChannel} channel - The voice channel to join
   */
  async joinChannel(channel: BaseGuildVoiceChannel) {
    const oldConnection = this.getVoiceConnection(channel.guildId as string);
    if (oldConnection) {
      try {
        oldConnection.destroy();
        // Remove all associated streams and monitors
        this.streams.clear();
        this.activeMonitors.clear();
        this.monitoredUsers.clear();
      } catch (error) {
        this.runtime.logger.error(
          {
            src: "plugin:discord:service:voice",
            agentId: this.agentIdentifier,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error leaving voice channel",
        );
      }
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: false,
      selfMute: false,
      group: this.client?.user?.id ?? "default-group",
    });

    try {
      // Wait for either Ready or Signalling state
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Ready, 20_000),
        entersState(connection, VoiceConnectionStatus.Signalling, 20_000),
      ]);

      // Store connection by guildId (new system)
      const guildId = channel.guild.id;
      this.connections.set(guildId, connection);

      // Register with VoiceConnectionManager if available
      if (this.botId && this.service.voiceConnectionManager) {
        this.service.voiceConnectionManager.registerConnection(
          this.botId,
          guildId,
          channel.id,
          channel,
          this,
          this.botAlias
        );
      }

      // Log connection success
      this.runtime.logger.info(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          status: connection.state.status,
        },
        "Voice connection established",
      );

      // Set up ongoing state change monitoring
      connection.on("stateChange", async (oldState, newState) => {
        // Skip logging if state hasn't actually changed
        // Discord.js may emit stateChange even when status is the same
        if (oldState.status !== newState.status) {
          this.runtime.logger.debug(
            {
              src: "plugin:discord:service:voice",
              agentId: this.agentIdentifier,
              oldState: oldState.status,
              newState: newState.status,
            },
            "Voice connection state changed",
          );
        }

        if (newState.status === VoiceConnectionStatus.Disconnected) {
          this.runtime.logger.debug(
            {
              src: "plugin:discord:service:voice",
              agentId: this.agentIdentifier,
            },
            "Handling disconnection",
          );

          try {
            // Try to reconnect if disconnected
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
            // Seems to be reconnecting to a new channel
            this.runtime.logger.debug(
              {
                src: "plugin:discord:service:voice",
                agentId: this.agentIdentifier,
              },
              "Reconnecting to channel",
            );
          } catch (e) {
            // Seems to be a real disconnect, destroy and cleanup
            this.runtime.logger.debug(
              {
                src: "plugin:discord:service:voice",
                agentId: this.agentIdentifier,
                error: e instanceof Error ? e.message : String(e),
              },
              "Disconnection confirmed - cleaning up",
            );
            connection.destroy();
            this.connections.delete(guildId);
          }
        } else if (newState.status === VoiceConnectionStatus.Destroyed) {
          this.connections.delete(guildId);
        } else if (newState.status === VoiceConnectionStatus.Ready) {
          // Connection is ready - ensure it's in our map
          if (!this.connections.has(guildId)) {
            this.connections.set(guildId, connection);
          }

          // Resume any autopaused players after reconnection
          // This handles network hiccups where the player autopausesdue to missing connection
          if (oldState.status === VoiceConnectionStatus.Connecting ||
            oldState.status === VoiceConnectionStatus.Signalling) {
            logger.log(`[Voice] Connection restored for guild ${guildId}, checking for autopaused players...`);
            await this.resumeAutopausedPlayers(guildId, connection);
          }
        } else if (
          !this.connections.has(guildId) &&
          newState.status === VoiceConnectionStatus.Signalling
        ) {
          this.connections.set(guildId, connection);
        }
      });

      connection.on("error", (error) => {
        this.runtime.logger.error(
          {
            src: "plugin:discord:service:voice",
            agentId: this.agentIdentifier,
            error: error instanceof Error ? error.message : String(error),
          },
          "Voice connection error",
        );
        // Don't immediately destroy - let the state change handler deal with it
        this.runtime.logger.debug(
          {
            src: "plugin:discord:service:voice",
            agentId: this.agentIdentifier,
          },
          "Will attempt to recover",
        );
      });

      // Continue with voice state modifications
      const me = channel.guild.members.me;
      if (me?.voice && me.permissions.has("DeafenMembers")) {
        try {
          await me.voice.setDeaf(false);
          await me.voice.setMute(false);
        } catch (error) {
          this.runtime.logger.warn(
            {
              src: "plugin:discord:service:voice",
              agentId: this.agentIdentifier,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to modify voice state",
          );
          // Continue even if this fails
        }
      }

      // Initialize audio state from current voice state
      if (me?.voice) {
        await this.updateAudioState(guildId, me.voice);
      }

      connection.receiver.speaking.on('start', async (entityId: string) => {
        let user = channel.members.get(entityId);
        if (!user) {
          try {
            user = await channel.guild.members.fetch(entityId);
          } catch (error) {
            this.runtime.logger.error(
              {
                src: "plugin:discord:service:voice",
                agentId: this.agentIdentifier,
                entityId,
                error: error instanceof Error ? error.message : String(error),
              },
              "Failed to fetch user",
            );
          }
        }

        if (user && !user?.user.bot) {
          // Only start monitoring if not already monitoring this user
          if (!this.monitoredUsers.has(entityId)) {
            this.monitorMember(user as GuildMember, channel);
          }
          this.streams.get(entityId)?.emit('speakingStarted');
        }
      });

      connection.receiver.speaking.on("end", async (entityId: string) => {
        const user = channel.members.get(entityId);
        if (!user?.user.bot) {
          this.streams.get(entityId)?.emit("speakingStopped");
        }
      });
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to establish voice connection",
      );
      connection.destroy();
      const guildIdForCleanup = channel.guild.id;
      this.connections.delete(guildIdForCleanup);
      throw error;
    }
  }

  /**
   * Retrieves the voice connection for a given guild ID.
   * @param {string} guildId - The ID of the guild to get the voice connection for.
   * @returns {VoiceConnection | undefined} The voice connection for the specified guild ID, or undefined if not found.
   */
  getVoiceConnection(guildId: string) {
    const userId = this.client?.user?.id;
    if (!userId) {
      this.runtime.logger.error(
        { src: "plugin:discord:service:voice", agentId: this.agentIdentifier },
        "Client user ID not available",
      );
      return undefined;
    }
    const connections = getVoiceConnections(userId);
    if (!connections) {
      return;
    }
    const connection = [...connections.values()].find(
      (connection) => connection.joinConfig.guildId === guildId,
    );
    return connection;
  }

  /**
   * Monitor a member's audio stream for volume activity and speaking thresholds.
   *
   * @param {GuildMember} member - The member whose audio stream is being monitored.
   * @param {BaseGuildVoiceChannel} channel - The voice channel in which the member is connected.
   */
  private async monitorMember(
    member: GuildMember,
    channel: BaseGuildVoiceChannel,
  ) {
    const entityId = member?.id;
    const userName = member?.user?.username;
    // Use server-specific displayName (nickname) if available, fallback to global displayName
    const name = member?.displayName || member?.user?.displayName;
    const guildId = member?.guild?.id;

    // Check if we're already monitoring this user to prevent duplicate monitors
    // IMPORTANT: Add to monitoredUsers immediately to prevent race conditions
    // Between the has() check and add(), another call could pass the check
    if (this.monitoredUsers.has(entityId)) {
      this.runtime.logger.debug(`[monitorMember] Already monitoring user ${entityId}`);
      return;
    }
    // Mark as monitored BEFORE any async work to prevent duplicate monitors
    this.monitoredUsers.add(entityId);

    const connection = this.getVoiceConnection(guildId);
    if (!connection) {
      this.runtime.logger.warn(`[monitorMember] No voice connection for guild ${guildId}`);
      this.monitoredUsers.delete(entityId); // Clean up on early exit
      return;
    }

    const receiveStream = connection?.receiver.subscribe(entityId, {
      autoDestroy: true,
      emitClose: true,
    });
    if (!receiveStream || receiveStream.readableLength === 0) {
      this.runtime.logger.warn(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          entityId,
        },
        "No receiveStream or empty stream",
      );
      this.monitoredUsers.delete(entityId); // Clean up on early exit
      return;
    }

    // Set maxListeners to prevent warnings (pipeline adds multiple listeners)
    receiveStream.setMaxListeners(20);

    let opusDecoder: any;
    try {
      // Try to create opus decoder with error handling for Node.js 23 compatibility
      opusDecoder = createOpusDecoder({
        channels: 1,
        rate: DECODE_SAMPLE_RATE,
        frameSize: DECODE_FRAME_SIZE,
      });
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          entityId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to create opus decoder",
      );
      // Clean up monitoring state on failure
      this.monitoredUsers.delete(entityId);
      // For now, log the error and return early.
      // In production, you might want to implement a PCM fallback or other audio processing
      return;
    }

    const volumeBuffer: number[] = [];
    const VOLUME_WINDOW_SIZE = 30;
    let dataPacketCount = 0;
    let lastLogTime = Date.now();
    const LOG_INTERVAL = 2000; // Log every 2 seconds
    let firstDataReceived = false;

    opusDecoder.on('data', (pcmData: Buffer) => {
      const SPEAKING_THRESHOLD = this.duckingConfig.speakingThreshold;
      if (!firstDataReceived) {
        firstDataReceived = true;
        this.runtime.logger.debug(`[VoiceActivity] Audio stream active for user ${entityId}`);
      }

      dataPacketCount++;
      const now = Date.now();

      const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.length / 2);
      const maxAmplitude = Math.max(...samples.map(Math.abs)) / 32768;
      volumeBuffer.push(maxAmplitude);

      if (volumeBuffer.length > VOLUME_WINDOW_SIZE) {
        volumeBuffer.shift();
      }
      const avgVolume = volumeBuffer.reduce((sum, v) => sum + v, 0) / volumeBuffer.length;

      // Log periodically for debugging (reduced frequency)
      if (now - lastLogTime >= LOG_INTERVAL) {
        logger.debug(
          `[VoiceActivity] ${userName}: avgVol=${avgVolume.toFixed(3)}, threshold=${SPEAKING_THRESHOLD}`
        );
        lastLogTime = now;
      }

      if (avgVolume > SPEAKING_THRESHOLD) {
        // Accumulate stats instead of logging immediately
        let stats = this.voiceActivityStats.get(entityId);
        if (!stats) {
          stats = {
            count: 0,
            minVolume: 1.0,
            maxVolume: 0.0,
            sumVolume: 0.0,
            firstActive: now,
            lastActive: now,
            userName: userName
          };
          this.voiceActivityStats.set(entityId, stats);
        }

        stats.count++;
        stats.minVolume = Math.min(stats.minVolume, avgVolume);
        stats.maxVolume = Math.max(stats.maxVolume, avgVolume);
        stats.sumVolume += avgVolume;
        stats.lastActive = now;

        volumeBuffer.length = 0;

        // Stop TTS/activeAudioPlayer (channel 0) when others speak
        if (this.activeAudioPlayer) {
          this.cleanupAudioPlayer(this.activeAudioPlayer);
          this.processingVoice = false;
        }

        // Duck music volume (channel 1) when others speak
        if (guildId) {
          this.duckMusicVolume(guildId);
        }
      }
    });

    // User is already marked as monitored at function start (before async work)
    // to prevent race conditions. Pipeline callback handles cleanup on completion.

    pipeline(receiveStream as AudioReceiveStream, opusDecoder as any, (err: Error | null) => {
      if (err) {
        this.runtime.logger.debug(
          { src: 'plugin:discord:service:voice', agentId: this.agentIdentifier, entityId, error: err.message },
          'Opus decoding pipeline error'
        );
      } else {
        this.runtime.logger.debug(
          { src: 'plugin:discord:service:voice', agentId: this.agentIdentifier, entityId },
          'Opus decoding pipeline finished'
        );
      }
      // Clean up monitoring state when pipeline ends
      this.monitoredUsers.delete(entityId);
    });
    this.streams.set(entityId, opusDecoder);
    // Note: Connection is already stored by guildId, no need to store by entityId
    opusDecoder.on('error', (err: any) => {
      this.runtime.logger.debug(
        { src: 'plugin:discord:service:voice', agentId: this.agentIdentifier, error: err instanceof Error ? err.message : String(err) },
        'Opus decoding error'
      );
    });
    const errorHandler = (err: any) => {
      this.runtime.logger.debug(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          error: err instanceof Error ? err.message : String(err),
        },
        "Opus decoding error",
      );
    };
    const streamCloseHandler = () => {
      this.runtime.logger.debug(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          member: member?.displayName,
        },
        "Voice stream closed",
      );
      this.streams.delete(entityId);
      this.monitoredUsers.delete(entityId);
      // Note: Connection is stored by guildId, not entityId
    };
    const closeHandler = () => {
      this.runtime.logger.debug(
        { src: 'plugin:discord:service:voice', agentId: this.agentIdentifier, member: member?.displayName },
        'Opus decoder closed'
      );
      opusDecoder.removeListener('error', errorHandler);
      opusDecoder.removeListener('close', closeHandler);
      receiveStream?.removeListener('close', streamCloseHandler);
      this.monitoredUsers.delete(entityId);
    };
    opusDecoder.on("error", errorHandler);
    opusDecoder.on("close", closeHandler);
    receiveStream?.on("close", streamCloseHandler);

    this.client?.emit(
      "userStream",
      entityId,
      name,
      userName,
      channel,
      opusDecoder,
    );
  }

  /**
   * Leaves the specified voice channel and stops monitoring all members in that channel.
   * If there is an active connection in the channel, it will be destroyed.
   *
   * @param {BaseGuildVoiceChannel} channel - The voice channel to leave.
   */
  leaveChannel(channel: BaseGuildVoiceChannel) {
    const guildId = channel.guild.id;

    // Clear desired state when intentionally leaving
    this.desiredChannels.delete(guildId);

    // Clear any pending reconnect timeout
    const existingTimeout = this.reconnectTimeouts.get(guildId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.reconnectTimeouts.delete(guildId);
    }

    const connection = this.connections.get(guildId);
    if (connection) {
      connection.destroy();
      this.connections.delete(guildId);
    }

    // Unregister from VoiceConnectionManager if available
    if (this.botId && this.service.voiceConnectionManager) {
      this.service.voiceConnectionManager.unregisterConnection(
        this.botId,
        guildId,
        channel.id
      );
    }

    // Stop monitoring all members in this channel
    for (const [memberId, monitorInfo] of this.activeMonitors) {
      if (
        monitorInfo.channel.id === channel.id &&
        memberId !== this.client?.user?.id
      ) {
        this.stopMonitoringMember(memberId);
      }
    }

    this.runtime.logger.debug(
      {
        src: "plugin:discord:service:voice",
        agentId: this.agentIdentifier,
        channelId: channel.id,
        channelName: channel.name,
      },
      "Left voice channel",
    );
  }

  /**
   * Handle agent disconnect from a voice channel.
   * Attempts to reconnect if there's a desired channel state.
   * @param {string} guildId - The guild ID where disconnect occurred
   * @param {string} channelId - The channel ID that was left
   */
  /**
   * Update audio state (mute/deafen status) for a guild
   * @param guildId - Guild ID
   * @param voiceState - Current voice state
   */
  async updateAudioState(guildId: string, voiceState: VoiceState): Promise<void> {
    const currentState = this.audioStates.get(guildId) || {
      serverMute: false,
      serverDeaf: false,
      selfMute: false,
      selfDeaf: false,
      lastUpdated: 0,
    };

    const newState = {
      serverMute: voiceState.serverMute || false,
      serverDeaf: voiceState.serverDeaf || false,
      selfMute: voiceState.selfMute || false,
      selfDeaf: voiceState.selfDeaf || false,
      lastUpdated: Date.now(),
    };

    // Log changes
    if (
      currentState.serverMute !== newState.serverMute ||
      currentState.serverDeaf !== newState.serverDeaf ||
      currentState.selfMute !== newState.selfMute ||
      currentState.selfDeaf !== newState.selfDeaf
    ) {
      logger.debug(
        `[AudioState] Guild ${guildId}: serverMute=${newState.serverMute}, serverDeaf=${newState.serverDeaf}, selfMute=${newState.selfMute}, selfDeaf=${newState.selfDeaf}`
      );
    }

    this.audioStates.set(guildId, newState);
  }

  /**
   * Get current audio state for a guild
   * @param guildId - Guild ID
   * @returns Audio state or null if not in voice
   */
  getAudioState(guildId: string): {
    serverMute: boolean;
    serverDeaf: boolean;
    selfMute: boolean;
    selfDeaf: boolean;
    lastUpdated: number;
  } | null {
    return this.audioStates.get(guildId) || null;
  }

  async handleAgentDisconnect(guildId: string, channelId: string): Promise<void> {
    logger.log(`[Voice] Handling agent disconnect from channel ${channelId} in guild ${guildId}`);

    // Clean up ducking state when bot disconnects
    const duckState = this.duckedGuilds.get(guildId);
    if (duckState) {
      if (duckState.silenceTimer) {
        clearTimeout(duckState.silenceTimer);
      }
      if (duckState.rampTimer) {
        clearTimeout(duckState.rampTimer as any);
      }
      this.duckedGuilds.delete(guildId);
      this.runtime.logger.debug(`[VoiceDucking] Cleaned up ducking state for guild ${guildId} (bot disconnected)`);
    }

    // Clean up audio state when bot disconnects
    this.audioStates.delete(guildId);

    // Clean up connection tracking
    this.connections.delete(guildId);

    // Check if we have a desired channel state to restore
    const desiredChannelId = this.desiredChannels.get(guildId);

    if (desiredChannelId && desiredChannelId === channelId) {
      // This was an unexpected disconnect, attempt to reconnect
      logger.log(
        `[Voice] Unexpected disconnect detected. Attempting to reconnect to desired channel ${desiredChannelId} in guild ${guildId}`
      );

      // Clear any existing reconnect timeout
      const existingTimeout = this.reconnectTimeouts.get(guildId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      // Schedule reconnect attempt after a short delay
      const reconnectTimeout = setTimeout(async () => {
        try {
          await this.reconnectToDesiredChannel(guildId, desiredChannelId);
        } catch (error) {
          logger.error(
            `[Voice] Failed to reconnect to channel ${desiredChannelId} in guild ${guildId}: ${error}`
          );
          // Retry once more after a longer delay
          const retryTimeout = setTimeout(async () => {
            try {
              await this.reconnectToDesiredChannel(guildId, desiredChannelId);
            } catch (retryError) {
              logger.error(
                `[Voice] Reconnect retry failed for channel ${desiredChannelId} in guild ${guildId}: ${retryError}`
              );
              this.reconnectTimeouts.delete(guildId);
            }
          }, 10000); // 10 second retry
          this.reconnectTimeouts.set(guildId, retryTimeout);
        }
      }, 2000); // 2 second initial delay

      this.reconnectTimeouts.set(guildId, reconnectTimeout);
    } else {
      // No desired state or different channel, just log
      logger.log(
        `[Voice] Agent disconnected from channel ${channelId} in guild ${guildId}. No reconnect needed.`
      );
    }
  }

  /**
   * Handle agent connecting to a voice channel.
   * @param {string} guildId - The guild ID where connection occurred
   * @param {string} channelId - The channel ID that was joined
   */
  async handleAgentConnect(guildId: string, channelId: string): Promise<void> {
    logger.log(`[Voice] Agent connected to channel ${channelId} in guild ${guildId}`);

    // Clear any pending reconnect timeout since we're now connected
    const existingTimeout = this.reconnectTimeouts.get(guildId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.reconnectTimeouts.delete(guildId);
    }

    // Update desired state if not already set
    if (!this.desiredChannels.has(guildId)) {
      this.desiredChannels.set(guildId, channelId);
    }
  }

  /**
   * Handle agent moving between voice channels.
   * @param {string} guildId - The guild ID
   * @param {string} oldChannelId - The previous channel ID
   * @param {string} newChannelId - The new channel ID
   */
  async handleAgentChannelChange(
    guildId: string,
    oldChannelId: string,
    newChannelId: string
  ): Promise<void> {
    logger.log(
      `[Voice] Agent moved from channel ${oldChannelId} to ${newChannelId} in guild ${guildId}`
    );

    // Update desired state
    this.desiredChannels.set(guildId, newChannelId);

    // Clear any pending reconnect timeout
    const existingTimeout = this.reconnectTimeouts.get(guildId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.reconnectTimeouts.delete(guildId);
    }
  }

  /**
   * Attempt to reconnect to the desired channel.
   * @param {string} guildId - The guild ID
   * @param {string} channelId - The channel ID to reconnect to
   */
  private async reconnectToDesiredChannel(guildId: string, channelId: string): Promise<void> {
    if (!this.client) {
      throw new Error('Discord client not available');
    }

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      throw new Error(`Guild ${guildId} not found`);
    }

    const channel = await guild.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} not found in guild ${guildId}`);
    }

    if (!channel.isVoiceBased()) {
      throw new Error(`Channel ${channelId} is not a voice channel`);
    }

    logger.log(`[Voice] Reconnecting to channel ${channel.name} (${channelId}) in guild ${guildId}`);

    try {
      await this.joinChannel(channel as BaseGuildVoiceChannel);
      logger.log(`[Voice] Successfully reconnected to channel ${channel.name} (${channelId})`);
    } catch (error) {
      logger.error(
        `[Voice] Failed to reconnect to channel ${channelId}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Stop monitoring a specific member by their member ID.
   * @param {string} memberId - The ID of the member to stop monitoring.
   */
  stopMonitoringMember(memberId: string) {
    const monitorInfo = this.activeMonitors.get(memberId);
    if (monitorInfo) {
      monitorInfo.monitor.stop();
      this.activeMonitors.delete(memberId);
      this.streams.delete(memberId);
      this.monitoredUsers.delete(memberId);
      this.runtime.logger.debug(
        { src: 'plugin:discord:service:voice', agentId: this.agentIdentifier, memberId },
        'Stopped monitoring user'
      );
    } else {
      // Even if no monitor info, clean up tracking
      this.streams.delete(memberId);
      this.monitoredUsers.delete(memberId);
    }
  }

  /**
   * Asynchronously debounces the process transcription function to prevent rapid execution.
   *
   * @param {UUID} entityId - The ID of the entity related to the transcription.
   * @param {string} name - The name of the entity for transcription.
   * @param {string} userName - The username of the user initiating the transcription.
   * @param {BaseGuildVoiceChannel} channel - The voice channel where the transcription is happening.
   */

  async debouncedProcessTranscription(
    entityId: UUID,
    name: string,
    userName: string,
    channel: BaseGuildVoiceChannel,
  ) {
    const DEBOUNCE_TRANSCRIPTION_THRESHOLD = 1500; // wait for 1.5 seconds of silence

    if (this.activeAudioPlayer?.state?.status === "idle") {
      this.runtime.logger.debug(
        { src: "plugin:discord:service:voice", agentId: this.agentIdentifier },
        "Cleaning up idle audio player",
      );
      this.cleanupAudioPlayer(this.activeAudioPlayer);
    }

    if (this.activeAudioPlayer || this.processingVoice) {
      const state = this.userStates.get(entityId);
      if (state) {
        state.buffers.length = 0;
        state.totalLength = 0;
      }
      return;
    }

    if (this.transcriptionTimeout) {
      clearTimeout(this.transcriptionTimeout);
    }

    this.transcriptionTimeout = setTimeout(async () => {
      this.processingVoice = true;
      try {
        await this.processTranscription(
          entityId,
          channel.id,
          channel,
          name,
          userName,
        );

        // Clean all users' previous buffers
        this.userStates.forEach((state, _) => {
          state.buffers.length = 0;
          state.totalLength = 0;
        });
      } finally {
        this.processingVoice = false;
      }
    }, DEBOUNCE_TRANSCRIPTION_THRESHOLD);
  }

  /**
   * Handle user audio stream for monitoring purposes.
   *
   * @param {UUID} userId - The unique identifier of the user.
   * @param {string} name - The name of the user.
   * @param {string} userName - The username of the user.
   * @param {BaseGuildVoiceChannel} channel - The voice channel the user is in.
   * @param {Readable} audioStream - The audio stream to monitor.
   */
  async handleUserStream(
    entityId: UUID,
    name: string,
    userName: string,
    channel: BaseGuildVoiceChannel,
    audioStream: Readable,
  ) {
    this.runtime.logger.debug(
      {
        src: "plugin:discord:service:voice",
        agentId: this.agentIdentifier,
        entityId,
      },
      "Starting audio monitor",
    );
    if (!this.userStates.has(entityId)) {
      this.userStates.set(entityId, {
        buffers: [],
        totalLength: 0,
        lastActive: Date.now(),
        transcriptionText: "",
      });
    }

    const state = this.userStates.get(entityId);

    const processBuffer = async (buffer: Buffer) => {
      try {
        state?.buffers.push(buffer);
        state!.totalLength += buffer.length;
        state!.lastActive = Date.now();
        this.debouncedProcessTranscription(entityId, name, userName, channel);
      } catch (error) {
        this.runtime.logger.error(
          {
            src: "plugin:discord:service:voice",
            agentId: this.agentIdentifier,
            entityId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error processing buffer",
        );
      }
    };

    new AudioMonitor(
      audioStream,
      10000000,
      () => {
        if (this.transcriptionTimeout) {
          clearTimeout(this.transcriptionTimeout);
        }
      },
      async (buffer) => {
        if (!buffer) {
          this.runtime.logger.error(
            {
              src: "plugin:discord:service:voice",
              agentId: this.agentIdentifier,
            },
            "Received empty buffer",
          );
          return;
        }
        await processBuffer(buffer);
      },
    );
  }

  /**
   * Process the transcription of audio data for a user.
   *
   * @param {UUID} entityId - The unique ID of the user entity.
   * @param {string} channelId - The ID of the channel where the transcription is taking place.
   * @param {BaseGuildVoiceChannel} channel - The voice channel where the user is speaking.
   * @param {string} name - The name of the user.
   * @param {string} userName - The username of the user.
   * @returns {Promise<void>}
   */
  private async processTranscription(
    entityId: UUID,
    channelId: string,
    channel: BaseGuildVoiceChannel,
    name: string,
    userName: string,
  ) {
    const state = this.userStates.get(entityId);
    if (!state || state.buffers.length === 0) return;

    // Minimum duration check: At 16kHz sample rate, 16-bit mono:
    // 1 second = 16000 samples * 2 bytes = 32000 bytes
    // Require at least 1.5 seconds of audio to avoid false positives from brief sounds
    const MIN_AUDIO_BYTES = 48000; // ~1.5 seconds
    const audioDurationMs = (state.totalLength / 32000) * 1000;

    if (state.totalLength < MIN_AUDIO_BYTES) {
      this.runtime.logger.debug(`[VoiceActivity] Skipping transcription - audio too short: ${audioDurationMs.toFixed(0)}ms (need ${(MIN_AUDIO_BYTES / 32000 * 1000).toFixed(0)}ms)`);
      state.buffers.length = 0;
      state.totalLength = 0;
      return;
    }

    try {
      const inputBuffer = Buffer.concat(state.buffers, state.totalLength);

      state.buffers.length = 0; // Clear the buffers
      state.totalLength = 0;
      // Convert Opus to WAV
      const wavBuffer = await this.convertOpusToWav(inputBuffer);
      this.runtime.logger.debug(
        { src: "plugin:discord:service:voice", agentId: this.agentIdentifier },
        "Starting transcription",
      );

      // Convert Buffer to File object for transcription API
      const audioBlob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });
      const audioFile = new File([audioBlob], 'voice.wav', { type: 'audio/wav' });

      const transcriptionText = await this.runtime.useModel(ModelType.TRANSCRIPTION, {
        audio: audioFile,
      });
      function isValidTranscription(text: string): boolean {
        if (!text || text.trim().length < 2) return false;
        const lowText = text.toLowerCase().trim();
        const trimmedLength = lowText.length;

        // For longer phrases (>= 10 chars), be more lenient - likely real speech
        if (trimmedLength >= 10) {
          // Only filter out obvious hallucinations for longer text
          if (lowText.includes('[blank_audio]')) return false;
          if (lowText.includes('subtitles by')) return false;
          if (lowText.includes('thank you for watching')) return false;
          if (lowText.includes('transcribed by')) return false;
          if (lowText.includes('copyright')) return false;
          // Filter out common noise-generated phrases
          if (lowText.includes('very low apparently')) return false;
          if (/^(very )?(low|high) apparently\.?$/i.test(lowText)) return false;

          // For longer text, only reject if alphanumeric ratio is very low (< 0.3)
          const alpha = lowText.replace(/[^a-z0-9]/g, '').length;
          if (alpha < lowText.length * 0.3) return false;

          return true; // Longer phrases are likely valid
        }

        // For shorter phrases (2-9 chars), be more strict
        // Filter out very short phrases (often noise/hallucinations)
        if (trimmedLength <= 6) return false;

        // Filter out common Whisper hallucinations
        if (lowText.includes('[blank_audio]')) return false;
        if (lowText.includes('subtitles by')) return false;
        if (lowText.includes('thank you for watching')) return false;
        if (lowText.includes('transcribed by')) return false;
        if (lowText.includes('copyright')) return false;
        // Filter out noise-generated phrases
        if (lowText.includes('very low apparently')) return false;
        if (lowText.includes('apparently')) return false; // Common Whisper noise hallucination
        if (lowText.startsWith('very low')) return false;

        // Filter out common short question words/phrases in various languages (often hallucinations)
        const shortQuestionPatterns = [
          /^o\s*que\??$/i,           // Portuguese "what?"
          /^que\s*es\??$/i,           // Spanish "what is?"
          /^qu[ée]\s*es\??$/i,        // Spanish/French "what is?"
          /^what\s*is\??$/i,         // English "what is?"
          /^what\s*the\??$/i,        // English "what the?"
          /^c[oô]mo\??$/i,           // Spanish "how?"
          /^como\??$/i,               // Portuguese "how?"
          /^wie\??$/i,                // German "how?"
          /^was\??$/i,                // German "what?"
          /^quoi\??$/i,               // French "what?"
        ];
        if (shortQuestionPatterns.some(pattern => pattern.test(lowText))) return false;

        // Filter out short pronouns and common words (often hallucinations)
        const shortWordPatterns = [
          /^eu\.?$/i,                 // Portuguese "I"
          /^tôi\.?$/i,                // Vietnamese "I/me"
          /^je\.?$/i,                 // French "I"
          /^ich\.?$/i,                // German "I"
          /^yo\.?$/i,                 // Spanish "I"
          /^wouaou!?$/i,              // French "wow!"
          /^wow!?$/i,                 // English "wow!"
          /^ah\.?$/i,                 // Common exclamation
          /^oh\.?$/i,                 // Common exclamation
          /^eh\.?$/i,                 // Common exclamation
        ];
        if (shortWordPatterns.some(pattern => pattern.test(lowText))) return false;

        // Filter out repetitive single characters (e.g. "a. a. a.")
        if (/^([a-z]\.?\s*){3,}$/.test(lowText)) return false;

        // For short phrases (7-9 chars), use stricter alphanumeric ratio
        const alpha = lowText.replace(/[^a-z0-9]/g, '').length;
        if (alpha < lowText.length * 0.5) return false;

        return true;
      }

      // Adaptive threshold adjustment
      if (!transcriptionText || !isValidTranscription(transcriptionText)) {
        // Noise detected - increase threshold
        const oldThreshold = this.duckingConfig.speakingThreshold;
        this.duckingConfig.speakingThreshold = Math.min(0.2, oldThreshold + 0.005);
        if (oldThreshold !== this.duckingConfig.speakingThreshold) {
          this.runtime.logger.debug(`[VoiceActivity] 🔇 Invalid transcription ("${transcriptionText}"), increasing threshold to ${this.duckingConfig.speakingThreshold.toFixed(3)}`);
        }
      } else {
        // Valid speech - slightly decrease threshold (if it was raised high)
        const oldThreshold = this.duckingConfig.speakingThreshold;
        this.duckingConfig.speakingThreshold = Math.max(0.05, oldThreshold - 0.001);
        state.transcriptionText += transcriptionText;

        if (oldThreshold !== this.duckingConfig.speakingThreshold) {
          this.runtime.logger.debug(`[VoiceActivity] 🗣️ Valid speech, adjusting threshold to ${this.duckingConfig.speakingThreshold.toFixed(3)}`);
        }
      }

      if (state.transcriptionText.length) {
        this.cleanupAudioPlayer(this.activeAudioPlayer);
        const finalText = state.transcriptionText;
        state.transcriptionText = '';

        // Always emit transcription event (follows messages.ts metadata pattern)
        this.runtime.emitEvent([DiscordEventTypes.VOICE_TRANSCRIPTION], {
          runtime: this.runtime,
          entityId: createUniqueUuid(this.runtime, entityId),
          roomId: createUniqueUuid(this.runtime, channelId),
          content: {
            text: finalText,
            source: 'discord',
            channelType: ChannelType.VOICE_GROUP,
          },
          metadata: {
            entityName: name,
            fromId: entityId,
            channelId: channelId,
            guildId: channel.guild.id,
            channelName: channel.name,
          },
          timestamp: Date.now(),
        });

        // Only generate response if not in listen-only mode
        // Use getDiscordSettings() for proper boolean parsing - raw getSetting() returns
        // strings, so "false" would be truthy and incorrectly skip response generation
        const settings = getDiscordSettings(this.runtime);
        if (!settings.voiceListenOnly) {
          await this.handleMessage(finalText, entityId, channelId, channel, name, userName);
        // Note: ensures robust boolean parsing to prevent truthy string issues in settings.
        }
      }
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          entityId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error transcribing audio",
      );
    }
  }

  /**
   * Handles a voice message received in a Discord channel.
   *
   * @param {string} message - The message content.
   * @param {UUID} entityId - The entity ID associated with the message.
   * @param {string} channelId - The ID of the Discord channel where the message was received.
   * @param {BaseGuildVoiceChannel} channel - The Discord channel where the message was received.
   * @param {string} name - The name associated with the message.
   * @param {string} userName - The user name associated with the message.
   * @returns {Promise<{text: string, actions: string[]}>} Object containing the resulting text and actions.
   */
  private async handleMessage(
    message: string,
    entityId: UUID,
    channelId: string,
    channel: BaseGuildVoiceChannel,
    name: string,
    userName: string,
  ) {
    try {
      if (!message || message.trim() === "" || message.length < 3) {
        return { text: "", actions: ["IGNORE"] };
      }

      const roomId = createUniqueUuid(this.runtime, channelId);
      const uniqueEntityId = createUniqueUuid(this.runtime, entityId);
      const type = await this.getChannelType(channel as Channel);

      await this.runtime.ensureConnection({
        entityId: uniqueEntityId,
        roomId,
        userName,
        name,
        source: "discord",
        channelId,
        // Convert Discord snowflake to UUID (see service.ts header for why stringToUuid not asUUID)
        messageServerId: stringToUuid(channel.guild.id),
        type,
        worldId: createUniqueUuid(this.runtime, channel.guild.id) as UUID,
        worldName: channel.guild.name,
      });

      const memory: Memory = {
        id: createUniqueUuid(
          this.runtime,
          `${channelId}-voice-message-${Date.now()}`,
        ),
        agentId: this.runtime.agentId,
        entityId: uniqueEntityId,
        roomId,
        content: {
          text: message,
          source: "discord",
          url: channel.url,
          name,
          userName,
          isVoiceMessage: true,
          channelType: type,
        },
        createdAt: Date.now(),
      };

      const callback: HandlerCallback = async (
        content: Content,
        _actionName?: string,
      ) => {
        try {
          // Skip interim progressive updates for voice - only speak final responses
          // 
          // Why skip interim: Progressive updates like "Thinking...", "Searching..."
          // are meant for visual text feedback, not TTS. Speaking every interim update
          // would be noisy and confusing. Users only want to hear the final response.
          // 
          // Why check isInterim: ProgressiveMessage sets metadata.progressiveUpdate.isInterim
          // for status updates. When isInterim=false (or no progressiveUpdate), it's a
          // final message that should be spoken.
          const progressiveUpdate = (content.metadata as any)?.progressiveUpdate;
          if (progressiveUpdate?.isInterim) {
            // Interim update - skip TTS but don't create memory either
            // The final message will be spoken when isInterim=false
            return [];
          }

          const responseMemory: Memory = {
            id: createUniqueUuid(
              this.runtime,
              `${memory.id}-voice-response-${Date.now()}`,
            ),
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            content: {
              ...content,
              name: this.runtime.character.name,
              inReplyTo: memory.id,
              isVoiceMessage: true,
              channelType: type,
            },
            roomId,
            createdAt: Date.now(),
          };

          if (responseMemory.content.text?.trim()) {
            await this.runtime.createMemory(responseMemory, "messages");

            if (content.text) {
              const responseStream = await this.runtime.useModel(
                ModelType.TEXT_TO_SPEECH,
                content.text,
              );
              if (responseStream) {
                let audioStream: Readable;
                if (Buffer.isBuffer(responseStream)) {
                  audioStream = Readable.from(responseStream, { objectMode: false });
                } else if (responseStream instanceof Readable) {
                  audioStream = responseStream;
                } else {
                  // playAudio() handles Web ReadableStream conversion internally
                  // For other types, try to wrap with Readable.from()
                  audioStream = responseStream as any;
                }
                // Use mix: true so TTS ducks music instead of stopping it
                await this.playAudio(audioStream, {
                  guildId: channel.guild.id,
                  channel: 0,
                  mix: true,
                });
              }
            }
          }

          return [responseMemory];
        } catch (error) {
          this.runtime.logger.error(
            {
              src: "plugin:discord:service:voice",
              agentId: this.agentIdentifier,
              error: error instanceof Error ? error.message : String(error),
            },
            "Error in voice message callback",
          );
          return [];
        }
      };

      // Process voice message - try messageService first (newer core), fall back to events (older core)
      const messageService = getMessageService(this.runtime);
      if (messageService) {
        this.runtime.logger.debug(
          { src: "plugin:discord:voice", agentId: this.agentIdentifier },
          "Using messageService API for voice",
        );
        await messageService.handleMessage(this.runtime, memory, callback);
      } else {
        this.runtime.logger.debug(
          { src: "plugin:discord:voice", agentId: this.agentIdentifier },
          "Using event-based handling for voice",
        );
        await this.runtime.emitEvent([EventType.VOICE_MESSAGE_RECEIVED], {
          runtime: this.runtime,
          message: memory,
          callback,
          source: "discord",
        });
      }
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error processing voice message",
      );
    }
  }

  /**
   * Asynchronously converts an Opus audio Buffer to a WAV audio Buffer.
   *
   * @param {Buffer} pcmBuffer - The Opus audio Buffer to convert to WAV.
   * @returns {Promise<Buffer>} A Promise that resolves with the converted WAV audio Buffer.
   */
  private async convertOpusToWav(pcmBuffer: Buffer): Promise<Buffer> {
    try {
      // Generate the WAV header
      const wavHeader = getWavHeader(pcmBuffer.length, DECODE_SAMPLE_RATE);

      // Concatenate the WAV header and PCM data
      const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

      return wavBuffer;
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error converting PCM to WAV",
      );
      throw error;
    }
  }

  /**
   * Scans the given Discord guild to select a suitable voice channel to join.
   *
   * @param {Guild} guild The Discord guild to scan for voice channels.
   */
  async scanGuild(guild: Guild) {
    let chosenChannel: BaseGuildVoiceChannel | null = null;

    try {
      const channelId = this.runtime.getSetting(
        "DISCORD_VOICE_CHANNEL_ID",
      ) as string;
      if (channelId) {
        const channel = await guild.channels.fetch(channelId);
        if (channel?.isVoiceBased()) {
          chosenChannel = channel as BaseGuildVoiceChannel;
        }
      }

      if (!chosenChannel) {
        const channels = (await guild.channels.fetch()).filter(
          (channel) => channel?.type === DiscordChannelType.GuildVoice,
        );
        for (const [, channel] of channels) {
          const voiceChannel = channel as BaseGuildVoiceChannel;
          if (
            voiceChannel.members.size > 0 &&
            (chosenChannel === null ||
              voiceChannel.members.size > chosenChannel.members.size)
          ) {
            chosenChannel = voiceChannel;
          }
        }
      }

      if (chosenChannel) {
        this.runtime.logger.debug(
          {
            src: "plugin:discord:service:voice",
            agentId: this.agentIdentifier,
            channelName: chosenChannel.name,
          },
          "Joining channel",
        );
        await this.joinChannel(chosenChannel);
      } else {
        this.runtime.logger.warn(
          {
            src: "plugin:discord:service:voice",
            agentId: this.agentIdentifier,
          },
          "No suitable voice channel found to join",
        );
      }
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error selecting or joining a voice channel",
      );
    }
  }

  /**
   * Register a new audio channel configuration
   * @param config - Channel configuration
   */
  registerChannel(config: AudioChannelConfig): void {
    this.channels.set(config.channel, config);
  }

  /**
   * Get channel configuration
   * @param channel - Channel number
   * @returns Channel configuration or undefined
   */
  private getChannelConfig(channel: number): AudioChannelConfig | undefined {
    return this.channels.get(channel);
  }

  /**
   * Get or create channel configuration (with defaults)
   * @param channel - Channel number
   * @returns Channel configuration with defaults
   */
  private getOrCreateChannelConfig(channel: number): AudioChannelConfig {
    const existing = this.channels.get(channel);
    if (existing) return existing;

    // Default config for unregistered channels
    const defaultConfig: AudioChannelConfig = {
      channel,
      priority: 25,
      canPause: false,
      interruptible: true,
      volume: 1.0,
    };
    this.channels.set(channel, defaultConfig);
    return defaultConfig;
  }

  /**
   * Play audio stream to a specific user's connection (legacy method)
   * @param entityId - User entity ID
   * @param audioStream - Audio stream to play
   */
  async playAudioStream(entityId: UUID, audioStream: Readable) {
    const connection = this.connections.get(entityId);
    if (connection == null) {
      this.runtime.logger.debug(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          entityId,
        },
        "No connection for user",
      );
      return;
    }

    const audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    connection.subscribe(audioPlayer);
    const resource = createAudioResource(audioStream, { inputType: StreamType.Arbitrary });
    audioPlayer.play(resource);

    audioPlayer.on("error", (err: any) => {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          error: err instanceof Error ? err.message : String(err),
        },
        "Audio player error",
      );
    });
  }

  /**
   * Handle priority-based interruption or ducking
   * @param guildId - Guild ID
   * @param newChannel - New channel being played
   * @param mix - Whether to mix (duck) instead of interrupt
   */
  private handleChannelPriority(
    guildId: string,
    newChannel: number,
    mix: boolean = false
  ): void {
    const newConfig = this.getChannelConfig(newChannel);
    if (!newConfig) return;

    // Find all active channels for this guild
    const activeChannels: Array<{ channel: number; config: AudioChannelConfig; state: ChannelPlayerState }> = [];
    for (const [, state] of this.channelPlayers.entries()) {
      if (state.guildId === guildId) {
        const config = this.getChannelConfig(state.channel);
        if (config) {
          activeChannels.push({ channel: state.channel, config, state });
        }
      }
    }

    // Sort by priority (highest first)
    activeChannels.sort((a, b) => b.config.priority - a.config.priority);

    for (const { channel, config, state } of activeChannels) {
      // Skip same channel
      if (channel === newChannel) continue;

      // If new channel has higher priority and old channel is interruptible
      if (newConfig.priority > config.priority && config.interruptible) {
        if (mix && config.duckVolume !== undefined && state.volumeTransformer) {
          // Duck volume instead of stopping
          const currentVolume = state.volumeTransformer.volume ?? 1.0;
          if (!state.originalVolume) {
            state.originalVolume = currentVolume;
          }
          state.duckedVolume = config.duckVolume;
          state.volumeTransformer.setVolume(config.duckVolume);
          this.runtime.logger.debug(`[VoiceDucking] Ducking channel ${channel} to ${config.duckVolume} (higher priority channel ${newChannel} playing)`);
          this.emit('audio:ducked', { guildId, channel, by: newChannel });
        } else {
          // Stop the lower priority channel
          this.stopChannelPlayer(guildId, channel);
          this.emit('audio:interrupted', { guildId, channel, by: newChannel });
        }
      }
    }
  }

  /**
   * Restore ducked channels when higher priority channel finishes
   * @param guildId - Guild ID
   * @param finishedChannel - Channel that finished
   */
  private restoreDuckedChannels(guildId: string, finishedChannel: number): void {
    const finishedConfig = this.getChannelConfig(finishedChannel);
    if (!finishedConfig) return;

    // Find all active channels for this guild
    for (const [, state] of this.channelPlayers.entries()) {
      if (state.guildId === guildId && state.duckedVolume !== undefined) {
        const config = this.getChannelConfig(state.channel);
        if (config && config.priority < finishedConfig.priority) {
          // Restore original volume
          if (state.originalVolume !== undefined && state.volumeTransformer) {
            state.volumeTransformer.setVolume(state.originalVolume);
            this.runtime.logger.debug(`[VoiceDucking] Restoring channel ${state.channel} volume to ${state.originalVolume} (higher priority channel ${finishedChannel} finished)`);
            state.originalVolume = undefined;
            state.duckedVolume = undefined;
            this.emit('audio:restored', { guildId, channel: state.channel });
          }
        }
      }
    }
  }

  /**
   * Stop and cleanup a channel player
   * @param guildId - Guild ID
   * @param channel - Channel number
   */
  private stopChannelPlayer(guildId: string, channel: number): void {
    const key = `${guildId}:${channel}`;
    const state = this.channelPlayers.get(key);
    if (!state) return;

    // Clean up ducking state if music channel (channel 1) is stopping
    if (channel === 1) {
      const duckState = this.duckedGuilds.get(guildId);
      if (duckState) {
        if (duckState.silenceTimer) {
          clearTimeout(duckState.silenceTimer);
        }
        if (duckState.rampTimer) {
          clearTimeout(duckState.rampTimer as any);
        }
        this.duckedGuilds.delete(guildId);
        this.runtime.logger.debug(`[VoiceDucking] Cleaned up ducking state for guild ${guildId} (music stopped)`);
      }
    }

    state.player.stop();
    state.player.removeAllListeners();
    if (state.abortController) {
      state.abortController.abort();
    }
    this.channelPlayers.delete(key);
  }

  /**
   * Get the first active connection's guildId, or throw if none exists
   * @returns guildId of first active connection
   */
  private getActiveGuildId(): string {
    for (const [guildId] of this.connections.entries()) {
      // Skip any non-guildId keys (shouldn't exist, but safety check)
      if (guildId.includes(':')) {
        continue;
      }
      return guildId;
    }
    throw new Error('No active voice connection found');
  }

  /**
   * Play an audio stream to a voice channel.
   * 
   * ## Stream Requirements (CRITICAL)
   * ⚠️ The audio stream MUST be clean and unmodified:
   * - NO event listeners attached (except 'error' for cleanup)
   * - NO resume() or other control methods called
   * - Stream should be in its natural paused state
   * 
   * ## Why This Matters
   * This method uses `demuxProbe` to detect the audio format (Opus, WebM, OGG, etc.).
   * The probe needs to read the stream headers to determine format. If event listeners
   * (especially 'readable' or 'data') are attached, the stream enters paused mode and
   * the probe cannot read the headers, causing playback to fail.
   * 
   * ## Supported Formats
   * - OGG Opus (native, best performance)
   * - WebM/Opus
   * - MP3
   * - Raw PCM
   * - Other formats detected by demuxProbe
   * 
   * ## Stream Flow
   * 1. demuxProbe reads stream headers to detect format
   * 2. Creates AudioResource with detected format
   * 3. AudioPlayer manages stream consumption and playback
   * 4. Stream data flows to Discord voice connection
   * 
   * @param audioStream - Clean, unmodified audio stream
   * @param options - Playback options
   * @param options.guildId - Discord guild (server) ID (defaults to active guild)
   * @param options.channel - Voice channel number (default: 0)
   * @param options.interrupt - Stop current audio to play this (default: true)
   * @param options.signal - AbortSignal to cancel playback
   * @param options.mix - Mix with current audio instead of replacing (default: false)
   * @returns PlaybackHandle for controlling playback
   * 
   * @example
   * ```typescript
   * // Create a clean file stream
   * const stream = createReadStream('audio.opus');
   * 
   * // Play directly - don't add listeners or call resume()
   * await voiceManager.playAudio(stream, {
   *   guildId: '123456789',
   *   channel: 1,
   *   interrupt: true
   * });
   * ```
   */
  async playAudio(
    audioStream: Readable,
    options?: {
      guildId?: string;
      channel?: number;
      interrupt?: boolean;
      signal?: AbortSignal;
      mix?: boolean;
    }
  ): Promise<PlaybackHandle> {
    const opts = options ?? {};
    const guildId = opts.guildId ?? this.getActiveGuildId();

    this.runtime.logger.debug(`[VoiceManager] playAudio called - guild: ${guildId}, channel: ${opts?.channel ?? 'default'}, interrupt: ${opts?.interrupt !== false}, mix: ${opts?.mix ?? false}`);
    this.runtime.logger.debug(`[VoiceManager] Stream readable: ${audioStream.readable}, destroyed: ${audioStream.destroyed}`);

    const channel = opts?.channel ?? 0; // Default to channel 0
    this.getOrCreateChannelConfig(channel); // Ensure channel is registered
    const connection = this.connections.get(guildId);

    if (!connection) {
      this.runtime.logger.error(`[VoiceManager] No voice connection found for guild ${guildId}`);
      throw new Error(`No voice connection for guild ${guildId}`);
    }

    this.runtime.logger.debug(`[VoiceManager] Voice connection found - state: ${connection.state.status}`);

    const key = `${guildId}:${channel}`;

    // Stop existing playback on same channel if interrupt is true (default)
    if (opts?.interrupt !== false) {
      const existing = this.channelPlayers.get(key);
      if (existing) {
        this.runtime.logger.debug(`[VoiceManager] Stopping existing player on channel ${channel}`);
        this.stopChannelPlayer(guildId, channel);
      }
    }

    // Handle priority-based interruption or ducking
    const mix = opts?.mix ?? false;
    this.handleChannelPriority(guildId, channel, mix);

    // Create abort controller
    const abortController = new AbortController();
    if (opts?.signal) {
      // If signal is already aborted, abort immediately
      if (opts.signal.aborted) {
        abortController.abort();
      } else {
        // Listen for abort on the provided signal
        opts.signal.addEventListener('abort', () => {
          abortController.abort();
        });
      }
    }

    // Create audio player
    this.runtime.logger.debug(`[VoiceManager] Creating audio player for channel ${channel}`);
    const audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    // === WEB READABLESTREAM CONVERSION ===
    // Handle Web ReadableStream (e.g., from fetch().body in OpenAI TTS)
    // Web ReadableStream is NOT a Node.js Readable - must convert properly
    if (typeof (audioStream as any)?.getReader === 'function' && typeof (audioStream as any)?.on !== 'function') {
      this.runtime.logger.debug(`[VoiceManager] Converting Web ReadableStream to Node.js Readable`);
      const webStream = audioStream as unknown as ReadableStream<Uint8Array>;

      // Use Readable.fromWeb() for streaming conversion without buffering
      // This avoids OOM for large audio files by not loading everything into memory
      // Readable.fromWeb is available in Node.js 18+ and Bun
      if (typeof Readable.fromWeb === 'function') {
        audioStream = Readable.fromWeb(webStream as any) as Readable;
        this.runtime.logger.debug(`[VoiceManager] Converted Web ReadableStream using Readable.fromWeb (streaming)`);
      } else {
        // Fallback for older runtimes: buffer the entire stream
        // This is less memory-efficient but ensures compatibility
        this.runtime.logger.warn(`[VoiceManager] Readable.fromWeb not available, falling back to buffered conversion`);
        const reader = webStream.getReader();
        const chunks: Uint8Array[] = [];

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }

        const buffer = Buffer.concat(chunks);
        this.runtime.logger.debug(`[VoiceManager] Converted Web ReadableStream to buffer: ${buffer.length} bytes`);
        audioStream = Readable.from(buffer, { objectMode: false });
      }
    }

    // === STREAM VALIDATION ===
    // Validate that the stream is a proper Node.js Readable stream
    if (!audioStream || typeof audioStream.on !== 'function' || typeof audioStream.once !== 'function') {
      throw new Error(
        `Invalid audio stream: expected Node.js Readable stream, got ${typeof audioStream}. Stream must have .on() and .once() methods.`
      );
    }

    // === STREAM FORMAT DETECTION ===
    // Probe stream type for better timing accuracy and optimal decoding
    // This is especially important for Opus/WebM formats which are native to Discord
    //
    // demuxProbe reads the stream headers to detect format. It returns:
    // - probe.stream: A new readable stream starting from the beginning
    // - probe.type: The detected StreamType (OggOpus, WebmOpus, Arbitrary, etc.)
    //
    // CRITICAL: This is why the input stream must be clean (no event listeners)
    // If listeners are attached, the stream is in paused mode and demuxProbe
    // cannot read the headers, causing it to fail.
    let resourceStream: Readable = audioStream;
    let inputType = StreamType.Arbitrary;
    try {
      this.runtime.logger.debug(`[VoiceManager] Probing stream type...`);
      const probe = await demuxProbe(audioStream);
      resourceStream = probe.stream;
      inputType = probe.type;
      this.runtime.logger.debug(`[VoiceManager] Stream probe successful - type: ${inputType}`);
    } catch (error) {
      // Probe failed - this usually happens when:
      // 1. Stream has event listeners attached (puts it in paused mode)
      // 2. Stream format is not recognized
      // 3. Stream is already consumed or ended
      // 4. Stream is not a proper Node.js stream
      logger.debug(
        `[VoiceManager] demuxProbe failed for guild ${guildId}, channel ${channel}: ${error instanceof Error ? error.message : String(error)}`
      );
      this.runtime.logger.debug(`[VoiceManager] Using arbitrary stream type as fallback`);

      // Validate that the fallback stream is still valid
      if (!resourceStream || typeof resourceStream.on !== 'function') {
        throw new Error(
          `Stream became invalid after demuxProbe failure. Original error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // === AUDIO RESOURCE CREATION ===
    // Create an AudioResource from the probed stream
    // The AudioResource wraps the stream and manages:
    // - Format-specific decoding (Opus, WebM, etc.)
    // - Audio packet generation for Discord
    // - Stream lifecycle (start, end, errors)
    //
    // Note: Volume control is handled via AudioResource.volume when inlineVolume is enabled
    this.runtime.logger.debug(`[VoiceManager] Creating audio resource with inputType: ${inputType}`);
    this.runtime.logger.debug(`[VoiceManager] Resource stream readable: ${resourceStream.readable}, destroyed: ${resourceStream.destroyed}`);

    const resource = createAudioResource(resourceStream, {
      inputType, // Detected format (OggOpus, WebmOpus, Arbitrary, etc.)
      inlineVolume: true, // Enable runtime volume control
    });

    // === STREAM MONITORING ===
    // Track resource stream events for debugging and diagnostics
    // These listeners are safe because they're added AFTER demuxProbe has already
    // read the stream headers and created a new stream (resourceStream).
    // Only add listeners if the stream supports them (it should, but validate to be safe)
    let resourceBytesReceived = 0;
    if (resourceStream && typeof resourceStream.on === 'function') {
      resourceStream.on('data', (chunk) => {
        if (resourceBytesReceived === 0) {
          this.runtime.logger.debug(`[VoiceManager] Resource stream first data: ${chunk.length} bytes`);
        }
        resourceBytesReceived += chunk.length;
      });

      resourceStream.on('end', () => {
        this.runtime.logger.debug(`[VoiceManager] Resource stream ended (${resourceBytesReceived} bytes total)`);
      });

      resourceStream.on('error', (err) => {
        this.runtime.logger.error(`[VoiceManager] Resource stream error: ${err.message}`);
      });
    } else {
      this.runtime.logger.warn(`[VoiceManager] Resource stream does not support event listeners, skipping monitoring`);
    }

    // === PLAYER SUBSCRIPTION ===
    // Subscribe the player to the voice connection
    // This connects the audio pipeline: AudioResource → AudioPlayer → VoiceConnection → Discord
    this.runtime.logger.debug(`[VoiceManager] Subscribing player to voice connection`);
    const subscription = connection.subscribe(audioPlayer);
    if (!subscription) {
      this.runtime.logger.error(`[VoiceManager] Failed to subscribe player to connection!`);
      throw new Error('Failed to subscribe audio player to voice connection');
    }
    this.runtime.logger.debug(`[VoiceManager] Player subscribed successfully`);

    // === START PLAYBACK ===
    // Begin playing the audio resource
    // The player will now:
    // 1. Read audio data from the resource stream
    // 2. Decode it according to the detected format
    // 3. Send audio packets to Discord at the correct rate (20ms intervals)
    this.runtime.logger.debug(`[VoiceManager] Starting playback...`);
    const audioStartTime = Date.now();
    audioPlayer.play(resource);
    this.runtime.logger.info(`[VoiceManager] ✅ Audio playback started on guild ${guildId}, channel ${channel}`);


    // Create promise resolvers
    let finishedResolver: () => void;
    let cancelledResolver: () => void;
    const finishedPromise = new Promise<void>((resolve) => {
      finishedResolver = resolve;
    });
    const cancelledPromise = new Promise<void>((resolve) => {
      cancelledResolver = resolve;
    });

    // Store state
    const state: ChannelPlayerState = {
      player: audioPlayer,
      channel,
      guildId,
      resource,
      finished: finishedResolver!,
      cancelled: cancelledResolver!,
      abortController,
      volumeTransformer: resource.volume, // Store volume transformer for runtime control
    };
    this.channelPlayers.set(key, state);

    // Handle abort signal
    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => {
        this.stopChannelPlayer(guildId, channel);
        cancelledResolver!();
      });
    }

    // Handle player events
    audioPlayer.on('error', (err: any) => {
      this.runtime.logger.error(`[VoiceManager] Audio player error on guild ${guildId}, channel ${channel}: ${err.message || err}`);
      this.runtime.logger.error(`[VoiceManager] Error details: ${JSON.stringify({ name: err.name, message: err.message, resource: err.resource })}`);
      this.stopChannelPlayer(guildId, channel);
      this.emit('audio:error', { guildId, channel, error: err });
      cancelledResolver!();
    });

    audioPlayer.on('stateChange', (oldState: any, newState: { status: string }) => {
      // Only log when state actually changes
      if (oldState.status !== newState.status) {
        this.runtime.logger.debug(`[VoiceManager] Player state change on guild ${guildId}, channel ${channel}: ${oldState.status} -> ${newState.status}`);
      }
      if (newState.status === 'idle') {
        const idleTime = Date.now();
        this.runtime.logger.debug({ src: 'plugin:discord:service:voice', agentId: this.agentIdentifier, durationMs: idleTime - audioStartTime }, 'Audio playback completed');
        // Restore ducked channels
        this.restoreDuckedChannels(guildId, channel);

        // Cleanup
        this.stopChannelPlayer(guildId, channel);

        // Resolve promises and emit events
        finishedResolver!();
        this.emit('audio:finished', { guildId, channel });
      } else if (newState.status === 'playing') {
        this.runtime.logger.debug(`[VoiceManager] Audio is now playing on guild ${guildId}, channel ${channel}`);
      } else if (newState.status === 'paused') {
        this.runtime.logger.debug(`[VoiceManager] Audio is now paused on guild ${guildId}, channel ${channel}`);
      } else if (newState.status === 'buffering') {
        this.runtime.logger.debug(`[VoiceManager] Audio is buffering on guild ${guildId}, channel ${channel}`);
      }
    });

    // Emit started event
    this.runtime.logger.debug(`[VoiceManager] Emitting audio:started event`);
    this.emit('audio:started', { guildId, channel });

    return {
      finished: finishedPromise,
      cancelled: cancelledPromise,
      abort: () => {
        abortController.abort();
        this.stopChannelPlayer(guildId, channel);
        cancelledResolver!();
      },
    };
  }

  /**
   * Stop audio playback
   * @param guildId - Guild ID
   * @param channel - Channel number (optional, stops all if not provided)
   */
  async stopAudio(guildId: string, channel?: number): Promise<void> {
    if (channel !== undefined) {
      this.stopChannelPlayer(guildId, channel);
      this.emit('audio:stopped', { guildId, channel });
    } else {
      // Stop all channels for this guild
      for (const [, state] of this.channelPlayers.entries()) {
        if (state.guildId === guildId) {
          const channelToEmit = state.channel;
          this.stopChannelPlayer(guildId, state.channel);
          this.emit('audio:stopped', { guildId, channel: channelToEmit });
        }
      }
    }
  }

  /**
   * Pause audio playback (only if channel supports it)
   * @param guildId - Guild ID
   * @param channel - Channel number
   */
  async pauseAudio(guildId: string, channel: number): Promise<void> {
    const config = this.getChannelConfig(channel);
    if (!config || !config.canPause) {
      throw new Error(`Channel ${channel} does not support pause`);
    }

    const key = `${guildId}:${channel}`;
    const state = this.channelPlayers.get(key);
    if (!state) {
      // Instead of throwing, just log and return gracefully
      this.runtime.logger.debug(`No active playback to pause on channel ${channel} for guild ${guildId}`);
      return;
    }

    if (state.player.state.status === 'playing') {
      state.player.pause();
      this.emit('audio:paused', { guildId, channel });
      this.runtime.logger.debug(`Paused playback on channel ${channel} for guild ${guildId}`);
    }
  }

  /**
   * Resume audio playback (only if channel supports it)
   * @param guildId - Guild ID
   * @param channel - Channel number
   */
  async resumeAudio(guildId: string, channel: number): Promise<void> {
    const config = this.getChannelConfig(channel);
    if (!config || !config.canPause) {
      throw new Error(`Channel ${channel} does not support resume`);
    }

    const key = `${guildId}:${channel}`;
    const state = this.channelPlayers.get(key);
    if (!state) {
      // Instead of throwing, just log and return gracefully
      this.runtime.logger.debug(`No active playback to resume on channel ${channel} for guild ${guildId}`);
      return;
    }

    if (state.player.state.status === 'paused' || state.player.state.status === 'autopaused') {
      // Ensure connection is subscribed to this player
      const connection = this.connections.get(guildId);
      if (connection) {
        connection.subscribe(state.player);
      }

      state.player.unpause();
      this.emit('audio:resumed', { guildId, channel });
      this.runtime.logger.debug(`Resumed playback on channel ${channel} for guild ${guildId}`);
    }
  }

  /**
   * Resume all autopaused players for a guild after voice connection is restored
   * This handles network hiccups where players autopause due to connection loss
   * @param guildId - Guild ID
   * @param connection - The restored voice connection
   */
  private async resumeAutopausedPlayers(guildId: string, connection: VoiceConnection): Promise<void> {
    let resumedCount = 0;

    for (const [key, state] of this.channelPlayers.entries()) {
      // Check if this player belongs to the guild
      if (!key.startsWith(`${guildId}:`)) continue;

      const playerStatus = state.player.state.status;
      if (playerStatus === 'autopaused') {
        logger.log(`[Voice] Found autopaused player for guild ${guildId}, resuming...`);

        // Re-subscribe the connection to the player
        connection.subscribe(state.player);

        // Unpause the player
        state.player.unpause();
        resumedCount++;

        // Extract channel number from key
        const channel = parseInt(key.split(':')[1], 10);
        this.emit('audio:resumed', { guildId, channel });
      }
    }

    if (resumedCount > 0) {
      this.runtime.logger.info(`[Voice] Resumed ${resumedCount} autopaused player(s) for guild ${guildId} after reconnection`);
    } else {
      this.runtime.logger.debug(`[Voice] No autopaused players found for guild ${guildId}`);
    }
  }

  /**
   * Set volume for a channel
   * @param guildId - Guild ID
   * @param channel - Channel number
   * @param volume - Volume (0.0 to 1.0)
   */
  async setVolume(guildId: string, channel: number, volume: number): Promise<void> {
    if (volume < 0 || volume > 1) {
      throw new Error('Volume must be between 0.0 and 1.0');
    }

    const key = `${guildId}:${channel}`;
    const state = this.channelPlayers.get(key);
    if (state) {
      // Use volume transformer if available (inlineVolume enabled)
      if (state.volumeTransformer) {
        state.volumeTransformer.setVolume(volume);
      }
      state.originalVolume = volume;
    }

    // Update channel config
    const config = this.getChannelConfig(channel);
    if (config) {
      config.volume = volume;
    }
  }

  /**
   * Duck music volume when voice activity is detected
   * @param guildId - Guild ID
   */
  private duckMusicVolume(guildId: string): void {
    const MUSIC_CHANNEL = 1;
    const key = `${guildId}:${MUSIC_CHANNEL}`;
    const state = this.channelPlayers.get(key);

    // Only duck if music is playing
    if (!state || !state.volumeTransformer) {
      return;
    }

    // Get or create ducking state
    let duckState = this.duckedGuilds.get(guildId);
    const wasAlreadyDucked = !!duckState;

    if (!duckState) {
      // Store original volume before ducking
      const currentVolume = state.volumeTransformer.volume ?? 1.0;
      duckState = {
        originalVolume: currentVolume,
        silenceTimer: null,
        rampTimer: null,
      };
      this.duckedGuilds.set(guildId, duckState);
      // Log when ducking is first activated (not on every voice packet)
      this.runtime.logger.info(`[VoiceDucking] 🔉 Ducking ON - Music volume ${(currentVolume * 100).toFixed(0)}% → ${(this.duckingConfig.duckVolume * 100).toFixed(0)}% (voice activity detected)`);
    }

    // Cancel any existing silence timer or ramp timer
    if (duckState.silenceTimer) {
      clearTimeout(duckState.silenceTimer);
      duckState.silenceTimer = null;
    }
    if (duckState.rampTimer) {
      clearTimeout(duckState.rampTimer);
      duckState.rampTimer = null;
      if (wasAlreadyDucked) {
        this.runtime.logger.debug(`[VoiceDucking] Cancelled volume restoration - voice activity continues`);
      }
    }

    // Immediately duck to configured volume
    state.volumeTransformer.setVolume(this.duckingConfig.duckVolume);

    // Start silence timer
    this.startSilenceTimer(guildId);
  }

  /**
   * Start or reset silence timer for volume restoration
   * @param guildId - Guild ID
   */
  private startSilenceTimer(guildId: string): void {
    const duckState = this.duckedGuilds.get(guildId);
    if (!duckState) {
      return;
    }

    // Clear existing timer
    if (duckState.silenceTimer) {
      clearTimeout(duckState.silenceTimer);
    }

    // Start new timer
    duckState.silenceTimer = setTimeout(() => {
      duckState!.silenceTimer = null;
      this.restoreVolumeGradually(guildId);
    }, this.duckingConfig.silenceTimeout);

    logger.debug(
      `[VoiceDucking] Silence timer started - will restore volume in ${(this.duckingConfig.silenceTimeout / 1000).toFixed(1)}s if no voice activity`
    );
  }

  /**
   * Gradually restore volume to original level
   * @param guildId - Guild ID
   */
  private restoreVolumeGradually(guildId: string): void {
    const MUSIC_CHANNEL = 1;
    const key = `${guildId}:${MUSIC_CHANNEL}`;
    const state = this.channelPlayers.get(key);
    const duckState = this.duckedGuilds.get(guildId);

    if (!state || !state.volumeTransformer || !duckState) {
      // Clean up if music is no longer playing
      this.duckedGuilds.delete(guildId);
      return;
    }

    const targetVolume = duckState.originalVolume;
    const currentVolume = state.volumeTransformer.volume ?? this.duckingConfig.duckVolume;
    const volumeDiff = targetVolume - currentVolume;

    this.runtime.logger.info(`[VoiceDucking] 🔊 Ducking OFF - Restoring volume ${(currentVolume * 100).toFixed(0)}% → ${(targetVolume * 100).toFixed(0)}% (silence detected)`);

    if (Math.abs(volumeDiff) < 0.01) {
      // Already at target, cleanup
      state.volumeTransformer.setVolume(targetVolume);
      this.duckedGuilds.delete(guildId);
      this.runtime.logger.debug(`[VoiceDucking] Volume already at target ${(targetVolume * 100).toFixed(0)}%`);
      return;
    }

    // Calculate ramp steps (update every 50ms for smooth transition)
    const stepInterval = 50;
    const totalSteps = Math.ceil(this.duckingConfig.rampDuration / stepInterval);
    const volumeStep = volumeDiff / totalSteps;

    this.runtime.logger.debug(`[VoiceDucking] Ramping volume over ${this.duckingConfig.rampDuration}ms (${totalSteps} steps)`);

    let currentStep = 0;
    const rampInterval = setInterval(() => {
      currentStep++;
      const newVolume = Math.min(
        targetVolume,
        currentVolume + volumeStep * currentStep
      );

      if (state.volumeTransformer) {
        state.volumeTransformer.setVolume(newVolume);
      }

      if (currentStep >= totalSteps || Math.abs(newVolume - targetVolume) < 0.01) {
        clearInterval(rampInterval);
        if (state.volumeTransformer) {
          state.volumeTransformer.setVolume(targetVolume);
        }
        this.duckedGuilds.delete(guildId);
        this.runtime.logger.debug(`[VoiceDucking] Volume ramp complete - now at ${(targetVolume * 100).toFixed(0)}%`);
      }
    }, stepInterval);

    // Store ramp timer for cleanup if needed
    duckState.rampTimer = rampInterval as any;
  }

  /**
   * Check if audio is playing
   * @param guildId - Guild ID
   * @param channel - Channel number (optional, checks all if not provided)
   * @returns True if playing
   */
  async isPlaying(guildId: string, channel?: number): Promise<boolean> {
    if (channel !== undefined) {
      const key = `${guildId}:${channel}`;
      const state = this.channelPlayers.get(key);
      return state !== undefined && state.player.state.status !== 'idle';
    } else {
      // Check if any channel is playing
      for (const [, state] of this.channelPlayers.entries()) {
        if (state.guildId === guildId && state.player.state.status !== 'idle') {
          return true;
        }
      }
      return false;
    }
  }

  /**
   * Get active channels for a guild
   * @param guildId - Guild ID
   * @returns Array of active channel numbers
   */
  async getActiveChannels(guildId: string): Promise<number[]> {
    const active: number[] = [];
    for (const [, state] of this.channelPlayers.entries()) {
      if (state.guildId === guildId && state.player.state.status !== 'idle') {
        active.push(state.channel);
      }
    }
    return active;
  }


  /**
   * Cleans up the provided audio player by stopping it, removing all listeners,
   * and resetting the active audio player if it matches the provided player.
   *
   * @param {AudioPlayer} audioPlayer - The audio player to be cleaned up.
   */
  cleanupAudioPlayer(audioPlayer: AudioPlayer | null) {
    if (!audioPlayer) {
      return;
    }

    audioPlayer.stop();
    audioPlayer.removeAllListeners();
    if (audioPlayer === this.activeAudioPlayer) {
      this.activeAudioPlayer = null;
    }
  }

  /**
   * Asynchronously handles the join channel command in an interaction.
   *
   * @param {any} interaction - The interaction object representing the user's input.
   * @returns {Promise<void>} - A promise that resolves once the join channel command is handled.
   */
  async handleJoinChannelCommand(interaction: any) {
    try {
      // Defer the reply immediately to prevent interaction timeout
      await interaction.deferReply();

      const channelId = interaction.options.get("channel")?.value as string;
      if (!channelId) {
        await interaction.editReply("Please provide a voice channel to join.");
        return;
      }

      const guild = interaction.guild;
      if (!guild) {
        await interaction.editReply("Could not find guild.");
        return;
      }

      const voiceChannel = interaction.guild.channels.cache.find(
        (channel: VoiceChannel) =>
          channel.id === channelId &&
          channel.type === DiscordChannelType.GuildVoice,
      );

      if (!voiceChannel) {
        await interaction.editReply("Voice channel not found!");
        return;
      }

      await this.joinChannel(voiceChannel as BaseGuildVoiceChannel);
      await interaction.editReply(`Joined voice channel: ${voiceChannel.name}`);
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error joining voice channel",
      );
      // Use editReply instead of reply for the error case
      await interaction
        .editReply("Failed to join the voice channel.")
        .catch((err: Error) => {
          this.runtime.logger.error(
            {
              src: "plugin:discord:service:voice",
              agentId: this.agentIdentifier,
              error: err.message,
            },
            "Failed to send error reply",
          );
        });
    }
  }

  /**
   * Handles the leave channel command by destroying the voice connection if it exists.
   *
   * @param {any} interaction The interaction object representing the command invocation.
   * @returns {void}
   */
  async handleLeaveChannelCommand(interaction: any) {
    const connection = this.getVoiceConnection(interaction.guildId as any);

    if (!connection) {
      await interaction.reply("Not currently in a voice channel.");
      return;
    }

    try {
      connection.destroy();
      await interaction.reply("Left the voice channel.");
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.agentIdentifier,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error leaving voice channel",
      );
      await interaction.reply("Failed to leave the voice channel.");
    }
  }

  // ============================================================================
  // TELEPHONE BRIDGE POC - Audio bridging between voice connections
  // ============================================================================

  /**
   * Active audio bridges for telephone functionality
   * Key: bridgeId, Value: cleanup function
   */
  private activeBridges: Map<string, () => void> = new Map();

  /**
   * Bridge audio from one guild's voice connection to another.
   * This is a proof-of-concept for the telephone booth feature.
   *
   * @param sourceGuildId - Guild ID to capture audio from
   * @param targetGuildId - Guild ID to play audio to
   * @param userId - User ID to capture audio from (or 'all' for all users)
   * @returns Bridge ID for cleanup, or null if bridging failed
   */
  async bridgeAudio(
    sourceGuildId: string,
    targetGuildId: string,
    userId?: string
  ): Promise<string | null> {
    const sourceConn = this.connections.get(sourceGuildId);
    const targetConn = this.connections.get(targetGuildId);

    if (!sourceConn) {
      this.runtime.logger.error(`[BridgeAudio] No source connection for guild ${sourceGuildId}`);
      return null;
    }

    if (!targetConn) {
      this.runtime.logger.error(`[BridgeAudio] No target connection for guild ${targetGuildId}`);
      return null;
    }

    const bridgeId = `bridge-${sourceGuildId}-${targetGuildId}-${Date.now()}`;
    this.runtime.logger.info(`[BridgeAudio] Creating bridge ${bridgeId}`);

    try {
      // Create audio player for the target connection
      const player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Play,
        },
      });

      // Subscribe target connection to the player
      targetConn.subscribe(player);

      // Track active user streams for this bridge
      const userStreams: Map<string, { stream: AudioReceiveStream; cleanup: () => void }> = new Map();

      // Handler for when users start speaking
      const speakingStartHandler = (speakingUserId: string) => {
        // Skip if we're filtering to a specific user and this isn't them
        if (userId && userId !== 'all' && speakingUserId !== userId) {
          return;
        }

        // Skip if already streaming this user
        if (userStreams.has(speakingUserId)) {
          return;
        }

        // Skip bots
        const member = this.client?.guilds.cache.get(sourceGuildId)?.members.cache.get(speakingUserId);
        if (member?.user.bot) {
          return;
        }

        this.runtime.logger.debug(`[BridgeAudio] User ${speakingUserId} started speaking, bridging audio`);

        try {
          // Subscribe to user's audio stream
          const receiveStream = sourceConn.receiver.subscribe(speakingUserId, {
            autoDestroy: true,
            emitClose: true,
          });

          // Create audio resource from the Opus stream
          // Note: Discord receiver outputs Opus packets
          const resource = createAudioResource(receiveStream, {
            inputType: StreamType.Opus,
          });

          // Play to the target connection
          player.play(resource);

          // Track cleanup
          const cleanup = () => {
            receiveStream.destroy();
            userStreams.delete(speakingUserId);
          };

          receiveStream.on('close', cleanup);
          receiveStream.on('error', (err) => {
            this.runtime.logger.debug(`[BridgeAudio] Stream error for ${speakingUserId}: ${err.message}`);
            cleanup();
          });

          userStreams.set(speakingUserId, { stream: receiveStream, cleanup });
        } catch (error) {
          this.runtime.logger.error(`[BridgeAudio] Failed to subscribe to user ${speakingUserId}: ${error}`);
        }
      };

      // Listen for speaking events
      sourceConn.receiver.speaking.on('start', speakingStartHandler);

      // Cleanup function for the entire bridge
      const bridgeCleanup = () => {
        this.runtime.logger.info(`[BridgeAudio] Cleaning up bridge ${bridgeId}`);

        // Remove speaking listener
        sourceConn.receiver.speaking.off('start', speakingStartHandler);

        // Clean up all user streams
        for (const [, { cleanup }] of userStreams) {
          cleanup();
        }
        userStreams.clear();

        // Stop and clean up player
        player.stop();
        player.removeAllListeners();

        // Remove from active bridges
        this.activeBridges.delete(bridgeId);
      };

      this.activeBridges.set(bridgeId, bridgeCleanup);

      this.runtime.logger.info(`[BridgeAudio] Bridge ${bridgeId} created successfully`);
      return bridgeId;
    } catch (error) {
      this.runtime.logger.error(`[BridgeAudio] Failed to create bridge: ${error}`);
      return null;
    }
  }

  /**
   * Create a bidirectional audio bridge between two guilds.
   * Audio from guild A plays in guild B and vice versa.
   *
   * @param guildIdA - First guild ID
   * @param guildIdB - Second guild ID
   * @returns Object with bridge IDs and cleanup function, or null if failed
   */
  async bridgeBidirectional(
    guildIdA: string,
    guildIdB: string
  ): Promise<{ bridgeAtoB: string; bridgeBtoA: string; cleanup: () => void } | null> {
    this.runtime.logger.info(`[BridgeAudio] Creating bidirectional bridge between ${guildIdA} and ${guildIdB}`);

    // Create A → B bridge
    const bridgeAtoB = await this.bridgeAudio(guildIdA, guildIdB, 'all');
    if (!bridgeAtoB) {
      this.runtime.logger.error(`[BridgeAudio] Failed to create A→B bridge`);
      return null;
    }

    // Create B → A bridge
    const bridgeBtoA = await this.bridgeAudio(guildIdB, guildIdA, 'all');
    if (!bridgeBtoA) {
      this.runtime.logger.error(`[BridgeAudio] Failed to create B→A bridge, cleaning up A→B`);
      this.stopBridge(bridgeAtoB);
      return null;
    }

    // Combined cleanup
    const cleanup = () => {
      this.stopBridge(bridgeAtoB);
      this.stopBridge(bridgeBtoA);
    };

    this.runtime.logger.info(`[BridgeAudio] Bidirectional bridge created: ${bridgeAtoB} <-> ${bridgeBtoA}`);
    return { bridgeAtoB, bridgeBtoA, cleanup };
  }

  /**
   * Stop an active audio bridge.
   *
   * @param bridgeId - Bridge ID to stop
   */
  stopBridge(bridgeId: string): void {
    const cleanup = this.activeBridges.get(bridgeId);
    if (cleanup) {
      cleanup();
    } else {
      this.runtime.logger.warn(`[BridgeAudio] Bridge ${bridgeId} not found`);
    }
  }

  /**
   * Get list of active bridge IDs.
   */
  getActiveBridges(): string[] {
    return Array.from(this.activeBridges.keys());
  }
}
