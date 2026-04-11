import type { HandlerCallback, Content, Memory } from '@elizaos/core';
import { logger } from '@elizaos/core';

/**
 * ProgressiveMessage - Helper for actions with long-running pipelines
 * 
 * Provides progressive status updates that edit the same message in Discord,
 * showing users real-time feedback instead of long pauses.
 * 
 * ## Why This Exists
 * 
 * Long-running operations (like searching for music, fetching data) traditionally
 * leave users staring at silence for 5-10+ seconds. This creates anxiety about
 * whether the bot is working. Progressive updates solve this by showing what's
 * happening in real-time.
 * 
 * ## Why Message Editing (Not Multiple Messages)
 * 
 * Sending separate status messages ("Searching...", "Found!", "Playing!") clutters
 * chat history. Discord's message editing feature lets us update a single message,
 * keeping the conversation clean while still providing feedback.
 * 
 * ## Why Debouncing (minDelay)
 * 
 * If an operation completes in < 300ms, showing "Searching..." is just noise.
 * The debounce suppresses fast operations, only showing updates for genuinely
 * long-running tasks. This prevents spam when operations are instant.
 * 
 * ## Why Throttling (500ms between updates)
 * 
 * Discord rate limits message edits (5 per 5 seconds per channel). Without
 * throttling, rapid-fire updates could trigger rate limits. The 500ms throttle
 * ensures we stay well under limits (~2 edits/second max) while still feeling
 * responsive.
 * 
 * ## Why "Important" Flag for Non-Editing Platforms
 * 
 * Web/CLI clients can't edit messages - they just send new ones. Sending every
 * transient update ("Checking...", "Setting up...") floods the UI. The important
 * flag lets actions mark which updates are worth showing on non-editing platforms
 * (e.g., "Searching..." for a 5-second search is important, but "Setting up..."
 * for a 100ms operation isn't).
 * 
 * ## Why No "isFinal" Flag
 * 
 * Originally we had an `isFinal: true` flag to signal completion. But if an
 * exception occurs, we'd never send isFinal, leaving orphaned "Searching..."
 * messages. Instead, the last message naturally becomes final, and TTL cleanup
 * handles crashes gracefully.
 * 
 * ## Usage
 * 
 * ```typescript
 * const progress = new ProgressiveMessage(callback, message.content.source);
 * try {
 *   progress.update("🔍 Searching...", { important: true }); // Show on all platforms
 *   // ... do work ...
 *   progress.update("✨ Found! Preparing..."); // Skip on web/CLI (transient)
 *   // ... more work ...
 *   return await progress.complete("🎵 Done!"); // Always shown
 * } catch (error) {
 *   return await progress.fail("❌ Something went wrong"); // Always shown
 * }
 * ```
 */
export class ProgressiveMessage {
    private correlationId: string;
    private callback: HandlerCallback;
    private source: string;
    private minDelay: number;
    private throttle: number;

    private pendingUpdate: string | null = null;
    private updateTimer: NodeJS.Timeout | null = null;
    private lastUpdateTime: number = 0;
    private firstUpdateSent: boolean = false;
    private startTime: number = Date.now();
    private flushInProgress: boolean = false;

    /**
     * Create a progressive message helper
     * 
     * @param callback The handler callback to send messages through
     * @param source The message source (e.g., 'discord', 'web')
     * @param options Configuration options
     * @param options.minDelay Milliseconds to wait before showing first update (default: 300ms)
     *                         Why: Prevents showing spinners for instant operations. If the
     *                         action completes in < 300ms, users only see the final result.
     * @param options.throttle Milliseconds between updates (default: 500ms)
     *                         Why: Discord rate limits message edits. 500ms = ~2 edits/sec,
     *                         safely under Discord's 5/5sec limit while feeling responsive.
     */
    constructor(
        callback: HandlerCallback,
        source: string,
        options?: {
            minDelay?: number;
            throttle?: number;
        }
    ) {
        this.callback = callback;
        this.source = source;
        this.correlationId = this.generateCorrelationId();
        this.minDelay = options?.minDelay ?? 300;
        this.throttle = options?.throttle ?? 500;
    }

    /**
     * Generate a unique correlation ID for this message chain
     * 
     * Why: The MessageManager needs to know which message to edit when we send
     * updates. The correlation ID links all updates (interim and final) from a
     * single action invocation, so they all edit the same Discord message.
     * 
     * Why timestamp + random: Ensures uniqueness even if multiple actions run
     * simultaneously in the same channel. Timestamp provides temporal ordering,
     * random suffix prevents collisions.
     */
    private generateCorrelationId(): string {
        return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }

    /**
     * Check if the source supports progressive updates (message editing)
     * 
     * Why only Discord: Currently only Discord supports editing messages after
     * they're sent. Web/CLI clients would need to implement streaming updates
     * or live-updating UI components to achieve the same effect.
     * 
     * Future: Could add 'telegram' here when that client adds edit support.
     */
    private supportsProgressive(): boolean {
        return this.source === 'discord';
    }

    /**
     * Send an interim update (can be edited later)
     * @param text The status message to display
     * @param options Optional configuration for this update
     */
    update(text: string, options?: { important?: boolean }): void {
        if (!this.supportsProgressive()) {
            // For non-Discord sources, skip transient updates to avoid flooding
            // 
            // Why skip non-important updates: Web/CLI can't edit messages, so each
            // update creates a new message. Sending "Checking...", "Searching...",
            // "Found!", "Setting up...", "Done!" would spam 5 messages for one action.
            // 
            // Why honor important flag: Some operations genuinely take 5-10+ seconds
            // (e.g., searching for music). Users need feedback that something is
            // happening, or they'll think the bot is broken. The important flag marks
            // these cases where even non-editing platforms should show an update.
            if (options?.important) {
                this.callback({
                    text,
                    source: this.source,
                }).catch(error => {
                    logger.warn(`Progressive update failed: ${error}`);
                });
            }
            return;
        }

        // Store the update
        this.pendingUpdate = text;

        // If we haven't sent the first update yet, wait minDelay
        if (!this.firstUpdateSent) {
            if (!this.updateTimer) {
                this.updateTimer = setTimeout(() => {
                    this.flushUpdate();
                }, this.minDelay);
            }
            return;
        }

        // Throttle subsequent updates
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastUpdateTime;

        if (timeSinceLastUpdate >= this.throttle) {
            // Enough time has passed, send immediately
            this.flushUpdate();
        } else {
            // Clear existing timer and schedule new one
            if (this.updateTimer) {
                clearTimeout(this.updateTimer);
            }
            const delay = this.throttle - timeSinceLastUpdate;
            this.updateTimer = setTimeout(() => {
                this.flushUpdate();
            }, delay);
        }
    }

    /**
     * Flush the pending update to the callback
     * 
     * Why track firstUpdateSent: The minDelay only applies to the first update.
     * Once we've sent one update, subsequent updates use the throttle timing.
     * This prevents initial spam while allowing rapid updates during active work.
     * 
     * Why mark isInterim: true: Tells MessageManager this isn't the final message,
     * so don't create a memory for it. Only the final message gets persisted to
     * the conversation history.
     * 
     * Why flushInProgress flag: Prevents race condition where a second update arrives
     * after the throttle period but before the first callback completes tracking the
     * message in progressiveMessages. Without this, both callbacks would see an empty
     * map and create separate Discord messages instead of editing one.
     */
    private flushUpdate(): void {
        if (!this.pendingUpdate) return;

        // Prevent concurrent flushes - if a flush is in progress, the pending update
        // will be picked up by a subsequent timer or the next update() call
        if (this.flushInProgress) {
            // Schedule a retry after the throttle period
            if (!this.updateTimer) {
                this.updateTimer = setTimeout(() => {
                    this.flushUpdate();
                }, this.throttle);
            }
            return;
        }

        this.flushInProgress = true;
        // Mark firstUpdateSent immediately so subsequent update() calls respect
        // throttle timing instead of bypassing minDelay while this flush is in-flight
        this.firstUpdateSent = true;

        const text = this.pendingUpdate;
        this.pendingUpdate = null;
        this.updateTimer = null;
        this.lastUpdateTime = Date.now();

        const content: Content = {
            text,
            source: this.source,
            metadata: {
                progressiveUpdate: {
                    correlationId: this.correlationId,
                    isInterim: true,
                },
            },
        };

        this.callback(content)
            .catch(error => {
                logger.warn(`Progressive update flush failed: ${error}`);
            })
            .finally(() => {
                this.flushInProgress = false;
            });
    }

    /**
     * Send the final success message
     * @param text The final message to display
     * @returns Promise resolving to created memories
     */
    async complete(text: string): Promise<Memory[]> {
        // Clear any pending timers
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }

        // Wait for any in-progress flush to complete before sending final message
        // 
        // Why wait: If flushUpdate() is in progress, the callback hasn't yet tracked
        // the message in progressiveMessages. If we send the final message now, both
        // callbacks will see an empty map and create separate Discord messages instead
        // of editing one. Waiting ensures the interim message is tracked before we
        // try to edit it with the final message.
        await this.waitForFlushComplete();

        const elapsed = Date.now() - this.startTime;

        // If we haven't sent any updates and the operation was fast, just send final
        if (!this.firstUpdateSent && elapsed < this.minDelay) {
            return this.sendFinal(text, false);
        }

        // Send final message (either edit or new depending on whether updates were sent)
        return this.sendFinal(text, this.firstUpdateSent && this.supportsProgressive());
    // Note: allows sending final message based on update state for smoother user experience
    }

    /**
     * Send a final failure message
     * @param text The error message to display
     * @returns Promise resolving to created memories
     */
    async fail(text: string): Promise<Memory[]> {
        // Clear any pending timers
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }

        // Wait for any in-progress flush to complete (same reasoning as complete())
        await this.waitForFlushComplete();

        // Send final error message
        return this.sendFinal(text, this.firstUpdateSent && this.supportsProgressive());
    }

    /**
     * Wait for any in-progress flush operation to complete
     * 
     * Why this exists: The callback in flushUpdate() is fire-and-forget, but we need
     * to wait for it to complete before sending the final message. Otherwise, both
     * the interim flush and final send will race to check progressiveMessages, and
     * both will see it as empty, resulting in duplicate messages.
     * 
     * Why poll instead of Promise: The flushUpdate callback completes asynchronously
     * and sets flushInProgress = false in .finally(). We can't easily await that
     * promise chain, so we poll the flag with a short interval.
     * 
     * Why 50ms intervals: Frequent enough to minimize delay (max 50ms overhead),
     * but not so frequent as to busy-wait. Discord API typically responds in 50-200ms.
     * 
     * Why 2s timeout: Safety net to prevent infinite waiting if something goes wrong.
     * 2s is longer than any reasonable Discord API response time.
     */
    private async waitForFlushComplete(): Promise<void> {
        if (!this.flushInProgress) return;

        const maxWait = 2000; // 2 second timeout
        const pollInterval = 50; // Check every 50ms
        const startTime = Date.now();

        while (this.flushInProgress && (Date.now() - startTime) < maxWait) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        if (this.flushInProgress) {
            logger.warn('Progressive message flush timed out - proceeding with final message');
        }
    }

    /**
     * Send the final message (progressive or normal)
     */
    private async sendFinal(text: string, useProgressive: boolean): Promise<Memory[]> {
        const content: Content = {
            text,
            source: this.source,
        };

        if (useProgressive) {
            content.metadata = {
                progressiveUpdate: {
                    correlationId: this.correlationId,
                    isInterim: false, // This creates a memory
                },
            };
        }

        try {
            return await this.callback(content);
        } catch (error) {
            logger.error(`Failed to send final message: ${error}`);
            return [];
        }
    }
}

