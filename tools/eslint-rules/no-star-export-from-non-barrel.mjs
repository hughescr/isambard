/**
 * ESLint Rule: no-star-export-from-non-barrel
 *
 * Prevents barrel index.ts files from using `export * from '...'` to re-export
 * from non-barrel source files. Star re-exports leak all names — including any
 * future @internal additions — silently and without the author noticing.
 *
 * ALLOWED: `export * from './subdir'` where `./subdir/index.ts` exists and
 *           `allowBarrelOfBarrels` option is true (the default).
 * BLOCKED: `export * from './types'` where `./types.ts` is a regular file.
 * BLOCKED: `export * from './nonexistent'` where the module cannot be resolved.
 *
 * Applies only to barrel files (basename = index.ts).
 * Scope restriction to src/ is enforced by eslint.config.mjs.
 *
 * Note: Uses sync file operations (necessary for ESLint rules).
 */

import path from 'node:path';
import { resolveImportToSourceFile } from './_ts-helpers.mjs';

const rule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow barrel index.ts files from using export * from non-barrel files',
            category:    'Best Practices',
        },
        messages: {
            starFromNonBarrel: "export * from '{{source}}' re-exports from a non-barrel file. @internal items can leak silently. Use explicit `export { ... } from` to enumerate names, or re-export from a barrel index.ts.",
        },
        schema: [
            {
                type:                 'object',
                additionalProperties: false,
                properties:           {
                    allowBarrelOfBarrels: {
                        type:      'boolean',
                        'default': true,
                    },
                },
            },
        ],
    },

    create(context) {
        const filename = context.filename;

        // Only apply to barrel files (any index.ts)
        if(path.basename(filename) !== 'index.ts') {
            return {};
        }

        // Require TypeScript program for type-aware module resolution
        const parserServices = context.sourceCode?.parserServices;
        if(!parserServices?.program) {
            return {};
        }

        const program = parserServices.program;
        const compilerOptions = program.getCompilerOptions();

        // Read option — default true
        const allowBarrelOfBarrels = context.options[0]?.allowBarrelOfBarrels !== false;

        return {
            ExportAllDeclaration(node) {
                const importSource = node.source.value;

                // Only check relative imports — skip external packages
                if(!importSource.startsWith('.')) {
                    return;
                }

                // If barrel-of-barrels is allowed, check if resolved file is an index.ts
                if(allowBarrelOfBarrels) {
                    const sourceFile = resolveImportToSourceFile(importSource, filename, program, compilerOptions);
                    if(sourceFile && path.basename(sourceFile.fileName) === 'index.ts') {
                        // Resolved to another barrel — allowed
                        return;
                    }
                    // Could not resolve OR resolved to a non-barrel — report
                }

                context.report({
                    node,
                    messageId: 'starFromNonBarrel',
                    data:      { source: importSource },
                });
            },
        };
    },
};

export default rule;
