/* eslint-disable lodash/prefer-lodash-method, complexity -- ESLint rules require sync file operations and native methods, complex logic unavoidable */
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

import { relative } from 'node:path';
import ts from 'typescript';

// Module patterns from boundaries config (hardcoded to avoid circular import issues)
// These MUST stay in sync with eslint-boundaries.config.mjs
const MODULE_PATTERNS = [
    { type: 'utils',   pattern: /^src\/utils\// },
    { type: 'config',  pattern: /^src\/config\// },
    { type: 'storage', pattern: /^src\/storage\// },
    { type: 'agent',   pattern: /^src\/agent\// },
    { type: 'discord', pattern: /^src\/integrations\/discord\// },
    { type: 'app',     pattern: /^src\/index\.ts$/ },
];

/**
 * Determine which module a file belongs to based on its relative path.
 */
function getModuleForFile(filePath, cwd) {
    const rel = relative(cwd, filePath).replace(/\\/g, '/');
    for(const { type, pattern } of MODULE_PATTERNS) {
        if(pattern.test(rel)) {
            return type;
        }
    }
    return null; // Not in any known module (e.g., test files, tools)
}

/**
 * Check if a TypeScript export declaration has @internal JSDoc tag.
 * Uses TypeScript's AST and JSDoc parser.
 */
function hasInternalJSDocTag(node) {
    const jsdocTags = ts.getJSDocTags(node);
    return jsdocTags.some(tag => tag.tagName.text === 'internal');
}

/**
 * Find if an export in a source file has @internal tag.
 * Uses TypeScript's AST to locate the export and check JSDoc.
 */
function isExportInternal(sourceFile, exportedName) {
    // Walk through all statements in the file
    for(const statement of sourceFile.statements) {
        // Look for ExportDeclaration nodes (export { ... } from '...')
        if(ts.isExportDeclaration(statement) && statement.exportClause) {
            // Named exports
            if(ts.isNamedExports(statement.exportClause)) {
                for(const element of statement.exportClause.elements) {
                    // element.name is the exported name (after 'as' if present)
                    const exportName = element.name.text;
                    if(exportName === exportedName) {
                        return hasInternalJSDocTag(statement);
                    }
                }
            }
        }

        // Also check direct exports: export const foo = ..., export function foo() {}, etc.
        if(ts.isVariableStatement(statement)
          && statement.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
            for(const declaration of statement.declarationList.declarations) {
                if(ts.isIdentifier(declaration.name) && declaration.name.text === exportedName) {
                    return hasInternalJSDocTag(statement);
                }
            }
        }

        if((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
          && statement.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)
          && statement.name?.text === exportedName) {
            return hasInternalJSDocTag(statement);
        }
    }

    return false;
}

/**
 * Resolve import source to actual file path using TypeScript's module resolution.
 */
function resolveImportToSourceFile(importSource, filename, program, compilerOptions) {
    // Try TypeScript's module resolution
    const resolved = ts.resolveModuleName(
        importSource,
        filename,
        compilerOptions,
        ts.sys
    );

    if(resolved.resolvedModule) {
        const resolvedPath = resolved.resolvedModule.resolvedFileName;
        return program.getSourceFile(resolvedPath);
    }

    return null;
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
        const cwd = context.getCwd?.() || process.cwd();
        const filename = context.getFilename();

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
