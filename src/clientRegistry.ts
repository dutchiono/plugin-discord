import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { logger, type IAgentRuntime, EventType, createUniqueUuid, type World, Role } from '@elizaos/core';
import type { DiscordBotConfig } from './types';
import { VoiceManager } from './voice';
import type { DiscordService } from './service';
import { DiscordEventTypes } from './types';

/**
 * Information about a registered Discord bot client
 */
export interface BotClientInfo {
  client: Client;
  voiceManager: VoiceManager;
  config: DiscordBotConfig;
  botId?: string;  // Set after login
  username?: string;  // Set after login
}

/**
 * Validates Discord bot token format
 * @param token The Discord bot token to validate
 * @returns True if token appears to be valid format, false otherwise
 */
function validateDiscordToken(token: string): { valid: boolean; error?: string } {
  if (!token) {
    return { valid: false, error: 'Token is empty or undefined' };
  }

  const trimmedToken = token.trim();

  if (trimmedToken === '') {
    return { valid: false, error: 'Token is empty after trimming whitespace' };
  }

  if (trimmedToken === 'undefined' || trimmedToken === 'null') {
    return { valid: false, error: 'Token is literally "undefined" or "null" string' };
  }

  if (trimmedToken.length < 50) {
    return { valid: false, error: `Token is too short (${trimmedToken.length} characters). Discord tokens are typically 70+ characters` };
  }

  // Discord tokens typically have the format: base64.timestamp.signature (contains dots)
  if (!trimmedToken.includes('.')) {
    return { valid: false, error: 'Token does not contain expected dot separators. Discord tokens typically have format: base64.timestamp.signature' };
  }

  const parts = trimmedToken.split('.');
  if (parts.length < 3) {
    return { valid: false, error: `Token has ${parts.length} parts, expected at least 3 (base64.timestamp.signature)` };
  }

  // Check if parts are non-empty
  if (parts.some(part => part.trim() === '')) {
    return { valid: false, error: 'Token contains empty parts between dots' };
  }

  return { valid: true };
}

/**
 * Manages multiple Discord bot clients for multi-room voice support
 */
export class DiscordClientRegistry {
  private clients: Map<string, BotClientInfo> = new Map();
  private runtime: IAgentRuntime;
  private service: DiscordService;
  private loginPromises: Map<string, Promise<void>> = new Map();

  constructor(runtime: IAgentRuntime, service: DiscordService) {
    this.runtime = runtime;
    this.service = service;
  }

  /**
   * Parse bot tokens from environment and create clients
   */
  async initializeFromEnv(): Promise<void> {
    const tokensStr = this.runtime.getSetting('DISCORD_BOT_TOKENS') as string;
    const aliasesStr = this.runtime.getSetting('DISCORD_BOT_ALIASES') as string;

    if (!tokensStr) {
      // Fall back to single token for backward compatibility
      // Note: DISCORD_APPLICATION_ID is NOT a valid token - it's the OAuth2 client/application ID
      // used for invite URL generation, not for bot authentication
      const singleToken = this.runtime.getSetting('DISCORD_API_TOKEN') as string;

      if (singleToken) {
        const validation = validateDiscordToken(singleToken);
        if (!validation.valid) {
          logger.error(`[ClientRegistry] Invalid Discord token for 'default' bot: ${validation.error}`);
          logger.error('[ClientRegistry] Please check your DISCORD_API_TOKEN environment variable');
          logger.error('[ClientRegistry] Discord tokens should be in format: base64.timestamp.signature');
          logger.error('[ClientRegistry] Note: DISCORD_APPLICATION_ID is your app\'s client ID, not a bot token');
          throw new Error(`Invalid Discord token: ${validation.error}`);
        }
        await this.registerBot({ token: singleToken, alias: 'default' });
      } else {
        logger.warn('[ClientRegistry] No Discord bot tokens configured');
        logger.warn('[ClientRegistry] Please set DISCORD_BOT_TOKENS or DISCORD_API_TOKEN in your environment');
        logger.warn('[ClientRegistry] Note: DISCORD_APPLICATION_ID is your app\'s client ID, not a bot token');
      }
      return;
    }

    const tokens = tokensStr.split(',').map(t => t.trim()).filter(Boolean);
    const aliases = aliasesStr ? aliasesStr.split(',').map(a => a.trim()).filter(Boolean) : [];

    if (tokens.length === 0) {
      logger.warn('[ClientRegistry] DISCORD_BOT_TOKENS is set but contains no valid tokens');
      return;
    }

    logger.log(`[ClientRegistry] Initializing ${tokens.length} Discord bot(s)`);

    for (let i = 0; i < tokens.length; i++) {
      const alias = aliases[i] || `bot-${i}`;
      const validation = validateDiscordToken(tokens[i]);

      if (!validation.valid) {
        logger.error(`[ClientRegistry] Invalid Discord token for '${alias}': ${validation.error}`);
        logger.error(`[ClientRegistry] Token index: ${i}, Alias: ${alias}`);
        logger.error('[ClientRegistry] Please check your DISCORD_BOT_TOKENS environment variable');
        logger.error('[ClientRegistry] Discord tokens should be in format: base64.timestamp.signature');
        throw new Error(`Invalid Discord token for '${alias}': ${validation.error}`);
      }

      const config: DiscordBotConfig = {
        token: tokens[i],
        alias: alias,
      };
      await this.registerBot(config);
    }
  }

  /**
   * Register and login a new Discord bot
   */
  async registerBot(config: DiscordBotConfig): Promise<BotClientInfo> {
    const tempId = config.alias || `bot-${this.clients.size}`;

    // Validate token before attempting to register
    const validation = validateDiscordToken(config.token);
    if (!validation.valid) {
      logger.error(`[ClientRegistry] Cannot register bot '${tempId}': ${validation.error}`);
      throw new Error(`Invalid Discord token for '${tempId}': ${validation.error}`);
    }

    logger.log(`[ClientRegistry] Registering bot: ${tempId}`);

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      // Partials are required for DM messages - without them, DM channels aren't cached
      // and messageCreate events won't fire for DMs
      partials: [Partials.Channel, Partials.Message, Partials.User],
    });

    const voiceManager = new VoiceManager(this.service, this.runtime);

    const clientInfo: BotClientInfo = {
      client,
      voiceManager,
      config,
    };

    // Store temporarily with alias
    this.clients.set(tempId, clientInfo);

    // Login and update with real bot ID
    const loginPromise = this.loginBot(tempId, config.token);
    this.loginPromises.set(tempId, loginPromise);

    try {
      await loginPromise;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[ClientRegistry] Failed to login bot '${tempId}': ${errorMessage}`);

      // Provide helpful troubleshooting information
      if (errorMessage.includes('TokenInvalid') || errorMessage.includes('token')) {
        logger.error('[ClientRegistry] Token validation passed but Discord rejected it. Common causes:');
        logger.error('  1. Token was reset or regenerated in Discord Developer Portal');
        logger.error('  2. Bot application was deleted');
        logger.error('  3. Token copied incorrectly (check for extra spaces or missing characters)');
        logger.error('  4. Using a user token instead of a bot token');
        logger.error('[ClientRegistry] Get a fresh token from: https://discord.com/developers/applications');
      }

      // Destroy the client to release resources (REST client, caches, WebSocket)
      // Login failed - clean up
            // Destroy the client to release resources (REST client, caches, partial WebSocket connections)
            try {
              client.destroy();
            } catch (destroyError) {
              logger.debug(`[ClientRegistry] Error destroying client after failed login: ${destroyError}`);
            }
            this.clients.delete(tempId);
            logger.error(`[ClientRegistry] Failed to register bot '${tempId}': ${error}`);
            throw error;
    }

    return clientInfo;
  }

  /**
   * Login a bot and update registry with real bot ID
   */
  private async loginBot(tempId: string, token: string): Promise<void> {
    const clientInfo = this.clients.get(tempId);
    if (!clientInfo) {
      throw new Error(`Client ${tempId} not found`);
    }

    const { client } = clientInfo;

    return new Promise((resolve, reject) => {
      let settled = false;

      // Cleanup function to remove all listeners and clear timeout
      const cleanup = () => {
        clearTimeout(timeout);
        client.off('ready', onReady);
        client.off('error', onError);
      };

      const onReady = async () => {
        if (settled) return;
        settled = true;
        cleanup();

        if (!client.user) {
          reject(new Error(`Bot ${tempId} logged in but user is null`));
          return;
        }

        const botId = client.user.id;
        const username = client.user.username;

        clientInfo.botId = botId;
        clientInfo.username = username;

        // Set the client on VoiceManager (if it wasn't available at construction)
        clientInfo.voiceManager.setClient(client);

        // Set bot identification on VoiceManager
        clientInfo.voiceManager.setBotIdentification(botId, clientInfo.config.alias);

        // Re-key with bot ID if different from temp ID
        if (tempId !== botId) {
          this.clients.delete(tempId);
          this.clients.set(botId, clientInfo);
        }

        logger.log(`[ClientRegistry] Bot logged in: ${username} (${botId})`);

        // Emit ready event for voice manager
        client.emit('voiceManagerReady');

        // Emit WORLD_CONNECTED events for all guilds
        this.emitWorldConnectedEvents(client).catch(error => {
          logger.error(`[ClientRegistry] Error emitting WORLD_CONNECTED events: ${error}`);
        });

        resolve();
      };

      const onError = (error: Error) => {
        logger.error(`[ClientRegistry] Bot ${tempId} error: ${error}`);
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Bot ${tempId} login timeout`));
      }, 30000);

      client.once('ready', onReady);
      client.on('error', onError);

      client.login(token).catch((error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
  }

  /**
   * Get a client by bot ID or alias
   */
  getClient(idOrAlias: string): BotClientInfo | undefined {
    // Try direct lookup
    let info = this.clients.get(idOrAlias);
    if (info) return info;

    // Try alias lookup
    for (const [_, clientInfo] of this.clients) {
      if (clientInfo.config.alias === idOrAlias) {
        return clientInfo;
      }
    }

    return undefined;
  }

  /**
   * Get all registered clients
   */
  getAllClients(): BotClientInfo[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get client by guild ID (finds first bot connected to that guild)
   */
  getClientForGuild(guildId: string): BotClientInfo | undefined {
    for (const clientInfo of this.clients.values()) {
      if (clientInfo.client.guilds.cache.has(guildId)) {
        return clientInfo;
      }
    }
    return undefined;
  }

  /**
   * Remove a bot from the registry
   */
  async removeBot(idOrAlias: string): Promise<void> {
    const clientInfo = this.getClient(idOrAlias);
    if (!clientInfo) {
      logger.warn(`[ClientRegistry] Bot ${idOrAlias} not found for removal`);
      return;
    }

    const botId = clientInfo.botId || idOrAlias;

    logger.log(`[ClientRegistry] Removing bot: ${botId}`);

    // Cleanup
    clientInfo.client.destroy();
    this.clients.delete(botId);
    if (clientInfo.config.alias) {
      this.clients.delete(clientInfo.config.alias);
    }
  }

  /**
   * Get the primary/default client (for backward compatibility)
   */
  getPrimaryClient(): BotClientInfo | undefined {
    // Return the first client, or one marked as default
    const defaultClient = this.getClient('default');
    if (defaultClient) return defaultClient;

    // Return first available
    const all = this.getAllClients();
    return all.length > 0 ? all[0] : undefined;
  }

  /**
   * Destroy all clients
   */
  async destroyAll(): Promise<void> {
    logger.log('[ClientRegistry] Destroying all bot clients');

    // First, wait for any in-flight logins to complete or fail
    // This prevents race conditions where a login callback adds a client
    // back to the map after we've cleared it
    const pendingLogins = Array.from(this.loginPromises.values());
    if (pendingLogins.length > 0) {
      logger.debug(`[ClientRegistry] Waiting for ${pendingLogins.length} pending login(s) to complete`);
      await Promise.allSettled(pendingLogins);
    }

    // Now destroy all clients
    const destroyPromises = Array.from(this.clients.keys()).map(id =>
      this.removeBot(id)
    );

    await Promise.all(destroyPromises);
    this.clients.clear();
    this.loginPromises.clear();
  }

  /**
   * Check if any clients are registered
   */
  hasClients(): boolean {
    return this.clients.size > 0;
  }

  /**
   * Get count of registered clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Emit WORLD_CONNECTED events for all guilds the client is connected to
   * This implements the logic that was previously in the deprecated onReady() method
   */
  private async emitWorldConnectedEvents(client: Client): Promise<void> {
    try {
      const guilds = await client.guilds.fetch();
      if (!guilds) {
        logger.warn('[ClientRegistry] Could not fetch guilds for WORLD_CONNECTED events');
        return;
      }

      logger.log(`[ClientRegistry] Emitting WORLD_CONNECTED events for ${guilds.size} guild(s)`);

      for (const [, guild] of guilds) {
        try {
          const fullGuild = await guild.fetch();

          logger.log(`[ClientRegistry] DISCORD SERVER CONNECTED: ${fullGuild.name}`);

          // Emit Discord-specific event with full guild object
          this.runtime.emitEvent([DiscordEventTypes.WORLD_CONNECTED], {
            runtime: this.runtime,
            server: fullGuild,
            source: 'discord',
          });

          // Create platform-agnostic world data structure
          const worldId = createUniqueUuid(this.runtime, fullGuild.id);
          const ownerId = createUniqueUuid(this.runtime, fullGuild.ownerId);

          const standardizedData = {
            name: fullGuild.name,
            runtime: this.runtime,
            rooms: await this.service.buildStandardizedRooms(fullGuild, worldId),
            entities: [], // Entities will be discovered lazily when users send messages
            world: {
              id: worldId,
              name: fullGuild.name,
              agentId: this.runtime.agentId,
              serverId: fullGuild.id,
              metadata: {
                ownership: fullGuild.ownerId ? { ownerId } : undefined,
                roles: {
                  [ownerId]: Role.OWNER,
                },
              },
            } as World,
            source: 'discord',
          };

          // Emit standardized WORLD_CONNECTED event immediately
          this.runtime.emitEvent([EventType.WORLD_CONNECTED], standardizedData);

          logger.log(`[ClientRegistry] Emitted WORLD_CONNECTED for ${fullGuild.name} with ${standardizedData.rooms.length} rooms`);

          // For large guilds, skip user pre-population - users are discovered when they interact
          // For small guilds, optionally fetch users in background without blocking
          if (fullGuild.memberCount <= 1000) {
            // Small guild - fetch users in background (non-blocking)
            this.service.buildStandardizedUsers(fullGuild).then(entities => {
              logger.debug(`[ClientRegistry] Background user sync completed for ${fullGuild.name}: ${entities.length} users`);
            }).catch(error => {
              logger.debug(`[ClientRegistry] Background user sync failed for ${fullGuild.name}: ${error instanceof Error ? error.message : String(error)}`);
            });
          } else {
            logger.info(`[ClientRegistry] Skipping user pre-fetch for large guild ${fullGuild.name} (${fullGuild.memberCount.toLocaleString()} members) - users will be discovered organically`);
          }
        } catch (error) {
          logger.error(`[ClientRegistry] Error emitting WORLD_CONNECTED for guild: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      logger.error(`[ClientRegistry] Error in emitWorldConnectedEvents: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

