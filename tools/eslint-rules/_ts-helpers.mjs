/**
 * Shared TypeScript AST helpers for ESLint rules that inspect @internal JSDoc tags.
 *
 * Internal module — the underscore prefix means this is not itself an ESLint rule.
 * Import from no-cross-module-internal.mjs and no-internal-in-barrel.mjs only.
 */

// eslint-disable-next-line import-x/no-extraneous-dependencies -- ESLint rule in tools/ uses devDependencies
import ts from 'typescript';

/**
 * Check if a TypeScript AST node has an @internal JSDoc tag.
 *
 * Tries ts.getJSDocTags() first (works when the JSDoc cache is populated by the
 * type-checker). Falls back to reading node.jsDoc directly for cases where the cache
 * is not populated (e.g. `export default class Foo {}` in some compilation modes).
 *
 * Module-private: only called by `isExportInternal` within this file.
 */
function hasInternalJSDocTag(node) {
    // Primary: ts.getJSDocTags() uses the type-checker's JSDoc cache
    const jsdocTags = ts.getJSDocTags(node);
    if(jsdocTags.some(tag => tag.tagName.text === 'internal')) {
        return true;
    }
    // Fallback: read node.jsDoc directly (populated by the parser regardless of type-check)
    const jsDocs = node.jsDoc ?? [];
    for(const doc of jsDocs) {
        const docTags = doc.tags ?? [];
        if(docTags.some(tag => tag.tagName.text === 'internal')) {
            return true;
        }
    }
    return false;
}

/**
 * Find if a named export in a source file has the @internal JSDoc tag.
 *
 * Handles the following declaration kinds:
 *   - VariableStatement    (export const foo = ...)
 *   - FunctionDeclaration  (export function foo() {})
 *   - ClassDeclaration     (export class Foo {})
 *   - InterfaceDeclaration (export interface Foo {})
 *   - TypeAliasDeclaration (export type Foo = ...)
 *   - EnumDeclaration      (export enum Foo {})
 *   - ModuleDeclaration    (export namespace Foo {} / export module Foo {})
 *   - ExportAssignment     (export default ...) — checked when exportedName === 'default'
 *   - ExportDeclaration    (export { Foo } from './x' or export { Foo }) — checks @internal
 *                           on the re-export statement itself, not the original declaration.
 *
 * For the named re-export case (ExportDeclaration), the @internal check is on the re-export
 * statement — not the original source. This is intentional: chain-breaking at the
 * re-export level is sufficient, and chasing the original would require recursive resolution.
 *
 * @param {ts.SourceFile} sourceFile - The TS source file to inspect.
 * @param {string} exportedName - The name to look up (use 'default' for default exports).
 * @returns {boolean} true if the named export is marked @internal.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity, complexity -- ESLint rule walks TypeScript AST; branching is inherent to handling multiple declaration kinds
export function isExportInternal(sourceFile, exportedName) {
    for(const statement of sourceFile.statements) {
        // ── VariableStatement: export const foo = ... ──────────────────────────────────
        if(ts.isVariableStatement(statement)
          && statement.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
            for(const declaration of statement.declarationList.declarations) {
                if(ts.isIdentifier(declaration.name) && declaration.name.text === exportedName) {
                    return hasInternalJSDocTag(statement);
                }
            }
        }

        // ── Named declarations with a .name property ───────────────────────────────────
        // Covers: FunctionDeclaration, ClassDeclaration, InterfaceDeclaration,
        //         TypeAliasDeclaration, EnumDeclaration, ModuleDeclaration (namespace/module)
        if((ts.isFunctionDeclaration(statement)
          || ts.isClassDeclaration(statement)
          || ts.isInterfaceDeclaration(statement)
          || ts.isTypeAliasDeclaration(statement)
          || ts.isEnumDeclaration(statement)
          || ts.isModuleDeclaration(statement))
        && statement.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)
        && statement.name?.text === exportedName) {
            return hasInternalJSDocTag(statement);
        }

        // ── Default export forms — only matched when looking for 'default' ──────────────
        if(exportedName === 'default') {
            // ExportAssignment: `export default expr` or `export default function() {}`
            if(ts.isExportAssignment(statement) && !statement.isExportEquals) {
                return hasInternalJSDocTag(statement);
            }
            // Named class/function with export+default modifiers: `export default class Foo {}`
            // or `export default function foo() {}`. These are NOT ExportAssignments.
            if((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement))
              && statement.modifiers?.some(mod => mod.kind === ts.SyntaxKind.DefaultKeyword)
              && statement.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
                return hasInternalJSDocTag(statement);
            }
        }

        // ── Re-export declaration: export { Foo } from '...' or export { Foo } ─────────
        // Checks @internal on the re-export statement itself (not the original declaration).
        if(ts.isExportDeclaration(statement)
          && statement.exportClause
          && ts.isNamedExports(statement.exportClause)) {
            for(const element of statement.exportClause.elements) {
                // element.name is always the exported (post-alias) name — what callers import.
                // element.propertyName (optional) is the original (pre-alias) name inside the module.
                // We must match on element.name, not element.propertyName: callers use the exported name.
                const elementExportedName = element.name.text;
                if(elementExportedName === exportedName) {
                    return hasInternalJSDocTag(statement);
                }
            }
        }
    }

    return false;
}

/**
 * Resolve an import source string to a TypeScript SourceFile using TS module resolution.
 *
 * @param {string} importSource - The import path (e.g. './foo', '@/bar', 'some-pkg').
 * @param {string} filename - The file containing the import (used as resolution base).
 * @param {ts.Program} program - The TypeScript program instance.
 * @param {ts.CompilerOptions} compilerOptions - Compiler options from the program.
 * @returns {ts.SourceFile | null} The resolved SourceFile, or null if not found.
 */
export function resolveImportToSourceFile(importSource, filename, program, compilerOptions) {
    const resolved = ts.resolveModuleName(
        importSource,
        filename,
        compilerOptions,
        ts.sys
    );

    if(resolved.resolvedModule) {
        return program.getSourceFile(resolved.resolvedModule.resolvedFileName) ?? null;
    }

    return null;
}
