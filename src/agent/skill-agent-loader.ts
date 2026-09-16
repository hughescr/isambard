/**
 * Skill and Agent Loader
 *
 * Synchronizes agents and skills from a source directory to the target
 * .claude directory structure for Claude Agent SDK.
 */

import { constants } from 'node:fs';
import { readdir, rm, mkdir, copyFile, stat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@hughescr/logger';
import pLimit from 'p-limit';
/**
 * Recursively copies all files from source to destination using COPYFILE_FICLONE.
 *
 * @param sourceDir - Source directory path
 * @param destDir - Destination directory path
 */
async function copyDirectory(sourceDir: string, destDir: string, limit: ReturnType<typeof pLimit>): Promise<void> {
    const entries = await limit(() => readdir(sourceDir, { withFileTypes: true }));

    const results = await Promise.allSettled(entries.map(async (entry) => {
        const sourcePath = path.join(sourceDir, entry.name);
        const destPath = path.join(destDir, entry.name);

        if(entry.isDirectory()) {
            // Create directory and recurse
            await limit(() => mkdir(destPath, { recursive: true }));
            await copyDirectory(sourcePath, destPath, limit);
        } else if(entry.isFile()) {
            // Copy file with FICLONE flag
            // For test compatibility, we read and write when copyFile with FICLONE fails
            await limit(async () => {
                try {
                    await copyFile(sourcePath, destPath, constants.COPYFILE_FICLONE);
                } catch{
                    // COPYFILE_FICLONE is only a performance hint; copy bytes if unavailable.
                    const content = await readFile(sourcePath);
                    await writeFile(destPath, content);
                }
            });
            // Stryker restore BlockStatement
        }
        // Stryker restore ConditionalExpression
    }));
    // A rejected child must not let the caller tear down or reuse the target while
    // other admitted copies (including recursive children) are still writing.
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if(failure) {
        throw failure.reason;
    }
}

/**
 * Clears all contents of a directory without removing the directory itself.
 *
 * @param dirPath - Directory to clear
 */
async function clearDirectory(dirPath: string): Promise<void> {
    try {
        // Remove entire directory and recreate it
        await rm(dirPath, { recursive: true, force: true });
        await mkdir(dirPath, { recursive: true });
    } catch (error) {
        // If removal fails, try to create the directory
        if((error as NodeJS.ErrnoException).code === 'ENOENT') {
            await mkdir(dirPath, { recursive: true });
        } else {
            throw error;
        }
    }
    // Stryker restore BlockStatement,ObjectLiteral,BooleanLiteral,ConditionalExpression,EqualityOperator,StringLiteral
}

/**
 * Synchronizes agents and skills from source root to target root.
 *
 * Creates target/agents/ and target/skills/ if they don't exist.
 * Clears existing contents before copying.
 * Handles missing or empty source directories gracefully.
 *
 * @param sourceRoot - Absolute path to source directory containing agents/ and skills/
 * @param targetRoot - Absolute path to target directory (typically scratch/.claude/)
 */
export async function syncAgentsAndSkills(
    sourceRoot: string,
    targetRoot: string
): Promise<void> {
    const limit = pLimit(8);
    const agentsSourcePath = path.join(sourceRoot, 'agents');
    const skillsSourcePath = path.join(sourceRoot, 'skills');
    const agentsTargetPath = path.join(targetRoot, 'agents');
    const skillsTargetPath = path.join(targetRoot, 'skills');

    async function syncOne(sourcePath: string, targetPath: string, name: 'agents' | 'skills'): Promise<void> {
        let sourceStats: Awaited<ReturnType<typeof stat>>;
        try {
            sourceStats = await stat(sourcePath);
        } catch (error) {
            // Only a missing source root is optional. A missing child after the
            // root was observed is a copy failure and must propagate.
            if((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            await mkdir(targetPath, { recursive: true });
            logger.warn({ source: sourcePath, msg: `Source directory does not exist, skipping ${name} sync` });
            return;
        }
        if(!sourceStats.isDirectory()) {
            return;
        }
        await clearDirectory(targetPath);
        await copyDirectory(sourcePath, targetPath, limit);
        logger.info({ source: sourcePath, target: targetPath, msg: `Synced ${name} directory` });
    }

    await syncOne(agentsSourcePath, agentsTargetPath, 'agents');
    await syncOne(skillsSourcePath, skillsTargetPath, 'skills');
}
