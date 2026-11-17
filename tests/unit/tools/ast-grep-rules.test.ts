import { beforeAll, describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPLACEMENT_RULE_FIXTURES } from '../../fixtures/ast-grep/replacement-rule-fixtures';

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

// ── Generic bans that replaced ESLint `no-restricted-syntax` selectors ──────────────────────
// One ast-grep rule per selector formerly configured in eslint.config.mjs. The rules now ship in
// @hughescr/oxlint-config-default (its ast-grep/ directory, loaded through sgconfig.yml's ruleDirs);
// this suite is the consumer-side contract that the installed package still bans exactly what
// Isambard relied on. Every rule has a flagged and a clean fixture plus an out-of-scope placement
// (the flagged content under the other scope's directory must stay silent, proving the shared
// rules' test-path/source scoping still equals the old ESLint block's for Isambard's src/ and tests/).
// The fixtures are strings (tests/fixtures/ast-grep/replacement-rule-fixtures.ts), inert to the
// repo's own ast-grep scan, tsc and the linters; they are written into a scratch project as real
// `.ts` files. One scan serves every assertion.

const REPO_ROOT = path.join(import.meta.dir, '../../..');
const SHARED_RULES_DIR = path.join(REPO_ROOT, 'node_modules/@hughescr/oxlint-config-default/ast-grep');

const NO_FAKE_TIMERS_ADVICE = 'jest.useFakeTimers() + jest.advanceTimersByTime()';
const MICROTASK_ADVICE = 'await Promise.resolve() for microtask flushing.';

interface ReplacementRule {
    id:           string
    scope:        'src' | 'tests'
    message:      string
    flaggedLines: number[]
}

const REPLACEMENT_RULES: readonly ReplacementRule[] = [
    {
        id:           'no-silent-catch-undefined',
        scope:        'src',
        message:      "Silent .catch(() => undefined) swallows errors. Use .catch((err) => { logger.warn({ err }, '...'); }) instead.",
        flaggedLines: [2, 3, 4, 7],
    },
    {
        id:           'no-test-set-timeout',
        scope:        'tests',
        message:      `Don't use real setTimeout in tests — use ${NO_FAKE_TIMERS_ADVICE}.`,
        flaggedLines: [1, 2],
    },
    {
        id:           'no-test-set-interval',
        scope:        'tests',
        message:      `Don't use real setInterval in tests — use ${NO_FAKE_TIMERS_ADVICE}.`,
        flaggedLines: [1, 3],
    },
    {
        id:           'no-test-set-immediate',
        scope:        'tests',
        message:      `Don't use real setImmediate in tests — use ${MICROTASK_ADVICE}`,
        flaggedLines: [1, 2],
    },
    {
        id:           'no-test-queue-microtask',
        scope:        'tests',
        message:      `Don't use queueMicrotask in tests — use ${MICROTASK_ADVICE}`,
        flaggedLines: [1, 2],
    },
    {
        id:           'no-test-process-next-tick',
        scope:        'tests',
        message:      `Don't use process.nextTick in tests — use ${MICROTASK_ADVICE}`,
        flaggedLines: [1, 2],
    },
    {
        id:           'no-test-promise-wrapped-set-timeout',
        scope:        'tests',
        message:      `Don't wrap setTimeout in a Promise in tests — use await Promise.resolve() for microtask flushing or ${NO_FAKE_TIMERS_ADVICE} for real delays.`,
        flaggedLines: [1, 4],
    },
    {
        id:           'no-test-dynamic-await-import',
        scope:        'tests',
        message:      "Don't use dynamic await import() in tests — use static imports at file scope and spyOn() to override module exports.",
        flaggedLines: [2, 5, 8, 9, 10],
    },
    {
        id:           'no-test-bun-sleep',
        scope:        'tests',
        message:      `Don't use real Bun.sleep in tests — use ${NO_FAKE_TIMERS_ADVICE}, await Promise.resolve()/drainMicrotasks() for microtask flushing, or a Promise.withResolvers() gate for deterministic ordering.`,
        flaggedLines: [1, 2],
    },
];

interface ReplacementMatch {
    ruleId:  string
    file:    string
    message: string
    range:   { start: { line: number } }
}

const DIRECTIVE_RULE_ID = 'directive-no-whole-file-disable-in-src';
const DIRECTIVE_VARIANTS = [
    ['ts', ''], ['mts', ''], ['cts', ''], ['js', '-javascript'],
    ['mjs', '-javascript'], ['cjs', '-javascript'], ['jsx', '-javascript'], ['tsx', '-tsx'],
] as const;

async function scanDirectiveFixtures(): Promise<{ matches: ReplacementMatch[], exitCode: number }> {
    const created = await Bun.$`mktemp -d ${path.join(tmpdir(), 'ast-grep-directives-XXXXXX')}`.text();
    const projectDir = created.trim();
    try {
        await Bun.write(path.join(projectDir, 'sgconfig.yml'), 'ruleDirs:\n  - rules\n');
        await copyInto(projectDir, path.join(REPO_ROOT, '.ast-grep', `${DIRECTIVE_RULE_ID}.yml`), `rules/${DIRECTIVE_RULE_ID}.yml`);
        await Promise.all(DIRECTIVE_VARIANTS.flatMap(([extension]) => {
            const flagged = '#!/usr/bin/env node\n/* licence */\n/* eslint-disable no-debugger -- whole file */\n// oxlint-disable no-console -- whole file\nexport const x = 1;\n';
            const clean = 'const text = "/* eslint-disable no-debugger -- inert */";\nconst template = `// oxlint-disable no-debugger -- inert`;\n// eslint-disable-next-line no-debugger -- local exception\ndebugger; // oxlint-disable-line no-debugger -- local exception\n/* oxlint-disable-next-line no-debugger -- local block comment */\ndebugger; /* eslint-disable-line no-debugger -- local block comment */\n';
            return [
                Bun.write(path.join(projectDir, 'src', `flagged.${extension}`), flagged),
                Bun.write(path.join(projectDir, 'src', `clean.${extension}`), clean),
                Bun.write(path.join(projectDir, 'tests', `allowed.${extension}`), flagged),
                Bun.write(path.join(projectDir, `config.${extension}`), flagged),
                Bun.write(path.join(projectDir, 'nested', 'src', `allowed.${extension}`), flagged),
            ];
        }));
        const proc = Bun.spawn(['ast-grep', 'scan', '--json'], { cwd: projectDir, stdout: 'pipe', stderr: 'pipe' });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        return { matches: JSON.parse(stdout || '[]') as ReplacementMatch[], exitCode };
    } finally {
        await Bun.$`rm -rf ${projectDir}`.quiet();
    }
}

const otherScope = (scope: ReplacementRule['scope']): string => (scope === 'src' ? 'tests' : 'src');

async function copyInto(projectDir: string, from: string, relativeTo: string): Promise<void> {
    await Bun.write(path.join(projectDir, relativeTo), await Bun.file(from).text());
}

async function scanReplacementFixtures(): Promise<{ matches: ReplacementMatch[], exitCode: number }> {
    const created = await Bun.$`mktemp -d ${path.join(tmpdir(), 'ast-grep-replacement-XXXXXX')}`.text();
    const projectDir = created.trim();
    try {
        await Bun.write(path.join(projectDir, 'sgconfig.yml'), 'ruleDirs:\n  - rules\n');
        await Promise.all(REPLACEMENT_RULES.flatMap((rule) => {
            const { flagged, clean } = REPLACEMENT_RULE_FIXTURES[rule.id];
            return [
                copyInto(projectDir, path.join(SHARED_RULES_DIR, `${rule.id}.yml`), `rules/${rule.id}.yml`),
                Bun.write(path.join(projectDir, rule.scope, rule.id, 'flagged.ts'), flagged),
                Bun.write(path.join(projectDir, rule.scope, rule.id, 'clean.ts'), clean),
                Bun.write(path.join(projectDir, otherScope(rule.scope), rule.id, 'flagged.ts'), flagged),
            ];
        }));
        const proc = Bun.spawn(['ast-grep', 'scan', '--json'], { cwd: projectDir, stdout: 'pipe', stderr: 'pipe' });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        return { matches: JSON.parse(stdout || '[]') as ReplacementMatch[], exitCode };
    } finally {
        await Bun.$`rm -rf ${projectDir}`.quiet();
    }
}

describe('no whole-file lint disables under src ast-grep rule', () => {
    let scan: { matches: ReplacementMatch[], exitCode: number };

    beforeAll(async () => {
        scan = await scanDirectiveFixtures();
    });

    test('reports errors for whole-file production disables, guarding against a silent failed scan', () => {
        expect(scan.exitCode).toBe(1);
        expect(scan.matches).toHaveLength(DIRECTIVE_VARIANTS.length * 2);
    });

    test.each(DIRECTIVE_VARIANTS)('flags block and line-comment whole-file disables in src for %s', (extension, suffix) => {
        const flagged = scan.matches.filter(match => match.file === `src/flagged.${extension}`);

        expect(flagged.map(match => match.range.start.line + 1).toSorted((a, b) => a - b)).toEqual([3, 4]);
        expect(flagged.every(match => match.ruleId === `${DIRECTIVE_RULE_ID}${suffix}`)).toBe(true);
    });

    test('allows local disables and inert strings/templates in src, and whole-file disables outside root src', () => {
        expect(scan.matches.every(match => match.file.startsWith('src/flagged.'))).toBe(true);
    });
});

describe('shared ast-grep rules replacing ESLint no-restricted-syntax', () => {
    let scan: { matches: ReplacementMatch[], exitCode: number };

    beforeAll(async () => {
        scan = await scanReplacementFixtures();
    });

    test('the repository sgconfig loads the installed shared rule directory', async () => {
        const config = Bun.YAML.parse(await Bun.file(path.join(REPO_ROOT, 'sgconfig.yml')).text()) as { ruleDirs: string[] };

        expect(config.ruleDirs).toContain('node_modules/@hughescr/oxlint-config-default/ast-grep');
    });

    test('the scan ran and reported errors (guards against a silent, empty scan)', () => {
        expect(scan.exitCode).not.toBe(0);
        expect(scan.matches.length).toBeGreaterThan(0);
    });

    describe.each(REPLACEMENT_RULES)('$id', (rule) => {
        const matchesIn = (file: string): ReplacementMatch[] =>
            scan.matches.filter(match => match.ruleId === rule.id && match.file === file);

        test('flags exactly the offending lines of the flagged fixture, with the original message', () => {
            const flagged = matchesIn(`${rule.scope}/${rule.id}/flagged.ts`);

            expect(flagged.map(match => match.range.start.line + 1).toSorted((a, b) => a - b)).toEqual(rule.flaggedLines);
            expect(flagged.every(match => match.message === rule.message)).toBe(true);
        });

        test('stays silent on the clean fixture', () => {
            expect(matchesIn(`${rule.scope}/${rule.id}/clean.ts`)).toEqual([]);
        });

        test(`stays silent on the same code outside ${rule.scope}/`, () => {
            expect(matchesIn(`${otherScope(rule.scope)}/${rule.id}/flagged.ts`)).toEqual([]);
        });
    });
});
