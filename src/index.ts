import { type IAgentRuntime, type Plugin } from '@elizaos/core';
import chatWithAttachments from './actions/chatWithAttachments';
import { downloadMedia } from './actions/downloadMedia';
import joinChannel from './actions/joinChannel';
import leaveChannel from './actions/leaveChannel';
import listChannels from './actions/listChannels';
import readChannel from './actions/readChannel';
import sendDM from './actions/sendDM';
import { summarize } from './actions/summarizeConversation';
import { transcribeMedia } from './actions/transcribeMedia';
import searchMessages from './actions/searchMessages';
import createPoll from './actions/createPoll';
import getUserInfo from './actions/getUserInfo';
import reactToMessage from './actions/reactToMessage';
import pinMessage from './actions/pinMessage';
import unpinMessage from './actions/unpinMessage';
import serverInfo from './actions/serverInfo';
import setVoiceChannelStatus from './actions/setVoiceChannelStatus';
import setListeningActivity from './actions/setListeningActivity';

import { channelStateProvider } from './providers/channelState';
import { voiceStateProvider } from './providers/voiceState';
import { audioStateProvider } from './providers/audioState';
import { agentRoleProvider } from './providers/agentRole';
import { discordInstructionsProvider, discordSettingsProvider } from './providers/plugin-info';
import { DiscordService } from './service';
import { DiscordTestSuite } from './tests';
import { printBanner } from './banner';
import { getPermissionValues } from './permissions';

// Export audio channel types and constants for use by other plugins
export type { AudioChannelConfig, PlaybackHandle } from './voice';
export {
  CHANNEL_TTS,
  CHANNEL_MUSIC,
  CHANNEL_SFX,
  CHANNEL_AMBIENT,
  DEFAULT_CHANNEL_CONFIGS,
  getChannelName,
  canInterrupt,
} from './audioChannels';

// Export progressive message helper for use by other plugins
export { ProgressiveMessage } from './progressiveMessage';

// Export multi-bot voice types
export type { VoiceTarget, DiscordBotConfig } from './types';
export { VoiceConnectionManager } from './voiceConnectionManager';
export { DiscordClientRegistry } from './clientRegistry';

// Export audio sink contracts
export type { IAudioSink, AudioSinkStatus } from './contracts';
export { DiscordAudioSink } from './sinks';

const discordPlugin: Plugin = {
  name: 'discord',
  description: 'Discord service plugin for integration with Discord servers and channels',
  services: [DiscordService],
  actions: [
    chatWithAttachments,
    downloadMedia,
    joinChannel,
    leaveChannel,
    listChannels,
    readChannel,
    sendDM,
    summarize,
    transcribeMedia,
    searchMessages,
    createPoll,
    getUserInfo,
    reactToMessage,
    pinMessage,
    unpinMessage,
    serverInfo,
    setVoiceChannelStatus,
    setListeningActivity,
  ],
  providers: [channelStateProvider, voiceStateProvider, audioStateProvider, agentRoleProvider, discordInstructionsProvider, discordSettingsProvider],
  tests: [new DiscordTestSuite()],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // Gather ALL Discord settings
    const appId = runtime.getSetting('DISCORD_APPLICATION_ID') as string;
    const token = runtime.getSetting('DISCORD_API_TOKEN') as string;
    const botTokens = runtime.getSetting('DISCORD_BOT_TOKENS') as string;
    const voiceChannelId = runtime.getSetting('DISCORD_VOICE_CHANNEL_ID') as string;
    const channelIds = runtime.getSetting('CHANNEL_IDS') as string;
    const listenChannelIds = runtime.getSetting('DISCORD_LISTEN_CHANNEL_IDS') as string;
    const ignoreBotMessages = runtime.getSetting('DISCORD_SHOULD_IGNORE_BOT_MESSAGES') as string;
    const ignoreDirectMessages = runtime.getSetting('DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES') as string;
    const respondOnlyToMentions = runtime.getSetting('DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS') as string;

    // Print beautiful settings banner with ALL settings
    // Includes tiered permission matrix for Discord invite URLs:
    // - Basic / Moderator / Admin (role levels)
    // - With or without voice permissions
    printBanner({
      pluginName: 'plugin-discord',
      description: 'Discord bot integration for servers and channels',
      applicationId: appId || undefined,
      discordPermissions: appId ? getPermissionValues() : undefined,
      settings: [
        {
          name: 'DISCORD_API_TOKEN',
          value: token,
          sensitive: true,
          required: true,
        },
        {
          name: 'DISCORD_APPLICATION_ID',
          value: appId,
        },
        {
          name: 'DISCORD_BOT_TOKENS',
          value: botTokens,
          sensitive: true,
        },
        {
          name: 'DISCORD_VOICE_CHANNEL_ID',
          value: voiceChannelId,
        },
        {
          name: 'CHANNEL_IDS',
          value: channelIds,
        },
        {
          name: 'DISCORD_LISTEN_CHANNEL_IDS',
          value: listenChannelIds,
        },
        {
          name: 'DISCORD_SHOULD_IGNORE_BOT_MESSAGES',
          value: ignoreBotMessages,
          defaultValue: 'false',
        },
        {
          name: 'DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES',
          value: ignoreDirectMessages,
          defaultValue: 'false',
        },
        {
          name: 'DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS',
          value: respondOnlyToMentions,
          defaultValue: 'false',
        },
      ],
      runtime,
    });

    // Check for valid bot token - only DISCORD_API_TOKEN and DISCORD_BOT_TOKENS are valid
    // Note: DISCORD_APPLICATION_ID is the OAuth2 client/application ID (numeric), NOT a bot token
    if ((!token || token.trim() === '') && (!botTokens || botTokens.trim() === '')) {
      runtime.logger.warn('');
      runtime.logger.warn('═══════════════════════════════════════════════════════════════');
      runtime.logger.warn('Discord Bot Token not provided - Discord plugin will not work');
      runtime.logger.warn('═══════════════════════════════════════════════════════════════');
      runtime.logger.warn('To enable Discord functionality, add ONE of these to your .env:');
      runtime.logger.warn('  • DISCORD_API_TOKEN=your_bot_token       (recommended)');
      runtime.logger.warn('  • DISCORD_BOT_TOKENS=token1,token2,...   (multi-bot setup)');
      runtime.logger.warn('');
      runtime.logger.warn('Get your bot token from the Discord Developer Portal:');
      runtime.logger.warn('  https://discord.com/developers/applications');
      runtime.logger.warn('  Your Application → Bot → Token → Reset Token / Copy');
      runtime.logger.warn('');
      runtime.logger.warn('Note: DISCORD_APPLICATION_ID is your app\'s OAuth2 client ID');
      runtime.logger.warn('      (used for invite URLs), not a bot token for authentication.');
      runtime.logger.warn('═══════════════════════════════════════════════════════════════');
      runtime.logger.warn('');
    }

  },
};

export default discordPlugin;

// Export additional items for use by other plugins
// IDiscordService? from ./types
export { DISCORD_SERVICE_NAME } from './constants';
export { DiscordService } from './service';
export type { DiscordService as IDiscordService } from './service';

// Export event types and payload interfaces for external consumers
export { DiscordEventTypes } from './types';
export type {
  PermissionState,
  PermissionDiff,
  AuditInfo,
  PermissionPayloadRuntime,
  ChannelPermissionsChangedPayload,
  RolePermissionsChangedPayload,
  MemberRolesChangedPayload,
  RoleLifecyclePayload,
} from './types';

// Export permission utilities for external consumers
export {
  ELEVATED_PERMISSIONS,
  isElevatedRole,
  hasElevatedPermissions,
} from './permissionEvents';

// Export permission tier system for invite URL generation
export {
  DiscordPermissionTiers,
  generateInviteUrl,
  generateAllInviteUrls,
  getPermissionValues,
  type DiscordPermissionTier,
  type DiscordPermissionValues,
} from './permissions';
