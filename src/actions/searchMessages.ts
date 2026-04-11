import {
  type Action,
  type ActionExample,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  composePromptFromState,
  parseJSONObjectFromText,
} from "@elizaos/core";
import { DiscordService } from "../service";
import { DISCORD_SERVICE_NAME } from "../constants";
import { type TextChannel, type Message, Collection, type Guild, type GuildChannel } from "discord.js";
import { isDiscordSnowflake } from "../utils";

/**
 * Template for extracting search parameters from the user's request.
 *
 * PROMPT DESIGN NOTE:
 * We show a minimal JSON schema with only required fields. Optional fields are
 * described separately. This prevents LLMs from outputting null/undefined for
 * fields they feel compelled to include when they see them in the schema.
 */
export const searchMessagesTemplate = `# Searching for Discord messages
{{recentMessages}}

# Instructions: {{senderName}} is requesting to search for messages in Discord.

Extract the search parameters as JSON. Only include fields that apply to the request.

## Required fields:
- "query": The search keywords
- "channelIdentifier": Channel name, channel ID, or "current" (default: "current")

## Optional fields (only include if explicitly mentioned):
- "author": Username to filter by (only if user asked to search messages FROM someone)
- "timeRange": One of "hour", "day", "week", "month" (only if user specified a time period)
- "limit": Number 1-100 (default: 20)

## Examples:

"search for messages containing 'meeting'" ->
\`\`\`json
{"query": "meeting", "channelIdentifier": "current"}
\`\`\`

"find messages from @john about bugs" ->
\`\`\`json
{"query": "bugs", "channelIdentifier": "current", "author": "john"}
\`\`\`

"search #general for links from last week" ->
\`\`\`json
{"query": "links", "channelIdentifier": "general", "timeRange": "week"}
\`\`\`

Now extract the parameters from {{senderName}}'s request:
`;

const getSearchParams = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State,
): Promise<{
  query: string;
  channelIdentifier: string;
  author: string | null;
  timeRange: string | null;
  limit: number;
} | null> => {
  const prompt = composePromptFromState({
    state,
    template: searchMessagesTemplate,
  });

  for (let i = 0; i < 3; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response);
    if (parsedResponse?.query) {
      // Remove quotes from query if present
      const cleanQuery = parsedResponse.query.replace(/^["']|["']$/g, "");

      // Normalize null-like string values to actual null
      const normalizeNullish = (val: unknown): string | null => {
        if (!val) return null;
        if (typeof val === 'string') {
          const lower = val.toLowerCase().trim();
          if (lower === 'null' || lower === 'undefined' || lower === 'none' || lower === '') {
            return null;
          }
          return val;
        }
        return null;
      };

      return {
        query: cleanQuery,
        channelIdentifier: parsedResponse.channelIdentifier || 'current',
        author: normalizeNullish(parsedResponse.author),
        timeRange: normalizeNullish(parsedResponse.timeRange),
        limit: Math.min(Math.max(parsedResponse.limit || 20, 1), 100),
      };
    }
  }
  return null;
};

const searchInMessages = (
  messages: Collection<string, Message>,
  query: string,
  author?: string | null,
): Message[] => {
  const queryLower = query.toLowerCase().trim();
  const isLinkSearch =
    queryLower.includes("link") || queryLower.includes("url");

  return Array.from(messages.values()).filter((msg) => {
    // Skip system messages
    if (msg.system) {
      return false;
    }

    // Filter by author if specified (already normalized to null if invalid)
    if (author) {
      const authorLower = author.toLowerCase();
      const matchesUsername = msg.author.username
        .toLowerCase()
        .includes(authorLower);
      const matchesDisplayName =
        msg.member?.displayName?.toLowerCase().includes(authorLower) || false;
      if (!matchesUsername && !matchesDisplayName) {
        return false;
      }
    }

    // Special handling for link searches
    if (isLinkSearch) {
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      return urlRegex.test(msg.content);
    }

    // Search in message content (case-insensitive)
    const contentMatch = msg.content.toLowerCase().includes(queryLower);

    // Search in embeds
    const embedMatch = msg.embeds.some(
      (embed) =>
        embed.title?.toLowerCase().includes(queryLower) ||
        embed.description?.toLowerCase().includes(queryLower) ||
        embed.author?.name?.toLowerCase().includes(queryLower) ||
        embed.fields?.some(
          (field) =>
            field.name?.toLowerCase().includes(queryLower) ||
            field.value?.toLowerCase().includes(queryLower),
        ),
    );

    // Search in attachments
    const attachmentMatch = msg.attachments.some(
      (att) =>
        att.name?.toLowerCase().includes(queryLower) ||
        att.description?.toLowerCase().includes(queryLower),
    );

    return contentMatch || embedMatch || attachmentMatch;
  });
};

export const searchMessages: Action = {
  name: "SEARCH_MESSAGES",
  similes: [
    "SEARCH_MESSAGES",
    "FIND_MESSAGES",
    "SEARCH_CHAT",
    "LOOK_FOR_MESSAGES",
    "FIND_IN_CHAT",
    "SEARCH_CHANNEL",
    "SEARCH_DISCORD",
  ],
  description:
    "Search for messages in Discord channels based on keywords, author, or time range.",
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    return message.content.source === "discord";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback,
  ) => {
    const discordService = runtime.getService(
      DISCORD_SERVICE_NAME,
    ) as DiscordService;

    if (!discordService || !discordService.client) {
      await callback({
        text: "Discord service is not available.",
        source: "discord",
      });
      return;
    }

    const searchParams = await getSearchParams(runtime, message, state);
    if (!searchParams) {
      await callback({
        text: "I couldn't understand what you want to search for. Please specify what to search.",
        source: "discord",
      });
      return;
    }

    try {
      let targetChannel: TextChannel | null = null;
      const room = state.data?.room || (await runtime.getRoom(message.roomId));

      // Determine the target channel
      if (searchParams.channelIdentifier === "current") {
        if (room?.channelId) {
          targetChannel = (await discordService.client.channels.fetch(
            room.channelId,
          )) as TextChannel;
        }
      } else if (searchParams.channelIdentifier.match(/^\d+$/)) {
        targetChannel = (await discordService.client.channels.fetch(
          searchParams.channelIdentifier,
        )) as TextChannel;
      } else {
        // It's a channel name - search in the current server
        const channelId = room?.channelId;
        const messageServerId = (room as any)?.messageServerId;
        
        let guild: Guild | undefined;

        // Primary path: Use channelId to find the guild
        if (channelId) {
          let currentChannel = discordService.client.channels.cache.get(channelId) as GuildChannel | undefined;
          if (!currentChannel) {
            try {
              currentChannel = await discordService.client.channels.fetch(channelId) as GuildChannel | undefined;
            } catch {
              // Channel fetch failed
            }
          }
          guild = currentChannel?.guild;
        }

        // Backwards compatibility: If channelId didn't work, try messageServerId
        // Only if it looks like a Discord snowflake (not a UUID)
        if (!guild && isDiscordSnowflake(messageServerId)) {
          try {
            guild = await discordService.client.guilds.fetch(messageServerId);
          } catch {
            // Guild fetch failed
          }
        }

        if (!guild) {
          await callback({
            text: "I couldn't determine which server to search for that channel.",
            source: "discord",
          });
          return;
        }
        const channels = await guild.channels.fetch();
        targetChannel =
          (channels.find(
            (channel) =>
              channel?.name
                .toLowerCase()
                .includes(searchParams.channelIdentifier.toLowerCase()) &&
              channel.isTextBased(),
          ) as TextChannel | undefined) || null;
      }

      if (!targetChannel || !targetChannel.isTextBased()) {
        await callback({
          text: "I couldn't find that channel or I don't have access to it.",
          source: "discord",
        });
        return;
      }

      // Calculate time limit
      let before: number | undefined = undefined;
      if (searchParams.timeRange) {
        const now = Date.now();
        const timeMap: Record<string, number> = {
          hour: 60 * 60 * 1000,
          day: 24 * 60 * 60 * 1000,
          week: 7 * 24 * 60 * 60 * 1000,
          month: 30 * 24 * 60 * 60 * 1000,
        };
        if (timeMap[searchParams.timeRange]) {
          before = now - timeMap[searchParams.timeRange];
        }
      }

      // Fetch messages - Discord API limit is 100 per request
      const messages = await targetChannel.messages.fetch({
        limit: 100, // Discord API max limit
        before: before?.toString(),
      });

      // Search through messages
      const results = searchInMessages(
        messages,
        searchParams.query,
        searchParams.author,
      );
      runtime.logger.debug(
        {
          src: "plugin:discord:action:search-messages",
          agentId: runtime.agentId,
          query: searchParams.query,
          resultsCount: results.length,
          channelName: targetChannel.name,
        },
        "Search completed",
      );

      // Sort by timestamp (newest first) and limit
      const sortedResults = results.sort(
        (a, b) => b.createdTimestamp - a.createdTimestamp,
      );
      const limitedResults = sortedResults.slice(0, searchParams.limit);

      if (limitedResults.length === 0) {
        await callback({
          text: `No messages found matching "${searchParams.query}" in <#${targetChannel.id}>.`,
          source: "discord",
        });
        return;
      }

      // Format results
      const formattedResults = limitedResults
        .map((msg, index) => {
          const timestamp = new Date(msg.createdTimestamp).toLocaleString();
          const preview =
            msg.content.length > 100
              ? `${msg.content.substring(0, 100)}...`
              : msg.content;
          const attachments =
            msg.attachments.size > 0
              ? `\n📎 ${msg.attachments.size} attachment(s)`
              : "";

          return `**${index + 1}.** ${msg.author.username} (${timestamp})\n${preview}${attachments}\n[Jump to message](${msg.url})`;
        })
        .join("\n\n");

      const response: Content = {
        text: `Found ${limitedResults.length} message${limitedResults.length !== 1 ? "s" : ""} matching "${searchParams.query}" in <#${targetChannel.id}>:\n\n${formattedResults}`,
        source: message.content.source,
      };

      await callback(response);
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:search-messages",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error searching messages",
      );
      await callback({
        text: "I encountered an error while searching for messages. Please try again.",
        source: "discord",
      });
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "search for messages containing 'meeting'",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll search for messages containing 'meeting'.",
          actions: ["SEARCH_MESSAGES"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "find all links shared in #general from last week",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Let me search for links in #general from the past week.",
          actions: ["SEARCH_MESSAGES"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "search for messages from @john about the bug",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll look for messages from john about the bug.",
          actions: ["SEARCH_MESSAGES"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default searchMessages;
