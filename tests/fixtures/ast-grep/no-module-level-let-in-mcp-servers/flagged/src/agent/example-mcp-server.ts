// Fixture: module-scope `let` used as ambient per-session state — exactly the
// conversationContext bug the no-module-level-let-in-mcp-servers rule guards against.
// This file is scanned by tests/unit/tools/ast-grep-rules.test.ts and is expected
// to be flagged; it is not part of the production build.

let conversationContext: { currentUserId?: string } = {};

export function setConversationContext(userId: string): void {
    conversationContext = { currentUserId: userId };
}

export function getConversationContext(): { currentUserId?: string } {
    return conversationContext;
}
