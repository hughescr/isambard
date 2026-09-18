import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(typeof process.versions.bun, 'string', 'fixture must run under Bun');

const packageName = ['@hughescr', 'stryker-llm-mutator'].join('/');
const {
    arrayMethodSwapMutator,
    callArgumentTweakMutator,
    classifyMutation,
    createLlmMutators,
    injectMutators,
    isLlmMutatorName,
    promiseCombinatorSwapMutator,
    stringMethodArgSwapMutator
} = await import(packageName);

// Exercise Stryker's real parser, transformer and placer. The package's method
// tables intentionally keep only policy-safe variants, so test the eligible
// paths and their neighboring rejected shapes through the consumer's actual
// instrumenter instead of replicating the catalog in this fixture.
const require = createRequire(import.meta.url);
const instrumenterRoot = path.dirname(require.resolve('@stryker-mutator/instrumenter/package.json'));
const { Instrumenter } = await import(pathToFileURL(path.join(instrumenterRoot, 'dist/src/instrumenter.js')).href);
const { createParser } = await import(pathToFileURL(path.join(instrumenterRoot, 'dist/src/parsers/index.js')).href);
const logger = {
    debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {},
    isDebugEnabled: () => false,
};
injectMutators([arrayMethodSwapMutator, callArgumentTweakMutator, promiseCombinatorSwapMutator, stringMethodArgSwapMutator]);
const instrumenter = new Instrumenter(logger);
const options = { plugins: null, excludedMutations: [], ignorers: [], noHeader: false };

const inheritedCases = ['toString', 'constructor', '__proto__', 'valueOf'].flatMap(method => [
    { name: `array-inherited-${method}.ts`, source: `items.${method}(value);`, mutatorName: 'ArrayMethodSwap', expected: [] },
    { name: `promise-inherited-${method}.ts`, source: `await Promise.${method}(tasks);`, mutatorName: 'PromiseCombinatorSwap', expected: [] },
    { name: `string-inherited-${method}.ts`, source: `text.${method}(value);`, mutatorName: 'StringMethodArgSwap', expected: [] },
]);
const heuristicCases = [
    ...inheritedCases,
    { name: 'array-push.ts', source: 'items.push(value);', mutatorName: 'ArrayMethodSwap', expected: ['items.unshift(value)'] },
    { name: 'array-unshift.ts', source: '[seed].unshift(value);', mutatorName: 'ArrayMethodSwap', expected: ['[seed].push(value)'] },
    { name: 'array-empty.ts', source: '[].push(value);', mutatorName: 'ArrayMethodSwap', expected: [] },
    { name: 'array-no-argument.ts', source: 'items.push();', mutatorName: 'ArrayMethodSwap', expected: [] },
    { name: 'array-retired-method.ts', source: 'items.map(value);', mutatorName: 'ArrayMethodSwap', expected: [] },
    { name: 'slice.ts', source: 'text.slice(1, 4);', mutatorName: 'CallArgumentTweak', expected: ['text.slice(4, 1)'] },
    { name: 'slice-identical.ts', source: 'text.slice(1, 1);', mutatorName: 'CallArgumentTweak', expected: [] },
    { name: 'slice-one-argument.ts', source: 'text.slice(1);', mutatorName: 'CallArgumentTweak', expected: [] },
    { name: 'slice-fresh-empty.ts', source: '[].slice(1, 2);', mutatorName: 'CallArgumentTweak', expected: [] },
    { name: 'promise-all.ts', source: 'await Promise.all(tasks);', mutatorName: 'PromiseCombinatorSwap', expected: ['Promise.allSettled(tasks)', 'Promise.race(tasks)'] },
    { name: 'promise-empty.ts', source: 'await Promise.all([]);', mutatorName: 'PromiseCombinatorSwap', expected: [] },
    { name: 'promise-singleton.ts', source: 'await Promise.all([task]);', mutatorName: 'PromiseCombinatorSwap', expected: ['Promise.allSettled([task])'] },
    { name: 'promise-race-singleton.ts', source: 'await Promise.race([task]);', mutatorName: 'PromiseCombinatorSwap', expected: [] },
    { name: 'promise-race-plural.ts', source: 'await Promise.race([first, second]);', mutatorName: 'PromiseCombinatorSwap', expected: ['Promise.all([first, second])'] },
    { name: 'promise-assigned.ts', source: 'const result = await Promise.all(tasks);', mutatorName: 'PromiseCombinatorSwap', expected: [] },
    { name: 'promise-returned.ts', source: 'async function f() { return await Promise.all(tasks); }', mutatorName: 'PromiseCombinatorSwap', expected: [] },
    { name: 'promise-unawaited.ts', source: 'Promise.all(tasks);', mutatorName: 'PromiseCombinatorSwap', expected: [] },
    { name: 'promise-shadowed.ts', source: 'const Promise = { all: async values => values }; await Promise.all(tasks);', mutatorName: 'PromiseCombinatorSwap', expected: [] },
    { name: 'promise-two-arguments.ts', source: 'await Promise.all(tasks, fallback);', mutatorName: 'PromiseCombinatorSwap', expected: [] },
];
const heuristicResult = await instrumenter.instrument(heuristicCases.map(({ name, source }) => ({
    name: path.join(process.cwd(), name), mutate: true, content: source,
})), options);
for(const { name, expected, mutatorName } of heuristicCases) {
    const actual = heuristicResult.mutants.filter(mutant => mutant.fileName === path.join(process.cwd(), name) && mutant.mutatorName === mutatorName);
    assert.deepEqual(actual.map(mutant => mutant.replacement).toSorted(), expected, `${name} changed ${mutatorName} eligibility`);
}

// Babel 8's TypeScript parser mis-parses an unparenthesized typed async arrow in
// a ternary context. These source sites intentionally retain the smallest
// semantics-neutral parentheses workaround; exercise Stryker's actual parser.
const strykerParse = createParser({ plugins: null });
const isStrykerGeneratedSource = source => /^(?:\/\/ @ts-nocheck\r?\n)?function stryNS_\w+\(\) \{/.test(source)
  && source.includes('__STRYKER_ACTIVE_MUTANT__');
const parserSourceContents = await Promise.all(['src/agent/memory-mcp-server.ts', 'src/index.ts'].map(async (relativePath) => {
    const fileName = path.join(process.cwd(), relativePath);
    return { fileName, source: await readFile(fileName, 'utf8') };
}));
await Promise.all(parserSourceContents.filter(({ source }) => !isStrykerGeneratedSource(source)).map(async ({ fileName, source }) => {
    await strykerParse(source, fileName);
}));

// Stryker's Babel printer removes the grouping while adding mutation activation
// calls. The printed source still runs under Bun, but Babel cannot parse it a
// second time. Keep the grammar assertion active in that context without
// re-parsing the known non-idempotent printer output.
await Promise.all([
    'const callbacks = enabled ? [tool("x", {}, (async (args): Promise<unknown> => args))] : [];',
    'const callback = enabled ? (async (args): Promise<unknown> => args) : undefined;',
].map(async (source, index) => {
    await strykerParse(source, `typed-async-ternary-${index}.ts`);
}));
// Cached candidates on a shorthand property share the key/value source span.
// Lifting to the containing object keeps the intended value change placeable.
// An assignment's left-hand side, by contrast, accepts only an LVal.
const llmCases = [
    { name: 'shorthand.ts', source: 'const result = { signal, other: 1 };', original: 'signal', candidates: ['null'], expected: ['{\n  signal: null,\n  other: 1\n}'] },
    { name: 'object-value.ts', source: 'const result = { signal: signal, other: 1 };', original: 'signal', occurrence: 2, candidates: ['null'], expected: ['null'] },
    { name: 'assignment.ts', source: 'entry.timer = 1;', original: 'entry.timer', candidates: ['entry.timer = 2', 'other.timer'], expected: ['other.timer'] },
    { name: 'const-write.ts', source: 'const capturedId = 1; sessionId = capturedId;', original: 'sessionId = capturedId', candidates: ['capturedId = sessionId'], expected: [] },
    { name: 'let-write.ts', source: 'let capturedId = 1; sessionId = capturedId;', original: 'sessionId = capturedId', candidates: ['capturedId = sessionId'], expected: ['capturedId = sessionId'] },
    { name: 'const-held-property.ts', source: 'const holder = { timer: 1 }; holder.timer = 1;', original: 'holder.timer = 1', candidates: ['holder.timer = 2'], expected: ['holder.timer = 2'] },
    { name: 'shadowed-let.ts', source: 'const capturedId = 1; { let capturedId = 2; sessionId = capturedId; }', original: 'sessionId = capturedId', candidates: ['capturedId = sessionId'], expected: ['capturedId = sessionId'] },
];
const llmMap = new Map(llmCases.map(({ name, source, original, occurrence = 1, candidates }) => {
    const offset = occurrence === 1 ? source.indexOf(original) : source.lastIndexOf(original);
    assert.ok(offset !== -1);
    return [path.join(process.cwd(), name), new Map([[
        `1:${offset}-1:${offset + original.length}`,
        candidates.map(replacement => ({ original, replacement, category: classifyMutation(original, replacement) })),
    ]])];
}));
const drops = [];
injectMutators(createLlmMutators(llmMap, line => drops.push(line)));
const llmResult = await instrumenter.instrument(llmCases.map(({ name, source }) => ({
    name: path.join(process.cwd(), name), mutate: true, content: source,
})), options);
for(const { name, expected } of llmCases) {
    const actual = llmResult.mutants.filter(mutant => mutant.fileName === path.join(process.cwd(), name) && isLlmMutatorName(mutant.mutatorName));
    assert.deepEqual(actual.map(mutant => mutant.replacement).toSorted(), expected, `${name} lost or mis-placed cached candidates`);
}
assert.equal(drops.length, 2);
assert.ok(drops.some(line => /entry\.timer = 2/.test(line) && /AssignmentExpression.*left|Property left of AssignmentExpression/.test(line)));
assert.ok(drops.some(line => /capturedId = sessionId/.test(line) && /binding capturedId/.test(line)));

// Stock constructor mutations can put super() behind guards. Keep this source
// independent of app files: inside Stryker's sandbox, app sources are already
// instrumented and re-instrumenting them would mutate Stryker's own switches.
const errorSource = `export class DerivedError extends Error {
    public readonly code: string;
    public readonly context?: Record<string, unknown>;
    constructor(message: string, code: string, context?: Record<string, unknown>) {
        super(message);
        this.code = code;
        this.context = context;
        this.name = 'DerivedError';
    }
}`;
const errorResult = await new Instrumenter(logger).instrument([{
    name: path.join(process.cwd(), 'derived-error-fixture.ts'), mutate: true, content: errorSource,
}], options);
const nameMutant = errorResult.mutants.find(mutant => mutant.mutatorName === 'StringLiteral' && mutant.replacement === '""');
assert.ok(nameMutant, 'DerivedError name mutation was not instrumented');
const errorFixtureDir = await mkdtemp(path.join(tmpdir(), 'stryker-error-fixture-'));
try {
    await writeFile(path.join(errorFixtureDir, 'base.ts'), errorResult.files[0].content);
    const entry = path.join(errorFixtureDir, 'check.ts');
    await writeFile(entry, `import { DerivedError } from './base.ts';
for (const key of ['code', 'context']) {
    Object.defineProperty(Error.prototype, key, { configurable: true, set() { throw new Error('inherited setter called'); } });
}
const error = new DerivedError('test', 'STORAGE_ERROR');
console.log(JSON.stringify({
    code: error.code, context: error.context ?? null, name: error.name,
    ownCode: Object.hasOwn(error, 'code'), ownContext: Object.hasOwn(error, 'context'),
}));`);
    for(const [activeId, expectedName] of [['', 'DerivedError'], [nameMutant.id, '']]) {
        // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- This regression runs Bun against the generated TypeScript in a bounded child process.
        const child = spawnSync('bun', [entry], {
            encoding: 'utf8',
            env:      { ...process.env, __STRYKER_ACTIVE_MUTANT__: activeId, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
            timeout:  10_000,
        });
        assert.equal(child.status, 0, `instrumented IsambardError failed under Bun: ${child.stderr}`);
        assert.deepEqual(JSON.parse(child.stdout), { code: 'STORAGE_ERROR', context: null, name: expectedName, ownCode: true, ownContext: true });
    }
} finally {
    await rm(errorFixtureDir, { recursive: true, force: true });
}
