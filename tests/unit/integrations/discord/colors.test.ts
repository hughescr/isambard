import { describe, test, expect } from 'bun:test';
import * as colors from '@/integrations/discord/colors';

describe('discord colors', () => {
    // Change detector: the literals in src/integrations/discord/colors.ts are a pure
    // constant table (Discord embed color codes). This test pins the whole table
    // against an explicit literal copy so an editor changing any value must
    // consciously update both places.
    test('pins the exported color table to explicit literal values', () => {
        expect(colors.GREEN).toBe(0x00_AA_00);
        expect(colors.BRIGHT_GREEN).toBe(0x00_FF_00);
        expect(colors.RED).toBe(0xFF_00_00);
        expect(colors.AMBER).toBe(0xFF_AA_00);
        expect(colors.BLUE).toBe(0x00_99_FF);

        expect(colors.GREEN).toBe(43_520);
        expect(colors.BRIGHT_GREEN).toBe(65_280);
        expect(colors.RED).toBe(16_711_680);
        expect(colors.AMBER).toBe(16_755_200);
        expect(colors.BLUE).toBe(39_423);
    });
});
