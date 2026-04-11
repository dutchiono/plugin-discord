import type { Guild, GuildChannel } from 'discord.js';
import type { DiscordService } from './service';

/**
 * Check if a string looks like a Discord snowflake ID (all digits, 17-20 chars)
 * UUIDs contain hyphens and letters, snowflakes are pure numeric
 */
export function isDiscordSnowflake(id: string | undefined): boolean {
  if (!id) {return false;}
  return /^\d{17,20}$/.test(id);
}

/**
 * Get the guild from a channel ID or message server ID (with backwards compatibility)
 */
export const getGuildFromRoom = async (
  discordService: DiscordService,
  channelId?: string,
  messageServerId?: string,
): Promise<Guild | null> => {
  if (!discordService.client) {return null;}

  // Primary path: Use channelId to find the guild
  if (channelId) {
    let channel = discordService.client.channels.cache.get(channelId) as GuildChannel | undefined;
    if (!channel) {
      try {
        channel = await discordService.client.channels.fetch(channelId) as GuildChannel | undefined;
      } catch {
        // Channel fetch failed
      }
    }
    if (channel?.guild) {
      return channel.guild;
    }
  }

  // Backwards compatibility: If channelId didn't work, try messageServerId
  // Only if it looks like a Discord snowflake (not a UUID)
  if (isDiscordSnowflake(messageServerId)) {
    try {
      return await discordService.client.guilds.fetch(messageServerId);
    } catch {
      // Guild fetch failed
    }
  }

  return null;
};
