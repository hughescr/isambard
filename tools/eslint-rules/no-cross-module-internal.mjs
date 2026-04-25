/**
 * ESLint Rule: no-cross-module-internal
 *
 * Prevents importing @internal exports from a different architectural module.
 * Module boundaries are defined in eslint-boundaries.config.mjs.
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
import { isExportInternal, resolveImportToSourceFile } from './_ts-helpers.mjs';

// Module patterns from boundaries config (hardcoded to avoid circular import issues)
// These MUST stay in sync with eslint-boundaries.config.mjs
const MODULE_PATTERNS = [
    { type: 'utils',   pattern: /^src\/utils\// },
    { type: 'errors',  pattern: /^src\/errors\// },
    { type: 'config',  pattern: /^src\/config\// },
    { type: 'storage', pattern: /^src\/storage\// },
    { type: 'agent',   pattern: /^src\/agent\// },
    { type: 'discord', pattern: /^src\/integrations\/discord\// },
    { type: 'email',   pattern: /^src\/integrations\/email\// },
    { type: 'app',     pattern: /^src\/(app\/|index\.ts$)/ },
];

/**
 * Determine which module a file belongs to based on its relative path.
 */
function getModuleForFile(filePath, cwd) {
    const rel = path.relative(cwd, filePath).replaceAll('\\', '/');
    for(const { type, pattern } of MODULE_PATTERNS) {
        if(pattern.test(rel)) {
            return type;
        }
    }
    return null; // Not in any known module (e.g., test files, tools)
}

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
        schema: [],
    },

    create(context) {
        const cwd = context.cwd;
        const filename = context.filename;

        // Skip test files
        if(filename.includes('.test.') || filename.includes('.spec.')) {
            return {};
        }

        const importerModule = getModuleForFile(filename, cwd);

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

                const sourceModule = getModuleForFile(sourceFile.fileName, cwd);

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

export default rule;
