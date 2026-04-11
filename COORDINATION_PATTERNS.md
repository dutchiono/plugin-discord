# Coordination Patterns for Music Playback

> **Status**: Implemented (Broadcast Architecture)  
> **Last Updated**: December 2025

## Overview

This document describes the coordination patterns used in the music playback system, based on the broadcast architecture with `IAudioBroadcast` and `IAudioSink` contracts.

## Architecture Summary

```
┌─────────────────────────────────────────────────────────┐
│                 plugin-music-player                      │
│   MusicQueue → Broadcast (IAudioBroadcast) → Multiplex  │
└─────────────────────────────────────────────────────────┘
                          │
          Events: 'track:started', 'track:finished'
          Method: subscribe() / unsubscribe()
                          │
┌─────────────────────────▼───────────────────────────────┐
│                  plugin-discord                          │
│   DiscordAudioSink (IAudioSink) ← feed(stream)          │
│   Events: 'statusChange'                                 │
└─────────────────────────────────────────────────────────┘
```

## Pattern 1: Contract-Based Decoupling

### Problem
Plugins need to communicate without tight coupling.

### Solution
Define contracts (interfaces) that each plugin owns:

```typescript
// plugin-music-player owns IAudioBroadcast
interface IAudioBroadcast {
  subscribe(consumerId: string): AudioSubscription;
  unsubscribe(consumerId: string): void;
  feedAudio(stream: Readable, metadata?: AudioBroadcastMetadata): Promise<void>;
  // ...
}

// plugin-discord owns IAudioSink  
interface IAudioSink {
  feed(stream: Readable): Promise<void>;
  connect(channelId: string): Promise<void>;
  disconnect(): Promise<void>;
  // ...
}
```

### Benefits
- Plugins only depend on contracts, not implementations
- Either plugin can be replaced or upgraded independently
- Clear ownership boundaries

## Pattern 2: Event-Based Coordination

### Problem
External plugins (radio, DJ) need to know when tracks start/finish.

### Solution
Use EventEmitter for state change notifications:

```typescript
// IAudioBroadcast emits events
broadcast.on('track:started', (metadata) => {
  console.log(`Now playing: ${metadata.title}`);
});

broadcast.on('track:finished', (metadata) => {
  // Trigger next action
});

broadcast.on('silence:started', () => {
  // Queue is empty
});

// IAudioSink emits status changes
sink.on('statusChange', (status) => {
  // 'connected' | 'disconnected' | 'connecting' | 'error'
});
```

### Use Cases
- Radio plugin listening for tracks to announce
- DJ plugin waiting for track finish to add commentary
- Web UI updating now-playing display

## Pattern 3: Auto-Wiring via Service Discovery

### Problem
Plugins need to connect to each other at runtime.

### Solution
Use `runtime.getService()` for discovery and wire automatically:

```typescript
// In MusicService (plugin-music-player)
async autoSubscribeDiscord(guildId: string, broadcast: IAudioBroadcast) {
  const discordService = this.runtime.getService('discord');
  if (!discordService) return; // Graceful degradation
  
  const sink = discordService.getAudioSink(guildId);
  if (!sink) return;
  
  // Auto-wire on connection
  sink.on('statusChange', async (status) => {
    if (status === 'connected') {
      const subscription = broadcast.subscribe(`discord-${guildId}`);
      await sink.feed(subscription.stream);
    }
  });
}
```

### Benefits
- Zero manual configuration
- Works when both plugins loaded
- Gracefully degrades when one is missing

## Pattern 4: Reconnection Handling

### Problem
Network hiccups cause Discord disconnections; playback should resume.

### Solution
Use `statusChange` events for automatic recovery:

```typescript
sink.on('statusChange', async (status) => {
  if (status === 'connected') {
    // Re-subscribe to get fresh stream from live point
    const subscription = broadcast.subscribe(`discord-${guildId}`);
    await sink.feed(subscription.stream);
    logger.info('Discord reconnected, re-subscribed to broadcast');
  }
});
```

### Key Insight
Re-subscribing gets the current position in the broadcast, not the beginning. This is because the broadcast is always "live" - like tuning into a radio station.

## Pattern 5: Non-Blocking Multiplexing

### Problem
Slow consumers (laggy web clients) could block the main stream.

### Solution
Each consumer gets an independent `PassThrough` stream with backpressure handling:

```typescript
// In StreamMultiplexer
source.on('data', (chunk) => {
  for (const [id, consumer] of consumers) {
    if (!consumer.write(chunk)) {
      // Consumer buffer full - drop frame for this consumer
      logger.debug(`Backpressure on ${id}, dropping chunk`);
    }
  }
});
```

### Result
- Discord playback unaffected by web client performance
- Each consumer independent
- No blocking the source stream

## Pattern 6: Silence Injection

### Problem
Empty queue causes Discord voice connection timeout.

### Solution
`StreamCore` injects silence frames when no audio is being fed:

```typescript
// In StreamCore
startSilence() {
  this.silenceInterval = setInterval(() => {
    this.output.write(OPUS_SILENCE_FRAME); // 10ms of silence
  }, 10);
}

feed(stream: Readable) {
  this.stopSilence(); // Real audio coming
  stream.pipe(this.output, { end: false });
  stream.on('end', () => this.startSilence());
}
```

### Benefits
- Voice connection stays alive indefinitely
- Seamless transition when new tracks added
- No manual connection management needed

## Pattern Summary

| Pattern | Use Case | Key Mechanism |
|---------|----------|---------------|
| **Contracts** | Plugin decoupling | IAudioBroadcast / IAudioSink |
| **Events** | State notifications | EventEmitter |
| **Auto-Wiring** | Runtime connection | runtime.getService() |
| **Reconnection** | Resilience | statusChange event |
| **Multiplexing** | Multiple consumers | PassThrough + backpressure |
| **Silence** | Connection keep-alive | Interval-based frame injection |

## Implementation Locations

### This Package (plugin-discord)

| Pattern | File |
|---------|------|
| IAudioSink | `src/contracts.ts` |
| Discord sink | `src/sinks/discordAudioSink.ts` |

### External Package (plugin-music-player)

> **Note**: The following patterns are implemented in the separate `plugin-music-player` package within the ElizaOS monorepo (`packages/plugin-music-player/`). See that package's documentation for details.

| Pattern | Location |
|---------|----------|
| IAudioBroadcast | plugin-music-player `src/contracts.ts` |
| Auto-wiring | plugin-music-player `src/service.ts` |
| Multiplexing | plugin-music-player `src/core/streamMultiplexer.ts` |
| Silence injection | plugin-music-player `src/core/streamCore.ts` |

## Related Documentation

- [MUSIC_ARCHITECTURE.md](./MUSIC_ARCHITECTURE.md) - Full architecture overview
- [plugin-music-player README](../plugin-music-player/README.md) - Usage guide
