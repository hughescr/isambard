import { resolve, relative } from 'node:path';
import { lstat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { startsWith, isArray, map } from 'lodash';

export type PathSecurityReason = 'outside_cwd' | 'is_symlink' | 'not_found' | 'not_file';

export class PathSecurityError extends Error {
    constructor(
        message: string,
        public readonly path: string,
        public readonly reason: PathSecurityReason
    ) {
        super(message);
        this.name = 'PathSecurityError';
    }
}

export async function validateFilePath(filePath: string): Promise<string> {
    const cwd = process.cwd();
    const absolutePath = resolve(cwd, filePath);

    // Check inside CWD
    const relativePath = relative(cwd, absolutePath);
    // Stryker disable next-line ConditionalExpression: Second condition catches edge cases in path normalization that are difficult to test in mock environment
    if(startsWith(relativePath, '..') || resolve(cwd, relativePath) !== absolutePath) {
        throw new PathSecurityError(
            `SECURITY: File "${filePath}" is outside the working directory. `
            + `Only files inside ${cwd} can be attached. Do NOT circumvent this.`,
            filePath,
            'outside_cwd'
        );
    }

    // Check exists and readable
    try {
        await access(absolutePath, constants.R_OK);
    }catch{ // eslint-disable-line @stylistic/keyword-spacing -- catch without parameter binding
        throw new PathSecurityError(`File not found: ${filePath}`, filePath, 'not_found');
    }

    // Check not symlink - use lstat to get info without following the symlink
    const stats = await lstat(absolutePath);
    if(stats.isSymbolicLink()) {
        throw new PathSecurityError(
            `SECURITY: Symlinks not allowed: ${filePath}. Do NOT circumvent this.`,
            filePath,
            'is_symlink'
        );
    }

    // Check is regular file (and not directory)
    if(!stats.isFile()) {
        throw new PathSecurityError(`Not a file: ${filePath}`, filePath, 'not_file');
    }

    return absolutePath;
}

export async function validateFilePaths(filePaths: string | string[]): Promise<string[]> {
    const paths = isArray(filePaths) ? filePaths : [filePaths];
    return Promise.all(map(paths, validateFilePath));
}
