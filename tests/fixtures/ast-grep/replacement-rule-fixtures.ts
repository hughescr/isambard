// Fixture sources for the shared ast-grep rules (@hughescr/oxlint-config-default, ast-grep/) that
// replaced ESLint `no-restricted-syntax` selectors (see tests/unit/tools/ast-grep-rules.test.ts).
// Kept as strings rather than separate source files because the flagged code must stay invisible to the repo's own ast-grep scan, tsc and linters.
// Line numbers matter: the test asserts the exact lines each rule reports.

export interface AstGrepRuleFixture {
    flagged: string
    clean:   string
}

export const REPLACEMENT_RULE_FIXTURES: Readonly<Record<string, AstGrepRuleFixture>> = {
    'no-silent-catch-undefined': {
        flagged: `declare const p: Promise<void>;
p.catch(() => undefined);
p.catch((err) => undefined);
p.then(() => 1).catch(async () => undefined);
p
    .catch(() =>
        undefined);
`,
        clean: `declare const p: Promise<void>;
declare const logger: { warn: (...args: unknown[]) => void };
p.catch((err) => { logger.warn({ err }, 'failed'); });
p.catch(() => null);
p.catch(() => { return undefined; });
p.catch(() => void 0);
p.then(() => undefined);
p.finally(() => undefined);
p.then(() => 1, () => undefined);
`,
    },
    'no-test-bun-sleep': {
        flagged: `await Bun.sleep(10);
const p = Bun.sleep(5);
export { p };
`,
        clean: `declare const other: { sleep: (n: number) => void };
other.sleep(1);
Bun.sleepSync(1);
const b = Bun.version;
export { b };
`,
    },
    'no-test-dynamic-await-import': {
        flagged: `declare const spec: string;
const a = await import('node:path');
export { a };
async function load() {
    return (await import('./x.ts')).default;
}
export { load };
const b = await import(spec) as { x: string };
const c = await (import('x'));
const d = await import('y') satisfies object;
`,
        clean: `import * as path from 'node:path';
const lazy = import('node:path');
const wrapped = lazy.then(m => m.sep);
const all = await Promise.all([import('node:path')]);
const typed = (import('x')) as Promise<unknown>;
export { path, wrapped, all, typed };
`,
    },
    'no-test-process-next-tick': {
        flagged: `process.nextTick(() => undefined);
const tick = process.nextTick;
export { tick };
`,
        clean: `declare const other: { nextTick: () => void };
other.nextTick();
const env = process.env;
export { env };
`,
    },
    'no-test-promise-wrapped-set-timeout': {
        flagged: `const a = new Promise<void>(resolve => setTimeout(resolve, 10));
const b = new Promise<void>((resolve) => {
    void 0;
    setTimeout(() => {
        resolve();
    }, 5);
});
export { a, b };
`,
        clean: `const a = new Promise<void>(resolve => resolve());
const b = new Map<string, number>();
export { a, b };
`,
    },
    'no-test-queue-microtask': {
        flagged: `queueMicrotask(() => undefined);
queueMicrotask(() => {
    void 0;
});
`,
        clean: `declare const obj: { queueMicrotask: () => void };
obj.queueMicrotask();
await Promise.resolve();
`,
    },
    'no-test-set-immediate': {
        flagged: `setImmediate(() => undefined);
const a = setImmediate(() => {
    void 0;
});
export { a };
`,
        clean: `declare const obj: { setImmediate: () => void };
obj.setImmediate();
clearImmediate(undefined);
`,
    },
    'no-test-set-interval': {
        flagged: `const a = setInterval(() => undefined, 10);
clearInterval(a);
setInterval(() => {
    void 0;
}, 5);
`,
        clean: `declare const obj: { setInterval: (n: number) => void };
obj.setInterval(1);
clearInterval(undefined);
`,
    },
    'no-test-set-timeout': {
        flagged: `setTimeout(() => undefined, 10);
setTimeout(() => {
    void 0;
}, 0);
`,
        clean: `declare const obj: { setTimeout: (n: number) => void };
obj.setTimeout(1);
globalThis.setTimeout(() => undefined, 1);
const setTimeoutName = 'setTimeout';
export { setTimeoutName };
`,
    },
};
