/**
 * ESLint Rule: no-cross-module-internal
 *
 * Prevents importing @internal exports from a different architectural module.
 * Module boundaries are defined via the rule's `modules` option, which accepts
 * the same `boundaryElements` array shape as eslint-plugin-boundaries.
 *
 * This rule uses TypeScript's AST and JSDoc parsing to check for @internal tags,
 * rather than fragile regex-based text scanning.
 *
 * How it works:
 * 1. For each import declaration, determines the importer's module
 * 2. Uses TypeScript's module resolution to find the actual source file
 * 3. Parses the source file's AST to find matching export declarations
 * 4. Checks JSDoc tags on those exports for @internal using ts.getJSDocTags()
 * 5. Reports error if importing an @internal export from a different module
 *
 * Note: Uses native methods and sync file operations (necessary for ESLint rules)
 */

import path from 'node:path';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- ESLint rule in tools/ uses devDependencies
import picomatch from 'picomatch';
import { isExportInternal, resolveImportToSourceFile } from './_ts-helpers.mjs';

/**
 * Determine which module a file belongs to based on its relative path.
 * @param {string} filePath - absolute path to the file
 * @param {string} cwd - project root
 * @param {Array<{type: string, matcher: (s: string) => boolean}>} matchers - pre-built matchers
 * @returns {string|null} module type or null if not in any known module
 */
export function getModuleForFile(filePath, cwd, matchers) {
    // Stryker disable all -- function tested via direct unit tests; Bun inspector cannot map per-test coverage for .mjs source files
    const rel = path.relative(cwd, filePath).replaceAll('\\', '/');
    for(const { type, matcher } of matchers) {
        if(matcher(rel)) {
            return type;
        }
    }
    return null; // Not in any known module (e.g., test files, tools)
    // Stryker restore all
}

/**
 * Build picomatch matchers from the `modules` option.
 * @param {Array<{type: string, pattern: string | string[]}>} modules
 * @returns {Array<{type: string, matcher: (s: string) => boolean}>}
 */
export function buildMatchers(modules) {
    // Stryker disable all -- function tested via direct unit tests; Bun inspector cannot map per-test coverage for .mjs source files
    return modules.map(({ type, pattern }) => ({
        type,
        matcher: picomatch(pattern),
    }));
    // Stryker restore all
}

// Stryker disable all -- rule meta/schema and create() body tested via RuleTester; Bun inspector cannot map per-test coverage for .mjs source files
const rule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow importing @internal exports from a different architectural module',
            category:    'Best Practices',
        },
        messages: {
            crossModuleInternal: "'{{name}}' is marked @internal in module '{{sourceModule}}' and cannot be imported from module '{{importerModule}}'.",
        },
        schema: [
            {
                type:       'object',
                properties: {
                    modules: {
                        type:     'array',
                        minItems: 1,
                        items:    {
                            type:       'object',
                            properties: {

                                type:    { type: 'string', minLength: 1 },
                                pattern: {
                                    oneOf: [
                                        { type: 'string', minLength: 1 },
                                        {
                                            type:     'array',
                                            minItems: 1,
                                            items:    { type: 'string', minLength: 1 },
                                        },
                                    ],
                                },
                            },
                            required:             ['type', 'pattern'],
                            additionalProperties: false,
                        },
                    },
                },
                additionalProperties: false,
            },
        ],
    },

    create(context) {
        const modules = context.options[0]?.modules;

        // No-op if no modules option provided
        if(!modules?.length) {
            return {};
        }

        const matchers = buildMatchers(modules);
        const cwd = context.cwd;
        const filename = context.filename;

        // Skip test files
        if(filename.includes('.test.') || filename.includes('.spec.')) {
            return {};
        }

        const importerModule = getModuleForFile(filename, cwd, matchers);

        // Skip files not in any known module
        if(!importerModule) {
            return {};
        }

        // Get parser services for TypeScript type information
        const parserServices = context.sourceCode?.parserServices;
        if(!parserServices?.program) {
            // Not a TypeScript file or type information not available
            return {};
        }

        const program = parserServices.program;
        const compilerOptions = program.getCompilerOptions();

        return {
            ImportDeclaration(node) {
                const importSource = node.source.value;

                // Skip external packages (not starting with . or @/)
                if(!importSource.startsWith('.') && !importSource.startsWith('@/')) {
                    return;
                }

                // Resolve the import to a source file using TypeScript's resolution
                const sourceFile = resolveImportToSourceFile(importSource, filename, program, compilerOptions);
                if(!sourceFile) {
                    return;
                }

                const sourceModule = getModuleForFile(sourceFile.fileName, cwd, matchers);

                // Skip if same module or unknown module
                if(!sourceModule || sourceModule === importerModule) {
                    return;
                }

                // Check each imported specifier
                for(const specifier of node.specifiers) {
                    if(specifier.type !== 'ImportSpecifier') {
                        continue;
                    }

                    const importedName = specifier.imported.name;

                    // Check if the export has @internal tag in the source file
                    if(isExportInternal(sourceFile, importedName)) {
                        context.report({
                            node:      specifier,
                            messageId: 'crossModuleInternal',
                            data:      {
                                name: importedName,
                                sourceModule,
                                importerModule,
                            },
                        });
                    }
                }
            },
        };
    },
};
// Stryker restore all

export default rule;
