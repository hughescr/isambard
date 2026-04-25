import type ts from 'typescript';

/**
 * Find if a named export in a source file has the @internal JSDoc tag.
 *
 * @param sourceFile - The TS source file to inspect.
 * @param exportedName - The name to look up (use 'default' for default exports).
 * @returns true if the named export is marked @internal.
 */
export declare function isExportInternal(sourceFile: ts.SourceFile, exportedName: string): boolean;

/**
 * Resolve an import source string to a TypeScript SourceFile using TS module resolution.
 *
 * @param importSource - The import path (e.g. './foo', '@/bar', 'some-pkg').
 * @param filename - The file containing the import (used as resolution base).
 * @param program - The TypeScript program instance.
 * @param compilerOptions - Compiler options from the program.
 * @returns The resolved SourceFile, or null if not found.
 */
export declare function resolveImportToSourceFile(
    importSource: string,
    filename: string,
    program: ts.Program,
    compilerOptions: ts.CompilerOptions
): ts.SourceFile | null;
