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
} from '@elizaos/core';
import { DiscordService } from '../service';
import { DISCORD_SERVICE_NAME } from '../constants';
import { type TextChannel, type Message } from 'discord.js';

/**
 * Template for extracting reaction information from the user's request.
 */
export const reactToMessageTemplate = `# Adding reactions to Discord messages
{{recentMessages}}

# Instructions: {{senderName}} wants to add a reaction to a message. Extract:
1. Which message to react to (last, specific message reference, or by content)
2. What emoji/reaction to add

Examples:
- "react with 👍 to the last message" -> messageRef: "last", emoji: "👍"
- "add :fire: reaction" -> messageRef: "last", emoji: "🔥" or ":fire:"
- "react to that message with ❤️" -> messageRef: "previous", emoji: "❤️"
- "add a thumbs up to john's message about the meeting" -> messageRef: "john meeting", emoji: "👍"

Your response must be formatted as a JSON block:
\`\`\`json
{
  "messageRef": "<last|previous|message-id|search-text>",
  "emoji": "<emoji-character|:emoji-name:>"
}
\`\`\`
`;

/**
 * Extracts emoji tokens from a string in the order they appear.
 *
 * Captures standard Unicode emoji sequences (including multi-codepoint sequences joined by zero-width joiners) and Discord custom emoji tokens in the form `<:name:id>` or `<a:name:id>`.
 *
 * @param text - The input text to scan for emojis
 * @returns An array of emoji strings found in `text`, in the order they appear (empty if none)
 */
function extractEmojisFromText(text: string): string[] {
  if (!text) {return [];}

  // Collect all emoji matches with their positions to preserve order
  const matches: { index: number; emoji: string }[] = [];

  // Match Unicode emojis (including multi-codepoint sequences)
  const unicodeEmojiRegex = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:\uFE0F)?(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:\uFE0F)?)*/gu;
  let match;
  while ((match = unicodeEmojiRegex.exec(text)) !== null) {
    matches.push({ index: match.index, emoji: match[0] });
  }

  // Match Discord custom emojis <:name:id> or <a:name:id>
  const customEmojiRegex = /<a?:\w+:\d+>/g;
  while ((match = customEmojiRegex.exec(text)) !== null) {
    matches.push({ index: match.index, emoji: match[0] });
  }

  // Sort by position and return just the emojis
  return matches.sort((a, b) => a.index - b.index).map(m => m.emoji);
}

/**
 * Determines whether a message explicitly requests adding a reaction or specifies a target.
 *
 * @param text - The message text to inspect for reaction-related keywords or target patterns
 * @returns `true` if the text contains reaction keywords OR specifies a message target; `false` otherwise.
 */
function isExplicitReactionRequest(text: string): boolean {
  if (!text) {return false;}
  const lower = text.toLowerCase();

  // Keywords indicating user explicitly requested a reaction
  if (/\b(react|reaction|emoji)\b/.test(lower)) {
    return true;
  }

  // Patterns indicating a specific message target (e.g., "add thumbs up to john's message")
  // These require LLM to extract the correct messageRef
  if (/\w+'s\s+message\b/.test(lower)) {return true;}  // "john's message"
  if (/message\s+(about|from|where)\b/.test(lower)) {return true;}  // "message about X"
  if (/\bto\s+\w+'s\b/.test(lower)) {return true;}  // "to john's"
  if (/\bthat\s+message\b/.test(lower)) {return true;}  // "that message"

  return false;
}

// Common Discord emoji mappings
const emojiMap: Record<string, string> = {
  ':thumbsup:': '👍',
  ':thumbs_up:': '👍',
  ':+1:': '👍',
  ':thumbsdown:': '👎',
  ':thumbs_down:': '👎',
  ':-1:': '👎',
  ':heart:': '❤️',
  ':fire:': '🔥',
  ':star:': '⭐',
  ':check:': '✅',
  ':white_check_mark:': '✅',
  ':x:': '❌',
  ':cross:': '❌',
  ':smile:': '😄',
  ':laughing:': '😆',
  ':thinking:': '🤔',
  ':eyes:': '👀',
  ':clap:': '👏',
  ':wave:': '👋',
  ':ok:': '👌',
  ':ok_hand:': '👌',
  ':raised_hands:': '🙌',
  ':pray:': '🙏',
  ':100:': '💯',
  ':rocket:': '🚀',
};

// Sentiment keywords mapped to emoji categories
const sentimentEmojis: Record<string, string[]> = {
  positive: ['👍', '✅', '💯', '🙌', '👏'],
  agreement: ['👍', '✅', '💯', '🤝'],
  excitement: ['🔥', '🚀', '⭐', '💥', '🎉'],
  love: ['❤️', '💕', '💜', '🖤', '💙'],
  thinking: ['🤔', '💭', '🧐'],
  funny: ['😂', '😆', '🤣', '😄'],
  greeting: ['👋', '🙌'],
  thanks: ['🙏', '💜', '❤️'],
  question: ['🤔', '❓', '👀'],
  sad: ['😢', '💔', '😞'],
  neutral: ['👀', '👍'],
};

/**
 * Detects the sentiment/intent of a message for emoji selection.
 * Returns a sentiment category that can be used to pick appropriate emojis.
 */
function detectSentiment(text: string): string {
  if (!text) return 'neutral';
  const lower = text.toLowerCase();

  if (/\b(thanks?|thank you|appreciate|grateful)\b/.test(lower)) return 'thanks';
  if (/\b(love|adore|amazing|wonderful|beautiful)\b/.test(lower)) return 'love';
  if (/\b(lol|lmao|haha|funny|hilarious|joke)\b/.test(lower)) return 'funny';
  if (/\b(awesome|excited|hype|let'?s go|amazing|incredible)\b/.test(lower)) return 'excitement';
  if (/\b(agree|yes|exactly|right|correct|true)\b/.test(lower)) return 'agreement';
  if (/\b(good|great|nice|cool|ok|fine|sure)\b/.test(lower)) return 'positive';
  if (/\b(hi|hello|hey|welcome|greetings)\b/.test(lower)) return 'greeting';
  if (/\?/.test(lower)) return 'question';
  if (/\b(sad|sorry|unfortunate|bad|wrong)\b/.test(lower)) return 'sad';
  if (/\b(think|wonder|maybe|perhaps|hmm)\b/.test(lower)) return 'thinking';

  return 'neutral';
}

/**
 * Check if the character's style forbids emoji usage.
 * Scans style.all for rules like "never use emojis".
 */
function characterForbidsEmojis(runtime: IAgentRuntime): boolean {
  const styleAll = runtime.character?.style?.all || [];
  for (const rule of styleAll) {
    const lower = rule.toLowerCase();
    if (
      (lower.includes('never') || lower.includes("don't") || lower.includes('no ')) &&
      lower.includes('emoji')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Get character's preferred emojis from settings.
 * Supports both array format and object format with categories.
 *
 * Examples:
 *   settings: { preferredEmojis: ['🌸', '🍂', '🌿'] }
 *   settings: { emojiPreferences: { preferred: ['🖤', '🌙'], forbidden: ['❤️'], fallback: '👍' } }
 */
function getCharacterEmojiPreferences(runtime: IAgentRuntime): {
  preferred: string[];
  forbidden: string[];
  fallback: string | null;
} {
  const settings = runtime.character?.settings as Record<string, unknown> | undefined;
  if (!settings) return { preferred: [], forbidden: [], fallback: null };

  // Simple array format
  if (Array.isArray(settings.preferredEmojis)) {
    return {
      preferred: settings.preferredEmojis as string[],
      forbidden: [],
      fallback: (settings.preferredEmojis as string[])[0] || null,
    };
  }

  // Object format with categories
  const prefs = settings.emojiPreferences as Record<string, unknown> | undefined;
  if (prefs && typeof prefs === 'object') {
    return {
      preferred: Array.isArray(prefs.preferred) ? (prefs.preferred as string[]) : [],
      forbidden: Array.isArray(prefs.forbidden) ? (prefs.forbidden as string[]) : [],
      fallback: typeof prefs.fallback === 'string' ? prefs.fallback : null,
    };
  }

  return { preferred: [], forbidden: [], fallback: null };
}

/**
 * Select an emoji based on character preferences and message sentiment
 * Returns null if character forbids emojis or no suitable emoji found
 */
const selectCharacterEmoji = (runtime: IAgentRuntime, text: string): string | null => {
  // Check if character forbids all emojis first
  if (characterForbidsEmojis(runtime)) {
    return null;
  }
  runtime: IAgentRuntime,
  messageText: string
): string | null {
  // Check if character forbids emojis
  if (characterForbidsEmojis(runtime)) {
    runtime.logger.debug(
      { src: 'plugin:discord:action:react' },
      `[REACT_TO_MESSAGE] Character style forbids emojis`
    );
    return null;
  }

  const prefs = getCharacterEmojiPreferences(runtime);
  const sentiment = detectSentiment(messageText);

  // If character has preferred emojis, try to match by sentiment
  if (prefs.preferred.length > 0) {
    // Get sentiment-appropriate emojis from character's preferred list
    const sentimentOptions = sentimentEmojis[sentiment] || sentimentEmojis.neutral;
    const characterMatch = prefs.preferred.find((e) => sentimentOptions.includes(e));

    if (characterMatch) {
      runtime.logger.debug(
        { src: 'plugin:discord:action:react', emoji: characterMatch, sentiment },
        `[REACT_TO_MESSAGE] Selected character-preferred emoji by sentiment`
      );
      return characterMatch;
    }

    // No sentiment match, use first preferred or fallback
    const selected = prefs.fallback || prefs.preferred[0];
    runtime.logger.debug(
      { src: 'plugin:discord:action:react', emoji: selected },
      `[REACT_TO_MESSAGE] Using character fallback emoji`
    );
    return selected;
  }

  // No character preferences - use sentiment-based selection
  const options = sentimentEmojis[sentiment] || sentimentEmojis.neutral;

  // Filter out forbidden emojis
  const allowed = prefs.forbidden.length > 0
    ? options.filter((e) => !prefs.forbidden.includes(e))
    : options;

  if (allowed.length === 0) {
    // Sentiment options exhausted - try neutral emojis first
    const neutralAllowed = sentimentEmojis.neutral.filter((e) => !prefs.forbidden.includes(e));
    if (neutralAllowed.length > 0) {
      runtime.logger.debug(
        { src: 'plugin:discord:action:react', emoji: neutralAllowed[0], sentiment },
        `[REACT_TO_MESSAGE] Sentiment emojis forbidden, using neutral fallback`
      );
      return neutralAllowed[0];
    }

    // Neutral exhausted - scan ALL emoji sets for any non-forbidden emoji
    for (const category of Object.keys(sentimentEmojis)) {
      const categoryAllowed = sentimentEmojis[category].filter((e) => !prefs.forbidden.includes(e));
      if (categoryAllowed.length > 0) {
        runtime.logger.debug(
          { src: 'plugin:discord:action:react', emoji: categoryAllowed[0], category, sentiment },
          `[REACT_TO_MESSAGE] Found non-forbidden emoji in ${category} category`
        );
        return categoryAllowed[0];
      }
    }

    // All emojis are forbidden - return null to skip reaction
    runtime.logger.debug(
      { src: 'plugin:discord:action:react', forbidden: prefs.forbidden },
      `[REACT_TO_MESSAGE] All emojis forbidden, skipping reaction`
    );
    return null;
  }

  const selected = allowed[0];
  runtime.logger.debug(
    { src: 'plugin:discord:action:react', emoji: selected, sentiment },
    `[REACT_TO_MESSAGE] Selected sentiment-based emoji`
  );
  return selected;
}

export const reactToMessage: Action = {
  name: 'REACT_TO_MESSAGE',
  similes: [
    'REACT_TO_MESSAGE',
    'ADD_REACTION',
    'REACT_MESSAGE',
    'ADD_EMOJI',
    'EMOJI_REACT',
    'MESSAGE_REACTION',
  ],
  description: 'Add an emoji reaction to a Discord message.',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    return message.content.source === 'discord';
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const discordService = runtime.getService(DISCORD_SERVICE_NAME) as DiscordService;

    if (!discordService || !discordService.client) {
      await callback({
        text: 'Discord service is not available.',
        source: 'discord',
      });
      return;
    }

    // ============================================================================
    // Extract reaction info - use fast path when appropriate, LLM otherwise
    // ============================================================================
    let reactionInfo: { messageRef: string; emoji: string } | null = null;

    // Check if user explicitly requested a reaction (needs LLM for accuracy)
    // vs agent spontaneously reacting (fast path to "last message" is correct)
    const userText = message.content?.text || '';
    const needsLLM = isExplicitReactionRequest(userText);

    if (!needsLLM) {
      // FAST PATH: Agent spontaneously reacting - target is always "last message"
      const responseText = state.data?.responseText ||
        state.data?.text ||
        (state as any).responseText ||
        '';

      if (responseText) {
        const emojis = extractEmojisFromText(responseText);
        if (emojis.length > 0) {
          runtime.logger.debug(
            { src: 'plugin:discord:action:react', emoji: emojis[0], source: 'responseText' },
            '[REACT_TO_MESSAGE] Found emoji in response text (fast path)'
          );
          reactionInfo = { messageRef: 'last', emoji: emojis[0] };
        }
      }

      if (!reactionInfo) {
        // Check recent messages for this agent's last message
        const recentMessages = (state.data?.recentMessages || []) as Memory[];
        const agentLastMessage = recentMessages
          .filter(m => m.entityId === runtime.agentId)
          .pop();

        if (agentLastMessage?.content?.text) {
          const emojis = extractEmojisFromText(agentLastMessage.content.text);
          if (emojis.length > 0) {
            runtime.logger.debug(
              { src: 'plugin:discord:action:react', emoji: emojis[0], source: 'agentLastMessage' },
              '[REACT_TO_MESSAGE] Found emoji in agent\'s last message (fast path)'
            );
            reactionInfo = { messageRef: 'last', emoji: emojis[0] };
          }
        }
      }
    }

    // ============================================================================
    // CHARACTER PATH: Use character preferences/style when fast path fails
    // ============================================================================
    if (!reactionInfo && !needsLLM) {
      // Agent spontaneously reacting, try character-based emoji selection
      const characterEmoji = selectCharacterEmoji(runtime, userText);
      if (characterEmoji) {
        runtime.logger.debug(
          { src: 'plugin:discord:action:react', emoji: characterEmoji },
          `[REACT_TO_MESSAGE] Using character-based emoji selection`
        );
        reactionInfo = { messageRef: 'last', emoji: characterEmoji };
      } else if (characterForbidsEmojis(runtime)) {
        // Character style forbids emojis - silently skip
        runtime.logger.debug(
          { src: 'plugin:discord:action:react' },
          `[REACT_TO_MESSAGE] Skipping reaction - character forbids emojis`
        );
        return;
      }
    }

    // ============================================================================
    // LLM PATH: Use when explicit request or other paths fail
    // ============================================================================
    if (!reactionInfo) {
      const prompt = composePromptFromState({
        state,
        template: reactToMessageTemplate,
      });

      for (let i = 0; i < 3; i++) {
        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        });

        const parsedResponse = parseJSONObjectFromText(response);
        if (parsedResponse?.emoji) {
          // Check if the LLM-selected emoji is forbidden by character
          const prefs = getCharacterEmojiPreferences(runtime);
          let emoji: string | null = parsedResponse.emoji;

          if (prefs.forbidden.includes(emoji)) {
            // Try to find an allowed alternative from sentiment-matched emojis
            const sentiment = detectSentiment(userText);
            const alternatives = sentimentEmojis[sentiment] || [];
            const allowedAlternatives = alternatives.filter((e) => !prefs.forbidden.includes(e));

            if (allowedAlternatives.length > 0) {
              emoji = allowedAlternatives[0];
            } else {
              // Fallback to neutral emojis filtered for forbidden
              const neutralAllowed = sentimentEmojis.neutral.filter((e) => !prefs.forbidden.includes(e));
              if (neutralAllowed.length > 0) {
                emoji = neutralAllowed[0];
              } else {
                // No safe emoji available - skip reaction entirely
                runtime.logger.debug(
                  { src: 'plugin:discord:action:react', forbidden: prefs.forbidden },
                  '[REACT_TO_MESSAGE] LLM selected forbidden emoji and no safe alternative exists, skipping reaction'
                );
                emoji = null;
              }
            }
          }

          if (emoji) {
            reactionInfo = {
              messageRef: parsedResponse.messageRef || 'last',
              emoji,
            };
            break;
          }
        }
      }
    }

    if (!reactionInfo) {
      runtime.logger.debug(
        { src: 'plugin:discord:action:react' },
        '[REACT_TO_MESSAGE] Could not extract reaction info'
      );
      // Only show error to user if they explicitly requested a reaction
      // Silent failure is appropriate when agent spontaneously decides to react
      if (needsLLM) {
        await callback({
          text: "I couldn't understand which message to react to or what emoji to use. Try being more specific, like 'react with 👍 to the last message'.",
          source: 'discord',
        });
      }
      return;
    }

    try {
      const room = state.data?.room || (await runtime.getRoom(message.roomId));
      if (!room?.channelId) {
        await callback({
          text: "I couldn't determine the current channel.",
          source: 'discord',
        });
        return;
      }

      const channel = await discordService.client.channels.fetch(room.channelId);
      if (!channel || !channel.isTextBased()) {
        await callback({
          text: 'I can only react to messages in text channels.',
          source: 'discord',
        });
        return;
      }

      const textChannel = channel as TextChannel;

      let targetMessage: Message | null = null;

      // Find the target message
      if (reactionInfo.messageRef === 'last' || reactionInfo.messageRef === 'previous') {
        // Get the last few messages - fetch max allowed by Discord API
        const messages = await textChannel.messages.fetch({ limit: 100 });
        const sortedMessages = Array.from(messages.values()).sort(
          (a, b) => b.createdTimestamp - a.createdTimestamp
        );

        // Skip the bot's own message and the command message
        targetMessage =
          sortedMessages.find(
            (msg) =>
              msg.id !== message.content.id && msg.author.id !== discordService.client!.user!.id
          ) || null;
      } else if (/^\d+$/.test(reactionInfo.messageRef)) {
        // It's a message ID
        try {
          targetMessage = await textChannel.messages.fetch(reactionInfo.messageRef);
        } catch (e) {
          // Message not found
        }
      } else {
        // Search for message by content/author - fetch max allowed by Discord API
        const messages = await textChannel.messages.fetch({ limit: 100 });
        const searchLower = reactionInfo.messageRef.toLowerCase();

        targetMessage =
          Array.from(messages.values()).find((msg) => {
            const contentMatch = msg.content.toLowerCase().includes(searchLower);
            const authorMatch = msg.author.username.toLowerCase().includes(searchLower);
            return contentMatch || authorMatch;
          }) || null;
      }

      if (!targetMessage) {
        await callback({
          text: "I couldn't find the message you want me to react to. Try being more specific or use 'last message'.",
          source: 'discord',
        });
        return;
      }

      // Normalize the emoji
      let emoji = reactionInfo.emoji;
      if (!/\p{Emoji}/u.test(emoji)) {
        const mapped = emojiMap[emoji.toLowerCase()];
        if (mapped) {
          emoji = mapped;
        } else if (!/<a?:\w+:\d+>/.test(emoji)) {
          // Not a custom emoji, remove colons
          emoji = emoji.replace(/:/g, '');
        }
      }

      // Add the reaction
      try {
        await targetMessage.react(emoji);

        const response: Content = {
          text: `I've added a ${emoji} reaction to the message.`,
          source: message.content.source,
        };

        await callback(response);
      } catch (error) {
        runtime.logger.error({ src: 'plugin:discord:action:react-to-message', agentId: runtime.agentId, emoji: reactionInfo.emoji, error: error instanceof Error ? error.message : String(error) }, 'Failed to add reaction');
        await callback({
          text: `I couldn't add that reaction. Make sure the emoji "${reactionInfo.emoji}" is valid and I have permission to add reactions.`,
          source: 'discord',
        });
      }
    } catch (error) {
      runtime.logger.error({ src: 'plugin:discord:action:react-to-message', agentId: runtime.agentId, error: error instanceof Error ? error.message : String(error) }, 'Error in react to message');
      await callback({
        text: 'I encountered an error while trying to react to the message. Please make sure I have the necessary permissions.',
        source: 'discord',
      });
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'react with 👍 to the last message',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll add a thumbs up reaction to the last message.",
          actions: ['REACT_TO_MESSAGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'add a fire emoji to that',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Adding a 🔥 reaction.',
          actions: ['REACT_TO_MESSAGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "react to john's message about the meeting with a checkmark",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll find john's message about the meeting and add a ✅ reaction.",
          actions: ['REACT_TO_MESSAGE'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default reactToMessage;
