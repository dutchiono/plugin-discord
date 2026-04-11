import {
  type IAgentRuntime,
  ModelType,
  logger,
  parseJSONObjectFromText,
  trimTokens,
  type Media,
} from '@elizaos/core';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ChannelType,
  type Message as DiscordMessage,
  PermissionsBitField,
  StringSelectMenuBuilder,
  type TextChannel,
  ThreadChannel,
  type Guild,
  type GuildChannel,
} from 'discord.js';
import { type DiscordComponentOptions, type DiscordActionRow } from './types';
import { DiscordService } from './service';

/**
 * Check if a string looks like a Discord snowflake ID (all digits, 17-20 chars)
 * UUIDs contain hyphens and letters, snowflakes are pure numeric
 */
export function isDiscordSnowflake(id: string | undefined): boolean {
  if (!id) return false;
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
  if (!discordService.client) return null;
  
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

/**
 * Type definition for the unified messaging API available on some runtime versions.
 */
export interface UnifiedMessagingAPI {
  sendMessage: (agentId: string, message: any, options?: { onResponse?: any }) => Promise<any>;
}

/**
 * Type definition for the message service available on newer core versions.
 */
export interface MessageServiceAPI {
  handleMessage: (runtime: IAgentRuntime, message: any, callback: any) => Promise<any>;
}

/**
 * Checks if the runtime has the unified messaging API (elizaOS.sendMessage).
 * @param {IAgentRuntime} runtime - The runtime to check
 * @returns {boolean} True if the unified messaging API is available
 */
export function hasUnifiedMessagingAPI(runtime: IAgentRuntime): boolean {
  const runtimeAny = runtime as any;
  return !!(runtimeAny.elizaOS && typeof runtimeAny.elizaOS.sendMessage === 'function');
}

/**
 * Checks if the runtime has the message service API (messageService.handleMessage).
 * @param {IAgentRuntime} runtime - The runtime to check
 * @returns {boolean} True if the message service API is available
 */
export function hasMessageService(runtime: IAgentRuntime): boolean {
  const runtimeAny = runtime as any;
  return !!(
    typeof runtimeAny.messageService === 'object' &&
    runtimeAny.messageService &&
    typeof runtimeAny.messageService.handleMessage === 'function'
  );
}

/**
 * Gets the unified messaging API if available.
 * @param {IAgentRuntime} runtime - The runtime to get the API from
 * @returns {UnifiedMessagingAPI | null} The unified messaging API or null if not available
 */
export function getUnifiedMessagingAPI(runtime: IAgentRuntime): UnifiedMessagingAPI | null {
  if (hasUnifiedMessagingAPI(runtime)) {
    return (runtime as any).elizaOS as UnifiedMessagingAPI;
  }
  return null;
}

/**
 * Gets the message service if available.
 * @param {IAgentRuntime} runtime - The runtime to get the service from
 * @returns {MessageServiceAPI | null} The message service or null if not available
 */
export function getMessageService(runtime: IAgentRuntime): MessageServiceAPI | null {
  if (hasMessageService(runtime)) {
    return (runtime as any).messageService as MessageServiceAPI;
  }
  return null;
}

export const MAX_MESSAGE_LENGTH = 1900;

/**
 * Cleans a URL by removing common trailing junk from Discord messages:
 * - Markdown escape backslashes (t\.co -> t.co)
 * - Markdown link leakage (url](url -> url)
 * - Trailing punctuation and markdown (*_/.,;!>)
 * - Trailing full-width/CJK punctuation (（）［］、。etc.)
 * Note: Preserves valid non-ASCII path characters for internationalized URLs
 *
 * @param {string} url - The raw URL to clean
 * @returns {string} The cleaned URL
 */
export function cleanUrl(url: string): string {
  let clean = url;

  // 1. Remove markdown escape backslashes (e.g. "t\.co" -> "t.co")
  clean = clean.replace(/\\([._\-~])/g, '$1');

  // 2. Handle markdown link leakage (e.g. "url](url" or "](url")
  // Only truncate if we detect the markdown link pattern "](url" which indicates
  // markdown syntax has leaked into the URL. Valid URLs can contain brackets
  // (e.g., query params like "?param[0]=value", IPv6 addresses, fragments).
  if (clean.startsWith('](')) {
    // URL starts with markdown link syntax leakage - extract the URL after "]("
    clean = clean.substring(2);
  } else {
    const markdownLinkPattern = /\]\(/;
    const markdownPatternIdx = clean.search(markdownLinkPattern);
    if (markdownPatternIdx > -1) {
      // Found markdown link pattern - truncate at the ']' character
      // This handles cases like "text](https://example.com" where markdown syntax leaked
      clean = clean.substring(0, markdownPatternIdx);
    }
  }
  // Note: Trailing brackets will be handled by the trailing junk removal step below

  // 3. Remove trailing junk in a loop - handles layered issues like:
  //    - Punctuation/markdown: "site.com**" -> "site.com"
  //    - Full-width punctuation: "site.com）" -> "site.com"
  //    - Mixed: "site.com/path）**" -> "site.com/path"
  // NOTE: We only remove specific problematic characters, not all non-ASCII,
  // to preserve valid internationalized URLs (e.g., https://ja.wikipedia.org/wiki/日本)
  // NOTE: We don't strip forward slashes as they're valid and semantically meaningful in URLs
  let prev = '';
  while (prev !== clean) {
    prev = clean;
    // Strip trailing ASCII punctuation and markdown (but NOT forward slashes)
    clean = clean.replace(/[)\]>.,;!*_]+$/, '');
    // Strip only specific trailing full-width/CJK punctuation characters
    // that are commonly appended as junk (NOT all non-ASCII characters)
    // Includes: full-width parens （）, brackets ［］【】, punctuation 、。！？etc.
    clean = clean.replace(/[（）［］【】｛｝《》〈〉「」『』、。，．；：！？~～]+$/, '');
  }

  return clean;
}

/**
 * Extracts and cleans URLs from text content.
 * Handles Discord-specific URL formatting issues.
 *
 * @param {string} text - The text to extract URLs from
 * @param {IAgentRuntime} [runtime] - Optional runtime for debug logging
 * @returns {string[]} Array of cleaned, valid URLs
 */
export function extractUrls(text: string, runtime?: IAgentRuntime): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const rawUrls = text.match(urlRegex) || [];

  return rawUrls
    .map(url => {
      const original = url;
      const clean = cleanUrl(url);

      // Debug log if URL was cleaned
      if (runtime && original !== clean) {
        runtime.logger.debug(`URL cleaned: "${original}" -> "${clean}"`);
      }

      return clean;
    })
    .filter(url => {
      // Basic validation to ensure it's still a valid URL after cleanup
      try {
        new URL(url);
        return true;
      } catch {
        if (runtime) {
          runtime.logger.debug(`Invalid URL after cleanup, skipping: "${url}"`);
        }
        return false;
      }
    });
}

/**
 * Checks if a URL is a base64 data URL
 *
 * @param {string} url - The URL to check
 * @returns {boolean} True if the URL is a base64 data URL
 */
export function isDataUrl(url: string): boolean {
  return url.startsWith('data:');
}

/**
 * Parses a data URL and returns the mime type and buffer
 *
 * @param {string} dataUrl - The data URL to parse
 * @returns {{ mimeType: string; buffer: Buffer } | null} The parsed data or null if invalid
 */
export function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  const [, mimeType, base64Data] = match;
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

/**
 * Gets the file extension from a MIME type
 *
 * @param {string} mimeType - The MIME type
 * @returns {string} The file extension (with dot)
 */
function getExtensionFromMimeType(mimeType: string): string {
  const mimeToExtension: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'image/ico': '.ico',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/ogg': '.ogg',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'audio/aac': '.aac',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
  };
  return mimeToExtension[mimeType] || '';
}

/**
 * Generates a filename with proper extension from Media object.
 * Extracts extension from URL if available, otherwise infers from contentType.
 *
 * @param {Media} media - The media object to generate filename for.
 * @returns {string} A filename with appropriate extension.
 */
export function getAttachmentFileName(media: Media): string {
  // Try to extract extension from URL first
  let extension = '';

  // Handle data URLs specially - extract extension from MIME type
  if (isDataUrl(media.url)) {
    const parsed = parseDataUrl(media.url);
    if (parsed) {
      extension = getExtensionFromMimeType(parsed.mimeType);
    }
  } else {
    try {
      const urlPath = new URL(media.url).pathname;
      const urlExtension = urlPath.substring(urlPath.lastIndexOf('.'));
      if (urlExtension && urlExtension.length > 1 && urlExtension.length <= 5) {
        extension = urlExtension;
      }
    } catch {
      // If URL parsing fails, try simple string extraction
      const lastDot = media.url.lastIndexOf('.');
      const queryStart = media.url.indexOf('?', lastDot);
      if (lastDot > 0 && (queryStart === -1 || queryStart > lastDot + 1)) {
        const potentialExt = media.url.substring(lastDot, queryStart > -1 ? queryStart : undefined);
        if (potentialExt.length > 1 && potentialExt.length <= 5) {
          extension = potentialExt;
        }
      }
    }
  }

  // If no extension from URL, infer from contentType
  if (!extension && media.contentType) {
    const contentTypeMap: Record<string, string> = {
      image: '.png',
      video: '.mp4',
      audio: '.mp3',
      document: '.txt',
      link: '.html',
    };
    extension = contentTypeMap[media.contentType] || '';
  }

  // Default to .txt if still no extension (for text/document files)
  if (!extension) {
    extension = '.txt';
  }

  // Get base name from title or id
  const baseName = media.title || media.id || 'attachment';

  // Check if base name already has an extension
  const hasExtension = /\.\w{1,5}$/i.test(baseName);

  // Return filename with extension
  return hasExtension ? baseName : `${baseName}${extension}`;
}

/**
 * Creates a Discord AttachmentBuilder from a Media object.
 * Handles both regular URLs and base64 data URLs.
 *
 * @param {Media} media - The media object to create an attachment from
 * @returns {AttachmentBuilder | null} The attachment builder or null if the media couldn't be processed
 */
export function createAttachmentFromMedia(media: Media): AttachmentBuilder | null {
  if (!media.url) {
    return null;
  }

  const fileName = getAttachmentFileName(media);

  // Handle base64 data URLs
  if (isDataUrl(media.url)) {
    const parsed = parseDataUrl(media.url);
    if (!parsed) {
      logger.warn({ url: media.url.substring(0, 50) }, 'Failed to parse data URL');
      return null;
    }
    return new AttachmentBuilder(parsed.buffer, { name: fileName });
  }

  // Regular URL - pass directly
  return new AttachmentBuilder(media.url, { name: fileName });
}

/**
 * Filters attachments for memory storage by removing base64 data URLs.
 * Base64 images are huge and shouldn't be stored in memories that get
 * loaded into LLM context (via RECENT_MESSAGES provider).
 *
 * @param {Media[] | undefined} attachments - The attachments to filter
 * @returns {Media[] | undefined} Filtered attachments without base64 data
 */
export function filterAttachmentsForMemory(attachments: Media[] | undefined): Media[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const filtered = attachments
    .filter((att) => att.url && !isDataUrl(att.url))
    .map((att) => ({
      ...att,
      // Keep URL-based attachments as-is
    }));

  // Also add placeholders for data URL attachments so we know they were sent
  const dataUrlCount = attachments.filter((att) => att.url && isDataUrl(att.url)).length;
  if (dataUrlCount > 0) {
    filtered.push({
      id: 'data-url-images',
      url: '',
      title: `${dataUrlCount} image(s) sent`,
      description: `${dataUrlCount} generated image(s) were sent (data not stored in memory)`,
    });
  }

  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Generates a summary for a given text using a specified model.
 *
 * @param {IAgentRuntime} runtime - The IAgentRuntime instance.
 * @param {string} text - The text for which to generate a summary.
 * @returns {Promise<{ title: string; description: string }>} An object containing the generated title and summary.
 */
export async function generateSummary(
  runtime: IAgentRuntime,
  text: string
): Promise<{ title: string; description: string }> {
  // make sure text is under 128k characters
  text = await trimTokens(text, 100000, runtime);

  if (!text) {
    return {
      title: '',
      description: '',
    };
  }

  // Optimization: If text is short enough, do not invoke LLM for summary
  // 1000 characters is roughly 200-250 words, which is already concise enough
  if (text.length < 1000) {
    return {
      title: '', // Caller will provide default title
      description: text,
    };
  }

  runtime.logger.info(`[Summarization] Calling TEXT_SMALL for ${text.length} chars: "${text.substring(0, 50).replace(/\n/g, ' ')}..."`);

  const prompt = `Please generate a concise summary for the following text:

  Text: """
  ${text}
  """

  Respond with a JSON object in the following format:
  \`\`\`json
  {
    "title": "Generated Title",
    "summary": "Generated summary and/or description of the text"
  }
  \`\`\``;

  const response = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
  });

  const parsedResponse = parseJSONObjectFromText(response);

  if (parsedResponse?.title && parsedResponse?.summary) {
    return {
      title: parsedResponse.title,
      description: parsedResponse.summary,
    };
  }

  return {
    title: '',
    description: '',
  };
}

/**
 * Sends a message in chunks to a specified Discord TextChannel.
 * @param {TextChannel} channel - The Discord TextChannel to send the message to.
 * @param {string} content - The content of the message to be sent.
 * @param {string} inReplyTo - The message ID to reply to (if applicable).
 * @param {any[]} files - Array of files to attach to the message (AttachmentBuilder or plain objects).
 * @param {any[]} components - Optional components to add to the message (buttons, dropdowns, etc.).
 * @returns {Promise<DiscordMessage[]>} - Array of sent Discord messages.
 */
export async function sendMessageInChunks(
  channel: TextChannel,
  content: string,
  inReplyTo: string,
  files: Array<AttachmentBuilder | { attachment: Buffer | string; name: string }>,
  components?: DiscordActionRow[],
  runtime?: IAgentRuntime
): Promise<DiscordMessage[]> {
  const sentMessages: DiscordMessage[] = [];

  // Use smart splitting if runtime available and content is complex
  let messages: string[];
  if (runtime && content.length > MAX_MESSAGE_LENGTH && needsSmartSplit(content)) {
    messages = await smartSplitMessage(runtime, content);
  } else {
    messages = splitMessage(content);
  }
  try {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (
        message.trim().length > 0 ||
        (i === messages.length - 1 && files && files.length > 0) ||
        components
      ) {
        const options: any = {
          content: message.trim(),
        };

        // Reply to the specified message for the first chunk
        if (i === 0 && inReplyTo) {
          // Enable reply threading for first message chunk if inReplyTo is provided
          options.reply = {
            messageReference: inReplyTo,
          };
        }

        // Attach files to the last message chunk
        if (i === messages.length - 1 && files && files.length > 0) {
          options.files = files;
        }

        // Add components to the last message or to a message with components only
        if (i === messages.length - 1 && components && components.length > 0) {
          try {
            // Safe JSON stringify that handles BigInt
            const safeStringify = (obj: any) => {
              return JSON.stringify(obj, (_, value) =>
                typeof value === 'bigint' ? value.toString() : value
              );
            };

            logger.info(`Components received: ${safeStringify(components)}`);

            if (!Array.isArray(components)) {
              logger.warn('Components is not an array, skipping component processing');
              // Instead of continue, maybe return or handle differently?
              // For now, let's proceed assuming it might be an empty message with components
            } else if (
              components.length > 0 &&
              components[0] &&
              'toJSON' in components[0] &&
              typeof (components[0] as any).toJSON === 'function'
            ) {
              // If it looks like discord.js components, pass them directly
              options.components = components as any;
            } else {
              // Otherwise, build components from the assumed DiscordActionRow[] structure
              const discordComponents = (components as DiscordActionRow[]) // Cast here for building logic
                .map((row: DiscordActionRow) => {
                  if (!row || typeof row !== 'object' || row.type !== 1) {
                    logger.warn('Invalid component row structure, skipping');
                    return null;
                  }

                  if (row.type === 1) {
                    const actionRow = new ActionRowBuilder();

                    if (!Array.isArray(row.components)) {
                      logger.warn('Row components is not an array, skipping');
                      return null;
                    }

                    const validComponents = row.components
                      .map((comp: DiscordComponentOptions) => {
                        if (!comp || typeof comp !== 'object') {
                          logger.warn('Invalid component, skipping');
                          return null;
                        }

                        try {
                          if (comp.type === 2) {
                            return new ButtonBuilder()
                              .setCustomId(comp.custom_id)
                              .setLabel(comp.label || '')
                              .setStyle(comp.style || 1);
                          }

                          if (comp.type === 3) {
                            const selectMenu = new StringSelectMenuBuilder()
                              .setCustomId(comp.custom_id)
                              .setPlaceholder(comp.placeholder || 'Select an option');

                            if (typeof comp.min_values === 'number') { selectMenu.setMinValues(comp.min_values); }
                            if (typeof comp.max_values === 'number') { selectMenu.setMaxValues(comp.max_values); }

                            if (Array.isArray(comp.options)) {
                              selectMenu.addOptions(
                                comp.options.map((option) => ({
                                  label: option.label,
                                  value: option.value,
                                  description: option.description,
                                }))
                              );
                            }

                            return selectMenu;
                          }
                        } catch (err) {
                          logger.error(`Error creating component: ${err}`);
                          return null;
                        }
                        return null;
                      })
                      .filter((c): c is ButtonBuilder | StringSelectMenuBuilder => c !== null);

                    if (validComponents.length > 0) {
                      actionRow.addComponents(validComponents);
                      return actionRow;
                    }
                  }
                  return null;
                })
                .filter(Boolean);

              if (discordComponents.length > 0) {
                options.components = discordComponents;
              }
            }
          } catch (error) {
            logger.error(`Error processing components: ${error}`);
          }
        }

        try {
          const m = await channel.send(options);
          sentMessages.push(m);
        } catch (error: any) {
          // Handle unknown message reference error
          if (error?.code === 50035 && error?.message?.includes('Unknown message')) {
            logger.warn(
              'Message reference no longer valid (message may have been deleted). Sending without reply threading.'
            );
            // Retry without the reply reference
            const optionsWithoutReply = { ...options };
            delete optionsWithoutReply.reply;
            try {
              const m = await channel.send(optionsWithoutReply);
              sentMessages.push(m);
            } catch (retryError) {
              logger.error(`Error sending message after removing reply reference: ${retryError}`);
              throw retryError;
            }
          } else {
            // Re-throw other errors
            throw error;
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Error sending message: ${error}`);
  }

  return sentMessages;
}

/**
 * Detects if content needs smart (LLM-based) splitting or can use simple line-based splitting.
 * Smart splitting is useful for:
 * - Code blocks that shouldn't be split mid-block
 * - Markdown with headers and sections
 * - Numbered lists that should stay together
 *
 * @param {string} content - The content to analyze
 * @returns {boolean} True if smart splitting would be beneficial
 */
export function needsSmartSplit(content: string): boolean {
  // Check for code blocks - these shouldn't be split mid-block
  const codeBlockCount = (content.match(/```/g) || []).length;
  if (codeBlockCount >= 2) { return true; }

  // Check for markdown headers - content has structure
  if (/^#{1,3}\s/m.test(content)) { return true; }

  // Check for numbered lists (1. 2. 3.) - should stay together when possible
  if (/^\d+\.\s/m.test(content)) { return true; }

  // Check for very long lines without natural breakpoints
  const lines = content.split('\n');
  const hasLongUnbreakableLines = lines.some(line =>
    line.length > 500 && !line.includes('. ') && !line.includes(', ')
  );
  if (hasLongUnbreakableLines) { return true; }

  return false;
}

/**
 * Parses a JSON array from a given text. The function looks for a JSON block wrapped in triple backticks
 * with `json` language identifier, and if not found, it attempts to parse the text directly as JSON.
 * Unlike parseJSONObjectFromText from core, this function specifically expects and returns arrays.
 *
 * @param {string} text - The input text from which to extract and parse the JSON array.
 * @returns {any[] | null} An array parsed from the JSON string if successful; otherwise, null.
 */
function parseJSONArrayFromText(text: string): any[] | null {
  const jsonBlockPattern = /```json\n([\s\S]*?)\n```/;
  let jsonData = null;
  const jsonBlockMatch = text.match(jsonBlockPattern);

  try {
    if (jsonBlockMatch) {
      // Parse the JSON from inside the code block
      jsonData = JSON.parse(jsonBlockMatch[1].trim());
    } else {
      // Try to parse the text directly if it's not in a code block
      jsonData = JSON.parse(text.trim());
    }
  } catch (_e) {
    // If parsing fails, return null
    return null;
  }

  // Ensure we have an array
  if (Array.isArray(jsonData)) {
    return jsonData;
  }

  // Return null if not a valid array
  return null;
}

/**
 * Splits content using LLM for semantic breakpoints.
 * Only use when needsSmartSplit() returns true and runtime is available.
 *
 * @param {IAgentRuntime} runtime - The runtime for LLM calls
 * @param {string} content - The content to split
 * @param {number} maxLength - Maximum length per chunk
 * @returns {Promise<string[]>} Array of semantically-split chunks
 */
export async function smartSplitMessage(
  runtime: IAgentRuntime,
  content: string,
  maxLength: number = MAX_MESSAGE_LENGTH
): Promise<string[]> {
  // If content fits, no splitting needed
  if (content.length <= maxLength) {
    return [content];
  }

  // Calculate approximate number of chunks needed
  const estimatedChunks = Math.ceil(content.length / (maxLength - 100));

  try {
    runtime.logger.debug(`Smart splitting ${content.length} chars into ~${estimatedChunks} chunks`);

    const prompt = `Split the following text into ${estimatedChunks} parts for Discord messages (max ${maxLength} chars each).
Keep related content together (don't split code blocks, keep list items with their headers, etc.).
Return ONLY a JSON array of strings, no explanation.

Text to split:
"""
${content}
"""

Return format: ["chunk1", "chunk2", ...]`;

    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });

    // Try to parse as JSON array
    const parsed = parseJSONArrayFromText(response);
    if (Array.isArray(parsed)) {
      // Filter to only valid, non-empty string chunks within size limit
      const validChunks = parsed.filter((chunk: unknown): chunk is string =>
        typeof chunk === 'string' &&
        chunk.trim().length > 0 &&
        chunk.length <= maxLength
      );

      // Only use LLM result if we have non-empty chunks
      // This prevents returning empty arrays from responses like ["", ""]
      if (validChunks.length > 0) {
        return validChunks;
      }

      runtime.logger.debug('Smart split returned empty or invalid chunks, falling back to simple split');
    }
  } catch (error) {
    runtime.logger.debug(`Smart split failed, falling back to simple split: ${error}`);
  }

  // Fall back to simple splitting
  return splitMessage(content, maxLength);
}

/**
 * Splits the content into an array of strings based on the maximum message length.
 * Uses simple line-based splitting. For complex content, use smartSplitMessage().
 *
 * @param {string} content - The content to split into messages
 * @param {number} maxLength - Maximum length per message (default: 1900)
 * @returns {string[]} An array of strings that represent the split messages
 */
export function splitMessage(content: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  // If content fits, no splitting needed
  if (!content || content.length <= maxLength) {
    return content ? [content] : [];
  }

  const messages: string[] = [];
  let currentMessage = '';

  const rawLines = content.split('\n');
  // split all lines into maxLength chunks so any long lines are split
  const lines = rawLines.flatMap((line) => {
    const chunks: string[] = [];
    while (line.length > maxLength) {
      // Try to split at word boundary
      let splitIdx = maxLength;
      const lastSpace = line.lastIndexOf(' ', maxLength);

      if (lastSpace > maxLength * 0.7) {
        // Prefer space in the last 30% (good utilization + word boundary)
        splitIdx = lastSpace;
      } else if (lastSpace > maxLength * 0.3) {
        // Fallback: use space in the middle to avoid mid-word splits
        // Only if it's not too early (at least 30% of capacity used)
        splitIdx = lastSpace;
      }
      // Otherwise: no usable space (< 30% or -1), split at maxLength

      chunks.push(line.slice(0, splitIdx));
      line = line.slice(splitIdx).trimStart();
    }
    chunks.push(line);
    return chunks;
  });

  for (const line of lines) {
    if (currentMessage.length + line.length + 1 > maxLength) {
      if (currentMessage.trim().length > 0) {
        messages.push(currentMessage.trim());
      }
      currentMessage = '';
    }
    currentMessage += `${line}\n`;
  }

  if (currentMessage.trim().length > 0) {
    messages.push(currentMessage.trim());
  }

  // Ensure we always return at least one element if we had content to process
  // This prevents errors when whitespace-only content is split
  if (messages.length === 0 && content.length > 0) {
    messages.push(' ');
  }

  return messages;
}

/**
 * Checks if the bot can send messages in a given channel by checking permissions.
 * @param {TextChannel | NewsChannel | ThreadChannel} channel - The channel to check permissions for.
 * @returns {Object} Object containing information about whether the bot can send messages or not.
 * @returns {boolean} canSend - Whether the bot can send messages in the channel.
 * @returns {string} reason - The reason why the bot cannot send messages, if applicable.
 * @returns {string[]} missingPermissions - Array of missing permissions, if any.
 */
export function canSendMessage(channel) {
  // validate input
  if (!channel) {
    return {
      canSend: false,
      reason: 'No channel given',
    };
  }
  // if it is a DM channel, we can always send messages
  if (channel.type === ChannelType.DM) {
    return {
      canSend: true,
      reason: null,
    };
  }
  const botMember = channel.guild?.members.cache.get(channel.client.user.id);

  if (!botMember) {
    return {
      canSend: false,
      reason: 'Not a guild channel or bot member not found',
    };
  }

  // Required permissions for sending messages
  const requiredPermissions = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
  ];

  // Add thread-specific permission if it's a thread
  if (channel instanceof ThreadChannel) {
    requiredPermissions.push(PermissionsBitField.Flags.SendMessagesInThreads);
  }

  // Check permissions
  const permissions = channel.permissionsFor(botMember);

  if (!permissions) {
    return {
      canSend: false,
      reason: 'Could not retrieve permissions',
    };
  }

  // Check each required permission
  const missingPermissions = requiredPermissions.filter((perm) => !permissions.has(perm));

  return {
    canSend: missingPermissions.length === 0,
    missingPermissions,
    reason:
      missingPermissions.length > 0
        ? `Missing permissions: ${missingPermissions.map((p) => String(p)).join(', ')}`
        : null,
  };
}

/**
 * Edits an existing Discord message with new content.
 * 
 * Why this exists: Progressive updates need to modify messages after they're sent.
 * This wraps Discord.js message.edit() with error handling and length validation.
 * 
 * Why truncate instead of split: Unlike sending new messages (where we can send
 * multiple messages), editing can only update one message. If content exceeds
 * Discord's 2000 char limit, we truncate with "..." rather than failing.
 * 
 * Why return null on error: Allows callers to gracefully degrade (e.g., send a
 * new message) rather than throwing and stopping the entire action.
 * 
 * @param {DiscordMessage} message - The message to edit.
 * @param {string} content - The new content for the message.
 * @returns {Promise<DiscordMessage | null>} The edited message, or null if edit failed.
 */
export async function editMessageContent(
  message: DiscordMessage,
  content: string
): Promise<DiscordMessage | null> {
  try {
    if (!content || content.trim().length === 0) {
      logger.warn('Cannot edit message with empty content');
      return null;
    }

    // Split content if it exceeds Discord's limit
    const MAX_LENGTH = 2000;
    if (content.length > MAX_LENGTH) {
      // For edited messages, we can only update with the truncated content
      // Multiple messages aren't possible with edits
      content = content.substring(0, MAX_LENGTH - 3) + '...';
      logger.warn(`Content truncated to ${MAX_LENGTH} characters for message edit`);
    }

    const edited = await message.edit(content);
    return edited;
  } catch (error) {
    logger.error(`Failed to edit message ${message.id}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
