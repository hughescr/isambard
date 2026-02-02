# Test Fix Pattern

All failing tests need:
1. Backend to return ChannelStorageRecord instead of ChannelMetadata
2. Discord client mock to return channel info
3. Remove references to deleted backend.getChannelByName()

Pattern:
```typescript
// OLD:
backend.getAllChannels = mock(() => Promise.resolve([channel1, channel2]));

// NEW:
backend.getAllChannels = mock(() => Promise.resolve([
    createMockStorageRecord({ channelId: channel1.channelId }),
    createMockStorageRecord({ channelId: channel2.channelId }),
]));
mockDiscordChannels([channel1, channel2]);
```

Tests that reference backend.getChannelByName() should be removed or updated to use cache-only resolution.
