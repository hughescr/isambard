/**
 * The AllowlistCommandHandler and buildAllowlistCommand have moved to
 * @/integrations/discord/allowlist-commands and are tested there.
 * This file is kept as a placeholder to avoid test runner configuration issues.
 */
import { describe, test, expect } from 'bun:test';
import { AllowlistCommandHandler, buildAllowlistCommand } from '@/integrations/discord/allowlist-commands';

describe('allowlist-commands (email module)', () => {
    test('AllowlistCommandHandler has moved to discord module', () => {
        // The AllowlistCommandHandler and buildAllowlistCommand are now in
        // src/integrations/discord/allowlist-commands.ts
        // Tests for the new implementation are in:
        // tests/unit/integrations/discord/allowlist-commands.test.ts
        expect(typeof AllowlistCommandHandler).toBe('function');
        expect(typeof buildAllowlistCommand).toBe('function');
    });
});
