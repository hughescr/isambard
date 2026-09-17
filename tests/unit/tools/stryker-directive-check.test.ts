import { describe, test, expect, mock, spyOn } from 'bun:test';
import { checkSource, checkFiles, formatProblem, scanRepoFiles, runCli, type Problem } from '../../../tools/stryker-directive-check';

describe('checkSource', () => {
    test.each([
        ['a well-placed disable next-line above a statement', "// Stryker disable next-line StringLiteral: reason\nconst x = 'a';\n"],
        ['a disable next-line above a multi-line statement, when the comment attaches to line N+1', '// Stryker disable next-line ObjectLiteral: reason\nconst obj = {\n    a: 1,\n};\n'],
        ['`all` as the mutator name', '// Stryker disable next-line all: reason\nconst x = 1;\n'],
        ['a properly paired `disable X` … `restore X` region', "// Stryker disable StringLiteral: reason\nconst a = 'x';\n// Stryker restore StringLiteral\nconst b = 'y';\n"],
        ['a `restore all` closing an open `disable X` region', "// Stryker disable StringLiteral: reason\nconst a = 'x';\n// Stryker restore all\nconst b = 'y';\n"],
        ['nested disable regions that close in order', ['// Stryker disable all: reason', 'const a = 1;', '// Stryker disable StringLiteral: nested', "const b = 'x';", '// Stryker restore StringLiteral', 'const c = 2;', '// Stryker restore all', 'const d = 3;', ''].join('\n')],
        ['a `/* block */` comment directive', '/* Stryker disable next-line StringLiteral: reason */\nconst x = 1;\n'],
        ['a directive with exactly one space after `//`', '// Stryker disable next-line StringLiteral: reason\nconst x = 1;\n'],
        ['a disable next-line with multiple comma-separated known mutator names', '// Stryker disable next-line StringLiteral, ArithmeticOperator: reason\nconst x = 1;\n'],
        ['a restore that must skip a non-matching, more-recently-opened disable to find its match', '// Stryker disable ArithmeticOperator: reason\nconst a = 1;\n// Stryker disable StringLiteral: reason\nconst b = 47;\n// Stryker restore ArithmeticOperator\nconst c = 2;\n'],
        ['a restore listing multiple names where only one overlaps the open disable', '// Stryker disable StringLiteral: reason\nconst a = 47;\n// Stryker restore StringLiteral, ArithmeticOperator\nconst b = 1;\n'],
        ['restoring two distinctly-named nested regions in the order that requires scanning past a same-named sibling', '// Stryker disable StringLiteral, ArithmeticOperator: reason\nconst a = 1;\n// Stryker disable ArithmeticOperator: reason\nconst b = 2;\n// Stryker restore ArithmeticOperator\nconst c = 3;\n// Stryker restore StringLiteral\nconst d = 4;\n'],
        ['restoring two disables of different names where closing the first must not remove the second too', '// Stryker disable StringLiteral: reason\nconst a = 47;\n// Stryker disable ArithmeticOperator: reason\nconst b = 1;\n// Stryker restore StringLiteral\nconst c = 2;\n// Stryker restore ArithmeticOperator\nconst d = 3;\n'],
        ['a blank line between a persistent (non-next-line) disable and the code it covers is fine', '// Stryker disable StringLiteral: reason\n\nconst a = 47;\n// Stryker restore StringLiteral\nconst b = 1;\n'],
        ['a sparse array literal (elided element) does not crash the AST walk', 'const a = [1, , 3];\n'],
    ])('%s produces no problems', (_label, code) => {
        expect(checkSource(code, 'f.ts')).toEqual([]);
    });

    test('a directive with no space after `//` still matches: a misplaced one is still reported MISPLACED', () => {
        const code = 'const a = 1\n    //Stryker disable next-line ArithmeticOperator: reason\n    + 2;\n';
        const problems = checkSource(code, 'f.ts');
        expect(problems).toHaveLength(1);
        expect(problems[0]?.kind).toBe('misplaced');
    });

    test('every known Stryker mutator name is accepted as a directive scope (change-detector: keep this literal list in sync with KNOWN_MUTATORS in the source)', () => {
        const knownMutatorNames = [
            'ArithmeticOperator', 'ArrayDeclaration', 'ArrayMethodSwap', 'ArrowFunction',
            'AssignmentOperator', 'AwaitDrop', 'BlockStatement', 'BooleanLiteral',
            'CallArgumentTweak', 'CallExpression', 'ConditionalExpression', 'EqualityOperator',
            'LogicalOperator', 'MethodExpression', 'NumberLiteralValue', 'ObjectLiteral',
            'OptionalChaining', 'PromiseCombinatorSwap', 'Regex', 'SpreadOperandDrop',
            'StringLiteral', 'StringMethodArgSwap', 'UnaryOperator', 'UpdateOperator', 'Llm',
        ];
        for(const name of knownMutatorNames) {
            const code = `// Stryker disable next-line ${name}: reason\nconst x = 1;\n`;
            expect(checkSource(code, 'f.ts')).toEqual([]);
        }
    });

    test.each([
        ['a restore whose name matches nothing is ORPHAN-RESTORE even while an unrelated disable is still open', '// Stryker disable StringLiteral: reason\nconst a = 47;\n// Stryker restore ArithmeticOperator\nconst b = 1;\n', 3, 'Stryker restore ArithmeticOperator'],
        ['restoring the same name twice: the second restore is ORPHAN-RESTORE because the region was already closed', '// Stryker disable StringLiteral: reason\nconst a = 47;\n// Stryker restore StringLiteral\nconst b = 1;\n// Stryker restore StringLiteral\nconst c = 2;\n', 5, 'Stryker restore StringLiteral'],
        ['a `disable next-line` region never affects persistent-region bookkeeping: a later restore of the same name is still ORPHAN-RESTORE', '// Stryker disable next-line StringLiteral: reason\nconst a = 1;\n// Stryker restore StringLiteral\nconst b = 2;\n', 3, 'Stryker restore StringLiteral'],
    ])('%s', (_label, code, line, directiveText) => {
        const problems = checkSource(code, 'f.ts');
        expect(problems).toHaveLength(1);
        expect(problems[0]).toEqual({
            file:    'f.ts',
            line,
            col:     1,
            kind:    'orphan-restore',
            message: `Stryker restore has no matching open disable: ${directiveText}`,
        });
    });

    test('multiple unknown mutator names in one directive produce one problem per name, in the order they were written', () => {
        const code = '// Stryker disable next-line Foo, Bar: reason\nconst x = 1;\n';
        const problems = checkSource(code, 'f.ts');
        expect(problems).toHaveLength(2);
        expect(problems[0]?.message).toBe('Unknown Stryker mutator name: Foo');
        expect(problems[1]?.message).toBe('Unknown Stryker mutator name: Bar');
    });

    test('a misplaced directive reports the exact position and message, with no trailing whitespace from the source line', () => {
        const code = 'const a = 1\n    // Stryker disable next-line ArithmeticOperator: reason   \n    + 2;\n';
        const problems = checkSource(code, 'f.ts');
        expect(problems).toHaveLength(1);
        expect(problems[0]).toEqual({
            file:    'f.ts',
            line:    2,
            col:     5,
            kind:    'misplaced',
            message: 'Stryker directive is not attached to any statement as a leading comment, so Stryker will silently ignore it: Stryker disable next-line ArithmeticOperator: reason',
        });
    });

    test('a misplaced restore with no open disable is both MISPLACED and ORPHAN-RESTORE, in that order, with exact messages', () => {
        const code = 'const a = 1\n    // Stryker restore ArithmeticOperator\n    + 2;\n';
        const problems = checkSource(code, 'f.ts');
        expect(problems).toHaveLength(2);
        expect(problems[0]).toEqual({
            file:    'f.ts',
            line:    2,
            col:     5,
            kind:    'misplaced',
            message: 'Stryker directive is not attached to any statement as a leading comment, so Stryker will silently ignore it: Stryker restore ArithmeticOperator',
        });
        expect(problems[1]).toEqual({
            file:    'f.ts',
            line:    2,
            col:     5,
            kind:    'orphan-restore',
            message: 'Stryker restore has no matching open disable: Stryker restore ArithmeticOperator',
        });
    });

    test('a misplaced directive with an unknown mutator name produces MISPLACED then UNKNOWN-MUTATOR, in that order', () => {
        const code = 'const a = 1\n    // Stryker disable next-line NotARealMutator: reason\n    + 2;\n';
        const problems = checkSource(code, 'f.ts');
        expect(problems).toHaveLength(2);
        expect(problems[0]?.kind).toBe('misplaced');
        expect(problems[1]?.kind).toBe('unknown-mutator');
        expect(problems[1]?.message).toBe('Unknown Stryker mutator name: NotARealMutator');
    });

    test('two misplaced directives in one file produce two problems in file order', () => {
        const code = 'const a = 1\n    // Stryker disable next-line ArithmeticOperator: first\n    + 2;\nconst b = 1\n    // Stryker disable next-line ArithmeticOperator: second\n    + 2;\n';
        const problems = checkSource(code, 'f.ts');
        expect(problems).toHaveLength(2);
        expect(problems[0]?.message).toContain('first');
        expect(problems[1]?.message).toContain('second');
    });

    test('a parse error reports the exact line and column of the syntax error, not just the file default', () => {
        const problems = checkSource('const a = 1;\nconst b = ;\n', 'f.ts');
        expect(problems).toHaveLength(1);
        expect(problems[0]?.kind).toBe('error');
        expect(problems[0]?.line).toBe(2);
        expect(problems[0]?.col).toBe(11);
    });

    test('a parse failure with no location (a parser stack-overflow RangeError from pathologically deep nesting) falls back to line 1, col 1', () => {
        const problems = checkSource('['.repeat(100_000), 'f.ts');
        expect(problems).toHaveLength(1);
        expect(problems[0]?.kind).toBe('error');
        expect(problems[0]?.message).toContain('RangeError');
        expect(problems[0]?.line).toBe(1);
        expect(problems[0]?.col).toBe(1);
    });

    test.each([
        ['a line starting with an operator', 'const a = 1\n    // Stryker disable next-line ArithmeticOperator: reason\n    + 2;\n'],
        ['a ternary `?`-branch continuation', 'const a = cond\n    ? 1\n    // Stryker disable next-line ConditionalExpression: reason\n    : 2;\n'],
        ['a `.filter(` chain link', 'const a = arr\n    .map(x => x)\n    // Stryker disable next-line ArrayMethodSwap: reason\n    .filter(x => x);\n'],
        ['a `?? await` continuation', 'const a = maybeNull\n    // Stryker disable next-line PromiseCombinatorSwap: reason\n    ?? await getDefault();\n'],
    ])('a directive above %s is MISPLACED', (_label, code) => {
        const problems = checkSource(code, 'f.ts');
        expect(problems).toHaveLength(1);
        expect(problems[0]?.kind).toBe('misplaced');
    });

    test('a blank line between the directive and the statement it covers is WRONG-LINE', () => {
        const code = '// Stryker disable next-line StringLiteral: reason\n\nconst x = 1;\n';
        const problems = checkSource(code, 'f.ts');
        expect(problems).toHaveLength(1);
        expect(problems[0]?.kind).toBe('wrong-line');
        expect(problems[0]?.message).toContain('covers line 3');
    });

    test('an unknown mutator name is UNKNOWN-MUTATOR', () => {
        const code = '// Stryker disable next-line NotARealMutator: reason\nconst x = 1;\n';
        const problems = checkSource(code, 'f.ts');
        expect(problems).toHaveLength(1);
        expect(problems[0]?.kind).toBe('unknown-mutator');
        expect(problems[0]?.message).toContain('NotARealMutator');
    });

    test('a `restore` with no open `disable` is ORPHAN-RESTORE', () => {
        const code = '// Stryker restore StringLiteral\nconst x = 1;\n';
        const problems = checkSource(code, 'f.ts');
        expect(problems).toHaveLength(1);
        expect(problems[0]?.kind).toBe('orphan-restore');
    });

    test('a directive with two spaces after `//` does not match the directive pattern at all — invisible, not a problem', () => {
        const code = '//  Stryker disable next-line StringLiteral: reason\nconst x = 1;\n';
        expect(checkSource(code, 'f.ts')).toEqual([]);
    });

    test('a parse error produces a single ERROR problem', () => {
        const problems = checkSource('const x = ;', 'f.ts');
        expect(problems).toHaveLength(1);
        expect(problems[0]?.kind).toBe('error');
        expect(problems[0]?.file).toBe('f.ts');
        expect(problems[0]?.message).toContain('parse failed');
    });
});

describe('checkFiles', () => {
    test('a file that cannot be read produces a single ERROR problem tagged with its path, at line 1 col 1', () => {
        const problems = checkFiles(['/does/not/exist/missing-file.ts']);
        expect(problems).toHaveLength(1);
        expect(problems[0]?.kind).toBe('error');
        expect(problems[0]?.file).toBe('/does/not/exist/missing-file.ts');
        expect(problems[0]?.message).toContain('cannot read file');
        expect(problems[0]?.line).toBe(1);
        expect(problems[0]?.col).toBe(1);
    });

    test('combines results across multiple files, tagging each problem with the file it came from', () => {
        const problems = checkFiles(['missing-file.ts', 'tools/stryker-directive-check.ts']);
        expect(problems).toHaveLength(1);
        expect(problems[0]?.file).toBe('missing-file.ts');
        expect(problems[0]?.kind).toBe('error');
    });

    test('multiple unreadable files each produce an error problem, in file order', () => {
        const problems = checkFiles(['missing-one.ts', 'missing-two.ts']);
        expect(problems).toHaveLength(2);
        expect(problems[0]?.file).toBe('missing-one.ts');
        expect(problems[1]?.file).toBe('missing-two.ts');
    });

    test('combines a real, non-empty checkSource result with a later error result, preserving file order', () => {
        const problems = checkFiles(['missing-file.ts', 'tests/fixtures/stryker-directive-check/misplaced-directive.ts']);
        expect(problems).toHaveLength(2);
        expect(problems[0]?.kind).toBe('error');
        expect(problems[0]?.file).toBe('missing-file.ts');
        expect(problems[1]?.kind).toBe('misplaced');
        expect(problems[1]?.file).toBe('tests/fixtures/stryker-directive-check/misplaced-directive.ts');
    });
});

describe('formatProblem', () => {
    test('renders a problem in ESLint unix format', () => {
        const problem: Problem = { file: 'src/foo.ts', line: 12, col: 5, kind: 'misplaced', message: 'directive will be ignored' };
        expect(formatProblem(problem)).toBe('src/foo.ts:12:5: directive will be ignored [stryker-directive/misplaced]');
    });
});

describe('scanRepoFiles', () => {
    test('finds every .ts file under src/ and tools/, including top-level files', async () => {
        const files = await scanRepoFiles();
        expect(files).toContain('src/index.ts');
        expect(files).toContain('tools/stryker-directive-check.ts');
        expect(files.every(f => f.startsWith('src/') || f.startsWith('tools/'))).toBe(true);
    });
});

describe('runCli', () => {
    test('uses the given argv files directly, without scanning', async () => {
        const scan = mock(async (): Promise<string[]> => {
            throw new Error('scan must not be called');
        });
        let sawFiles: string[] = [];
        let exitCode: number | undefined;
        await runCli(['a.ts', 'b.ts'], {
            scan,
            checkFiles: (files) => {
                sawFiles = files;
                return [];
            },
            write: () => {},
            exit:  (c) => { exitCode = c; },
        });
        expect(scan).not.toHaveBeenCalled();
        expect(sawFiles).toEqual(['a.ts', 'b.ts']);
        expect(exitCode).toBe(0);
    });

    test('scans for files when argv is empty', async () => {
        const scan = mock(async () => ['x.ts']);
        let sawFiles: string[] = [];
        let exitCode: number | undefined;
        await runCli([], {
            scan,
            checkFiles: (files) => {
                sawFiles = files;
                return [];
            },
            write: () => {},
            exit:  (c) => { exitCode = c; },
        });
        expect(scan).toHaveBeenCalledTimes(1);
        expect(sawFiles).toEqual(['x.ts']);
        expect(exitCode).toBe(0);
    });

    test('writes each problem line plus a summary and exits 1 when problems are found', async () => {
        const problems: Problem[] = [
            { file: 'a.ts', line: 1, col: 1, kind: 'misplaced', message: 'oops' },
            { file: 'b.ts', line: 2, col: 3, kind: 'error', message: 'bad' },
        ];
        const writes: string[] = [];
        let exitCode: number | undefined;
        await runCli(['a.ts', 'b.ts'], {
            checkFiles: () => problems,
            write:      (t) => { writes.push(t); },
            exit:       (c) => { exitCode = c; },
        });
        expect(writes).toEqual([
            `${formatProblem(problems[0])}\n`,
            `${formatProblem(problems[1])}\n`,
            '2 problems in 2 files\n',
        ]);
        expect(exitCode).toBe(1);
    });

    test('writes a summary line even when exactly one problem is found', async () => {
        const problems: Problem[] = [{ file: 'a.ts', line: 1, col: 1, kind: 'misplaced', message: 'oops' }];
        const writes: string[] = [];
        let exitCode: number | undefined;
        await runCli(['a.ts'], {
            checkFiles: () => problems,
            write:      (t) => { writes.push(t); },
            exit:       (c) => { exitCode = c; },
        });
        expect(writes).toEqual([
            `${formatProblem(problems[0])}\n`,
            '1 problems in 1 files\n',
        ]);
        expect(exitCode).toBe(1);
    });

    test('writes nothing extra and exits 0 when there are no problems', async () => {
        const writes: string[] = [];
        let exitCode: number | undefined;
        await runCli(['clean.ts'], {
            checkFiles: () => [],
            write:      (t) => { writes.push(t); },
            exit:       (c) => { exitCode = c; },
        });
        expect(writes).toEqual([]);
        expect(exitCode).toBe(0);
    });

    test('defaults to the real scanRepoFiles when argv is empty and no scan override is given', async () => {
        let sawFiles: string[] = [];
        let exitCode: number | undefined;
        await runCli([], {
            checkFiles: (files) => {
                sawFiles = files;
                return [];
            },
            write: () => {},
            exit:  (c) => { exitCode = c; },
        });
        expect(sawFiles).toContain('src/index.ts');
        expect(exitCode).toBe(0);
    });

    test('defaults to the real checkFiles when no override is given', async () => {
        const writes: string[] = [];
        let exitCode: number | undefined;
        await runCli(['/does/not/exist/definitely-missing.ts'], {
            write: (t) => { writes.push(t); },
            exit:  (c) => { exitCode = c; },
        });
        expect(writes[0]).toContain('cannot read file');
        expect(writes[0]).toContain('[stryker-directive/error]');
        expect(exitCode).toBe(1);
    });

    test('the default write writer goes to process.stdout.write', async () => {
        const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await runCli(['a.ts'], {
                checkFiles: () => [{ file: 'a.ts', line: 1, col: 1, kind: 'misplaced', message: 'm' }],
                exit:       () => {},
            });
            expect(stdoutSpy).toHaveBeenCalled();
        } finally {
            stdoutSpy.mockRestore();
        }
    });

    test('the default exit calls process.exit with the computed code', async () => {
        const exitSpy = spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as never);
        try {
            await runCli(['clean.ts'], { checkFiles: () => [], write: () => {} });
            expect(exitSpy).toHaveBeenCalledWith(0);
        } finally {
            exitSpy.mockRestore();
        }
    });
});
