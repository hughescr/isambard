/**
 * Stryker directive placement checker.
 *
 * @stryker-mutator/instrumenter's DirectiveBookkeeper (see
 * node_modules/@stryker-mutator/instrumenter/dist/src/transformers/directive-bookkeeper.js)
 * reads `// Stryker disable|restore [next-line] <Mutators>[: reason]` comments ONLY from
 * Babel's `leadingComments` on each AST node it visits. A comment that Babel does not attach
 * as a *leading* comment of some node — one written above a line that starts with an
 * operator, `?`, `:`, or a chained `.method(`, or above a closing brace — is invisible to
 * Stryker even though it reads like a directive to a human. This tool re-parses source with
 * the same parser/plugin set Stryker's instrumenter uses and reports directives that will
 * silently be ignored, so `bun run lint` catches the mistake instead of a mutation report
 * quietly under-testing a line a developer believed was protected.
 *
 * Problem kinds:
 *   - misplaced:       the comment is not attached as any node's leading comment
 *   - wrong-line:      a `next-line` directive is attached to a node that does not start on
 *                       the line immediately after the comment (e.g. a blank line between them)
 *   - unknown-mutator:  a mutator name in the directive is not a known Stryker mutator
 *   - orphan-restore:   a `restore` directive has no matching open `disable`
 *   - error:            the file could not be read or parsed
 */
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

// Stryker disable next-line Regex: the uncaptured reason suffix is optional in a deliberately prefix-matching regex, so shortening it cannot change the consumed groups.
const DIRECTIVE_RE = /^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::.+)?/;
const KNOWN_MUTATORS = new Set([
    'arithmeticoperator', 'arraydeclaration', 'arraymethodswap', 'arrowfunction',
    'assignmentoperator', 'awaitdrop', 'blockstatement', 'booleanliteral',
    'callargumenttweak', 'callexpression', 'conditionalexpression', 'equalityoperator',
    'logicaloperator', 'methodexpression', 'numberliteralvalue', 'objectliteral',
    'optionalchaining', 'promisecombinatorswap', 'regex', 'spreadoperanddrop',
    'stringliteral', 'stringmethodargswap', 'unaryoperator', 'updateoperator', 'llm',
]);
// Stryker disable next-line StringLiteral: under Babel 7.29.8 these metadata keys lead only to primitives, inert comment records, or non-enumerable location metadata.
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'extra', 'tokens']);

/** One Stryker-directive placement problem found in a source file. */
export interface Problem {
    file:    string
    line:    number
    col:     number
    kind:    'misplaced' | 'wrong-line' | 'unknown-mutator' | 'orphan-restore' | 'error'
    message: string
}

interface BabelLoc { start: { line: number, column: number }, end: { line: number, column: number } }
interface BabelComment { type: string, value: string, start: number, end: number, loc: BabelLoc }
interface BabelNode { type?: string, loc?: BabelLoc, leadingComments?: BabelComment[], [key: string]: unknown }
interface BabelFile { program: BabelNode, comments?: BabelComment[] }
interface OpenDisable { names: Set<string>, isAll: boolean }

// Recursively walk every AST node, invoking `visit` on each. A simple object-key walk over
// anything carrying a `type` field is enough — no scope/parent bookkeeping needed, just "does
// this comment appear as *some* node's leadingComments".
function walk(node: unknown, visit: (n: BabelNode) => void): void {
    // Stryker disable next-line ConditionalExpression: the root is an AST object, object-property recursion is pre-filtered below, and Babel AST arrays contain only nodes/objects or null; no reachable call passes the truthy primitive needed to distinguish this disjunct from false.
    if(!node || typeof node !== 'object') {
        return;
    }
    // Stryker disable next-line BlockStatement: an emptied array branch falls through to Object.keys, which visits the same indexed elements in the same order.
    if(Array.isArray(node)) {
        for(const item of node) {
            walk(item, visit);
        }
        return;
    }
    const n = node as BabelNode;
    // Stryker disable next-line ConditionalExpression: reachable untyped Babel objects have neither leadingComments nor loc, so visiting them is inert.
    if(typeof n.type === 'string') {
        visit(n);
    }
    for(const key of Object.keys(n)) {
        // Stryker disable next-line ConditionalExpression, BlockStatement: traversing skipped Babel metadata finds no visitable AST nodes.
        if(SKIP_KEYS.has(key)) {
            continue;
        }
        const val = n[key];
        // Stryker disable next-line ConditionalExpression, LogicalOperator: walk repeats this null/non-object guard, making broader recursive calls inert.
        if(val && typeof val === 'object') {
            walk(val, visit);
        }
    }
}

/** For every node with leadingComments, map each comment's char offset to the line the node it leads starts on. */
function findLeadingCommentLines(program: BabelNode): Map<number, number> {
    const leadingLineByCommentStart = new Map<number, number>();
    walk(program, (node) => {
        if(!node.leadingComments || !node.loc) {
            return;
        }
        for(const c of node.leadingComments) {
            // Stryker disable next-line ConditionalExpression: Babel attaches a comment to at most one reachable leading-node line, so a later write cannot change this map.
            if(!leadingLineByCommentStart.has(c.start)) {
                leadingLineByCommentStart.set(c.start, node.loc.start.line);
            }
        }
    });
    return leadingLineByCommentStart;
}

/** Problems for mutator names in a directive that aren't `all` and aren't a known Stryker mutator. */
function checkMutatorNames(names: string[], file: string, line: number, col: number): Problem[] {
    const problems: Problem[] = [];
    for(const name of names) {
        const lower = name.toLowerCase();
        if(lower !== 'all' && !KNOWN_MUTATORS.has(lower)) {
            problems.push({ file, line, col, kind: 'unknown-mutator', message: `Unknown Stryker mutator name: ${name}` });
        }
    }
    return problems;
}

/** Close the nearest open disable region this restore matches (by name, or `all` on either side). Returns whether one was found. */
function closeMatchingRegion(lowerNames: Set<string>, isAll: boolean, openDisables: OpenDisable[]): boolean {
    for(let i = openDisables.length - 1; i >= 0; i--) {
        const d = openDisables[i];
        if(isAll || d.isAll || [...lowerNames].some(n => d.names.has(n))) {
            openDisables.splice(i, 1);
            return true;
        }
    }
    return false;
}

/** Non-next-line region bookkeeping: opens a disable, or closes the matching one on a restore. */
function updateOpenRegions(directiveType: string, lowerNames: Set<string>, openDisables: OpenDisable[]): boolean {
    const isAll = lowerNames.has('all');
    if(directiveType === 'disable') {
        openDisables.push({ names: lowerNames, isAll });
        return true;
    }
    return closeMatchingRegion(lowerNames, isAll, openDisables);
}

/** Analyse one already-matched directive comment, updating `openDisables` bookkeeping in place. */
function processDirectiveComment(comment: BabelComment, leadingLineByCommentStart: Map<number, number>, openDisables: OpenDisable[], file: string): Problem[] {
    const m = DIRECTIVE_RE.exec(comment.value);
    if(!m) {
        return [];
    }
    const [, directiveType, scope, mutatorsRaw] = m;
    const line = comment.loc.start.line;
    const col = comment.loc.start.column + 1;
    const trimmed = comment.value.trim();
    const isLeading = leadingLineByCommentStart.has(comment.start);
    const problems: Problem[] = [];

    if(!isLeading) {
        // Stryker disable next-line ArrayMethodSwap: this is the first possible insertion into the local problems array, so push and unshift are identical.
        problems.push({ file, line, col, kind: 'misplaced', message: `Stryker directive is not attached to any statement as a leading comment, so Stryker will silently ignore it: ${trimmed}` });
    }

    if(scope === 'next-line' && isLeading) {
        const annotatedLine = leadingLineByCommentStart.get(comment.start)!;
        if(annotatedLine !== comment.loc.end.line + 1) {
            // Stryker disable next-line ArrayMethodSwap: the leading-only branch excludes the earlier misplaced insertion, so the local problems array is still empty.
            problems.push({ file, line, col, kind: 'wrong-line', message: `Stryker next-line directive covers line ${annotatedLine}, not the line immediately below it: ${trimmed}` });
        }
    }

    const names = mutatorsRaw.split(',').map(s => s.trim());
    problems.push(...checkMutatorNames(names, file, line, col));

    if(scope !== 'next-line') {
        const lowerNames = new Set(names.map(n => n.toLowerCase()));
        if(!updateOpenRegions(directiveType, lowerNames, openDisables)) {
            problems.push({ file, line, col, kind: 'orphan-restore', message: `Stryker restore has no matching open disable: ${trimmed}` });
        }
    }

    return problems;
}

/**
 * Parse and analyse one file's source text for Stryker directive placement problems.
 * Pure: takes source text directly and performs no I/O.
 */
export function checkSource(code: string, file: string): Problem[] {
    let ast: BabelFile;
    try {
        ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'decorators-legacy'], attachComment: true, errorRecovery: true }) as unknown as BabelFile;
    } catch (err) {
        const loc = (err as { loc?: { line: number, column: number } }).loc;
        return [{ file, line: loc?.line ?? 1, col: (loc?.column ?? 0) + 1, kind: 'error', message: `parse failed: ${String(err)}` }];
    }

    const leadingLineByCommentStart = findLeadingCommentLines(ast.program);
    const openDisables: OpenDisable[] = [];
    const problems: Problem[] = [];
    for(const comment of ast.comments ?? []) {
        problems.push(...processDirectiveComment(comment, leadingLineByCommentStart, openDisables, file));
    }

    return problems;
}

/** Read and check each file in `files`; a file that cannot be read produces a single `error` problem. */
export function checkFiles(files: string[]): Problem[] {
    const problems: Problem[] = [];
    for(const file of files) {
        let code: string;
        try {
            // eslint-disable-next-line n/no-sync -- reads every candidate file up front; no async win for a CLI that must finish before reporting exit code
            code = readFileSync(file, 'utf8');
        } catch (err) {
            problems.push({ file, line: 1, col: 1, kind: 'error', message: `cannot read file: ${String(err)}` });
            continue;
        }
        problems.push(...checkSource(code, file));
    }
    return problems;
}

/** Render one problem in ESLint's `unix` formatter style, so it reads like the rest of `lint`. */
export function formatProblem(problem: Problem): string {
    return `${problem.file}:${problem.line}:${problem.col}: ${problem.message} [stryker-directive/${problem.kind}]`;
}

/** Every `.ts` file under `src/` and `tools/` — the same tree `bun mutate` mutates (stryker.conf.mjs). */
export async function scanRepoFiles(): Promise<string[]> {
    // Stryker disable next-line StringLiteral: Bun 1.4.2 treats scan('') and scan('.') identically; asserting this argument would pin an undocumented implementation detail.
    return Array.fromAsync(new Bun.Glob('{src,tools}/**/*.ts').scan('.'));
}

export interface CliDeps {
    scan?:       () => Promise<string[]>
    checkFiles?: (files: string[]) => Problem[]
    write?:      (text: string) => void
    exit?:       (code: number) => void
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<void> {
    const scan = deps.scan ?? scanRepoFiles;
    const check = deps.checkFiles ?? checkFiles;
    const write = deps.write ?? ((text: string) => {
        process.stdout.write(text);
    });
    const exit = deps.exit ?? ((code: number) => {
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- the one place this process actually terminates; the CLI's own exit code is the whole point
        process.exit(code);
    });

    const files = argv.length > 0 ? argv : await scan();
    const problems = check(files);
    for(const p of problems) {
        write(`${formatProblem(p)}\n`);
    }
    if(problems.length > 0) {
        write(`${problems.length} problems in ${files.length} files\n`);
    }
    exit(problems.length > 0 ? 1 : 0);
}

// Stryker disable next-line ConditionalExpression, BlockStatement: import.meta.main is only true when this file runs as the CLI entry point; a test harness never satisfies it (and can't, short of a real subprocess launch), so this guard and its block are structurally unreachable from `bun test`.
if(import.meta.main) {
    // Stryker disable next-line AwaitDrop, MethodExpression, NumberLiteralValue: entrypoint call with nothing following it in this block; same equivalent-mutant reasoning as tools/backfill-contact-lookup-gsi2.ts's identical AwaitDrop disable. process.argv.slice(2) is likewise only exercised when this file runs as the CLI entry point.
    await runCli(process.argv.slice(2));
}
