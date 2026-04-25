/**
 * ESLint Rule: no-internal-in-barrel
 *
 * Prevents barrel index.ts files from re-exporting @internal-tagged exports.
 * Barrel files (src/[**]/index.ts pattern) should only expose the public API surface.
 *
 * This rule uses TypeScript's AST and JSDoc parsing to check for @internal tags
 * on the original export declarations in the source module.
 *
 * How it works:
 * 1. Applies only to files named index.ts (scope to src/ is enforced by eslint.config.mjs)
 * 2. For each ExportNamedDeclaration with a relative source (export { Foo } from './module')
 * 3. Resolves the source file using TypeScript's module resolution
 * 4. For each exported specifier, checks if the original declaration has @internal JSDoc
 * 5. Reports an error on the offending export specifier
 *
 * Note: star re-exports (export * from '...') are skipped — names cannot be enumerated
 * without full type resolution. The rule fires on whichever barrel directly re-exports
 * the @internal symbol; chain-breaking at any link prevents propagation.
 *
 * Note: Uses native methods and sync file operations (necessary for ESLint rules)
 */

import path from 'node:path';
import { isExportInternal, resolveImportToSourceFile } from './_ts-helpers.mjs';

const rule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow barrel index.ts files from re-exporting @internal-tagged exports',
            category:    'Best Practices',
        },
        messages: {
            internalInBarrel: "'{{name}}' is marked @internal and must not be re-exported from a barrel index.ts.",
        },
        schema: [],
    },

    create(context) {
        const filename = context.filename;

        // Only apply to barrel files: any index.ts
        // (Scope restriction to src/**/*.ts is enforced by eslint.config.mjs; no need to re-check here)
        if(path.basename(filename) !== 'index.ts') {
            return {};
        }

        // Require TypeScript program for type-aware resolution
        const parserServices = context.sourceCode?.parserServices;
        if(!parserServices?.program) {
            return {};
        }

        const program = parserServices.program;
        const compilerOptions = program.getCompilerOptions();

        return {
            ExportNamedDeclaration(node) {
                // Only handle re-exports with a source: export { Foo } from './module'
                if(!node.source) {
                    return;
                }

                const importSource = node.source.value;

                // Only check relative imports — skip external packages
                if(!importSource.startsWith('.')) {
                    return;
                }

                // Resolve to source file
                const sourceFile = resolveImportToSourceFile(importSource, filename, program, compilerOptions);
                if(!sourceFile) {
                    return;
                }

                // Check each exported specifier
                for(const specifier of node.specifiers) {
                    // The exported name the caller uses is specifier.exported.name
                    // The original name in the source is specifier.local.name
                    const originalName = specifier.local.name;

                    if(isExportInternal(sourceFile, originalName)) {
                        context.report({
                            node:      specifier,
                            messageId: 'internalInBarrel',
                            data:      { name: originalName },
                        });
                    }
                }
            },
        };
    },
};

export default rule;
