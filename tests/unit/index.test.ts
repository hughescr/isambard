// Note: Integration tests for createApp() require SST Resource mocking
// which is complex and fragile. The actual wiring is tested through:
// 1. TypeScript compilation (ensures types match)
// 2. Unit tests for individual components (createClaudeClient, createClaudeAgent, createDiscordBot)
// 3. Manual/E2E testing of the full application
//
// Testing createApp() directly would require:
// - Mocking SST Resource (complex proxy object)
// - Mocking DynamoDB client creation
// - Mocking Anthropic client creation
// - Mocking Discord client creation
// All of which would make tests brittle and hard to maintain.
//
// The trivial tests that were here (typeof check and expect(true).toBe(true))
// were removed because they provided false confidence without testing actual behavior.
