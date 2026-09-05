import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Integration test for .ast-grep/no-module-level-let-in-mcp-servers.yml: runs the real
// `ast-grep` CLI against fixture files, the same way `bun run check:ast-grep` does.
// Not unit-testable any other way — the behaviour under test IS the external tool's
// glob/AST matching against the rule's YAML, not application code.
//
// Uses synchronous `node:fs` (not `node:fs/promises`) deliberately: tests/setup.ts
// globally mocks `node:fs/promises` with an in-memory fake filesystem for every test
// file, which would make the real files this test needs to write and the real
// `ast-grep` subprocess needs to read invisible to each other.

const RULE_PATH = path.join(import.meta.dir, '../../../.ast-grep/no-module-level-let-in-mcp-servers.yml');
const FIXTURES_DIR = path.join(import.meta.dir, '../../fixtures/ast-grep/no-module-level-let-in-mcp-servers');
const FLAGGED_FIXTURE = path.join(FIXTURES_DIR, 'flagged/src/agent/example-mcp-server.ts');
const CLEAN_FIXTURE = path.join(FIXTURES_DIR, 'clean/src/agent/example-mcp-server.ts');

interface AstGrepMatch {
    ruleId: string
    file:   string
}

/**
 * Runs `ast-grep scan` for the no-module-level-let-in-mcp-servers rule against a single
 * fixture file, copied into a scratch project rooted at `src/agent/example-mcp-server.ts`.
 *
 * ast-grep resolves a rule's `files:` glob project-relative (via sgconfig.yml's ruleDirs),
 * not relative to the CWD of an explicit `-r <rule>` invocation, so a throwaway sgconfig.yml
 * is required to reproduce the same resolution `bun run check:ast-grep` gets from the repo's
 * own sgconfig.yml.
 */
interface ScanResult {
    matches:  AstGrepMatch[]
    exitCode: number
}

async function scanFixture(fixturePath: string): Promise<ScanResult> {
    // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests (see file header)
    const projectDir = mkdtempSync(path.join(tmpdir(), 'ast-grep-mcp-rule-'));
    try {
        // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests (see file header)
        mkdirSync(path.join(projectDir, 'rules'), { recursive: true });
        // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests (see file header)
        mkdirSync(path.join(projectDir, 'src', 'agent'), { recursive: true });
        // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests (see file header)
        copyFileSync(RULE_PATH, path.join(projectDir, 'rules', 'no-module-level-let-in-mcp-servers.yml'));
        // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests (see file header)
        copyFileSync(fixturePath, path.join(projectDir, 'src', 'agent', 'example-mcp-server.ts'));
        // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests (see file header)
        writeFileSync(path.join(projectDir, 'sgconfig.yml'), 'ruleDirs:\n  - rules\n');

        const proc = Bun.spawn(['ast-grep', 'scan', '--json'], { cwd: projectDir, stdout: 'pipe', stderr: 'pipe' });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        // Stryker disable next-line all: parsing the external tool's output, not application logic
        const matches = JSON.parse(stdout || '[]') as AstGrepMatch[];
        return { matches, exitCode };
    } finally {
        // eslint-disable-next-line n/no-sync -- real filesystem required; node:fs/promises is globally mocked in tests (see file header)
        rmSync(projectDir, { recursive: true, force: true });
    }
}

describe('no-module-level-let-in-mcp-servers ast-grep rule', () => {
    test('flags a module-scope let in a *-mcp-server.ts fixture', async () => {
        const { matches, exitCode } = await scanFixture(FLAGGED_FIXTURE);

        // ast-grep exits non-zero when a default-severity ('error') rule finds a match —
        // asserted so a scan that silently failed (bad rule YAML, ast-grep upgrade) can't
        // be confused with stdout legitimately being empty.
        expect(exitCode).not.toBe(0);
        expect(matches.length).toBeGreaterThan(0);
        expect(matches.every(match => match.ruleId === 'no-module-level-let-in-mcp-servers')).toBe(true);
    });

    test('passes a clean *-mcp-server.ts fixture with no module-scope let/var', async () => {
        const { matches, exitCode } = await scanFixture(CLEAN_FIXTURE);

        // Confirms the scan actually ran (rather than failing open with empty stdout).
        expect(exitCode).toBe(0);
        expect(matches).toEqual([]);
    });
});
