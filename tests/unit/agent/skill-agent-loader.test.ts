/**
 * Tests for skill-agent loader
 *
 * The skill-agent loader syncs agents and skills from a source directory
 * to the scratch/.claude/ directory structure for Claude Agent SDK.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import { mockLogger, mockFsPromises, resetMockFs } from '../../setup';
import { syncAgentsAndSkills } from '@/agent/skill-agent-loader';

function waitForEventLoopCheckpoint(): Promise<void> {
    return new Promise((resolve) => {
        // eslint-disable-next-line no-restricted-syntax -- gates remain closed; this checks ordering after runnable async work without elapsed-time policy.
        setImmediate(resolve);
    });
}

describe('syncAgentsAndSkills', () => {
    const tempSourceRoot = '/test-source';
    const tempTargetRoot = '/test-target';

    beforeEach(async () => {
        // Clear mock logger
        mockLogger.debug.mockClear();
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
    });

    afterEach(async () => {
        // Clean up mock filesystem
        resetMockFs();
    });

    test('should create target agents and skills directories if they do not exist', async () => {
        // Setup: Create source directories with content
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'agents', 'test-agent.md'), '# Test Agent');
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'skills', 'test-skill.md'), '# Test Skill');

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        // Verify target directories were created by checking if we can read them
        const agentsContents = await mockFsPromises.readdir(path.join(tempTargetRoot, 'agents'));
        const skillsContents = await mockFsPromises.readdir(path.join(tempTargetRoot, 'skills'));

        expect(agentsContents).toContain('test-agent.md');
        expect(skillsContents).toContain('test-skill.md');
    });

    test('should copy agents from source to target', async () => {
        // Setup: Create source agents
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'agents', 'agent1.md'), '# Agent 1');
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'agents', 'agent2.md'), '# Agent 2');

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        // Verify agents were copied
        const agent1Content = await mockFsPromises.readFile(path.join(tempTargetRoot, 'agents', 'agent1.md'), 'utf8');
        const agent2Content = await mockFsPromises.readFile(path.join(tempTargetRoot, 'agents', 'agent2.md'), 'utf8');

        expect(agent1Content).toBe('# Agent 1');
        expect(agent2Content).toBe('# Agent 2');
        expect(mockLogger.info).toHaveBeenCalledWith({
            source: path.join(tempSourceRoot, 'agents'),
            target: path.join(tempTargetRoot, 'agents'),
            msg:    'Synced agents directory',
        });
    });

    test('should copy skills from source to target', async () => {
        // Setup: Create source skills
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'skills', 'skill1.md'), '# Skill 1');
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'skills', 'skill2.md'), '# Skill 2');

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        // Verify skills were copied
        const skill1Content = await mockFsPromises.readFile(path.join(tempTargetRoot, 'skills', 'skill1.md'), 'utf8');
        const skill2Content = await mockFsPromises.readFile(path.join(tempTargetRoot, 'skills', 'skill2.md'), 'utf8');

        expect(skill1Content).toBe('# Skill 1');
        expect(skill2Content).toBe('# Skill 2');
        expect(mockLogger.info).toHaveBeenCalledWith({
            source: path.join(tempSourceRoot, 'skills'),
            target: path.join(tempTargetRoot, 'skills'),
            msg:    'Synced skills directory',
        });
    });

    test('should clear existing target directory contents before copying', async () => {
        // Setup: Create source and target with initial content
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempTargetRoot, 'agents'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempTargetRoot, 'skills'), { recursive: true });

        // Add stale files in target
        await mockFsPromises.writeFile(path.join(tempTargetRoot, 'agents', 'stale-agent.md'), '# Stale Agent');
        await mockFsPromises.writeFile(path.join(tempTargetRoot, 'skills', 'stale-skill.md'), '# Stale Skill');

        // Add new files in source
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'agents', 'new-agent.md'), '# New Agent');
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'skills', 'new-skill.md'), '# New Skill');

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        // Verify stale files are removed
        const agentsContents = await mockFsPromises.readdir(path.join(tempTargetRoot, 'agents'));
        const skillsContents = await mockFsPromises.readdir(path.join(tempTargetRoot, 'skills'));

        expect(agentsContents).not.toContain('stale-agent.md');
        expect(skillsContents).not.toContain('stale-skill.md');

        // Verify new files are present
        expect(agentsContents).toContain('new-agent.md');
        expect(skillsContents).toContain('new-skill.md');
    });

    test('should handle missing source agents directory gracefully', async () => {
        // Setup: Only create skills directory
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'skills', 'skill1.md'), '# Skill 1');

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        expect(mockFsPromises.mkdir).toHaveBeenCalledWith(path.join(tempTargetRoot, 'agents'), { recursive: true });

        // Verify warning was logged for missing agents
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                msg: expect.stringContaining('Source directory does not exist'),
            })
        );

        // Verify skills were still copied
        const skill1Content = await mockFsPromises.readFile(path.join(tempTargetRoot, 'skills', 'skill1.md'), 'utf8');
        expect(skill1Content).toBe('# Skill 1');

        // Verify agents directory was created (empty)
        const agentsContents = await mockFsPromises.readdir(path.join(tempTargetRoot, 'agents'));
        expect(agentsContents).toEqual([]);
    });

    test('should handle missing source skills directory gracefully', async () => {
        // Setup: Only create agents directory
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'agents', 'agent1.md'), '# Agent 1');

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        // Verify warning was logged for missing skills
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                msg: expect.stringContaining('Source directory does not exist'),
            })
        );

        // Verify agents were still copied
        const agent1Content = await mockFsPromises.readFile(path.join(tempTargetRoot, 'agents', 'agent1.md'), 'utf8');
        expect(agent1Content).toBe('# Agent 1');

        // Verify skills directory was created (empty)
        const skillsContents = await mockFsPromises.readdir(path.join(tempTargetRoot, 'skills'));
        expect(skillsContents).toEqual([]);
    });

    test('should handle empty source agents directory', async () => {
        // Setup: Create empty source directories
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'skills', 'skill1.md'), '# Skill 1');

        // Add stale content in target
        await mockFsPromises.mkdir(path.join(tempTargetRoot, 'agents'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempTargetRoot, 'agents', 'old-agent.md'), '# Old Agent');

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        // Verify target agents directory was cleared
        const agentsContents = await mockFsPromises.readdir(path.join(tempTargetRoot, 'agents'));
        expect(agentsContents).not.toContain('old-agent.md');
        expect(agentsContents).toEqual([]);
    });

    test('should handle empty source skills directory', async () => {
        // Setup: Create empty source directories
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'agents', 'agent1.md'), '# Agent 1');

        // Add stale content in target
        await mockFsPromises.mkdir(path.join(tempTargetRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempTargetRoot, 'skills', 'old-skill.md'), '# Old Skill');

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        // Verify target skills directory was cleared
        const skillsContents = await mockFsPromises.readdir(path.join(tempTargetRoot, 'skills'));
        expect(skillsContents).not.toContain('old-skill.md');
        expect(skillsContents).toEqual([]);
    });

    test('should copy nested skill directories correctly', async () => {
        // Setup: Create nested skill structure
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills', 'memory-reflection'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'skills', 'memory-reflection', 'SKILL.md'), '# Memory Reflection Skill');
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'skills', 'memory-reflection', 'config.json'), '{"enabled": true}');

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        // Verify nested structure was copied
        const skillContent = await mockFsPromises.readFile(path.join(tempTargetRoot, 'skills', 'memory-reflection', 'SKILL.md'), 'utf8');
        const configContent = await mockFsPromises.readFile(path.join(tempTargetRoot, 'skills', 'memory-reflection', 'config.json'), 'utf8');

        expect(skillContent).toBe('# Memory Reflection Skill');
        expect(configContent).toBe('{"enabled": true}');
    });

    test('creates a nested target directory before reading its source contents', async () => {
        const sourceNested = path.join(tempSourceRoot, 'agents', 'nested');
        const targetNested = path.join(tempTargetRoot, 'agents', 'nested');
        await mockFsPromises.mkdir(sourceNested, { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(path.join(sourceNested, 'agent.md'), '# Agent');

        const mkdirImpl = mockFsPromises.mkdir.getMockImplementation()!;
        const readdirImpl = mockFsPromises.readdir.getMockImplementation()!;
        const mkdirStarted = Promise.withResolvers<void>();
        const releaseMkdir = Promise.withResolvers<void>();
        let nestedReadStarted = false;
        mockFsPromises.mkdir.mockImplementation(async (directory, options) => {
            if(directory === targetNested) {
                mkdirStarted.resolve();
                await releaseMkdir.promise;
            }
            return mkdirImpl(directory, options);
        });
        mockFsPromises.readdir.mockImplementation(async (directory, options) => {
            if(directory === sourceNested) {
                nestedReadStarted = true;
            }
            return readdirImpl(directory, options);
        });

        const operation = syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);
        try {
            await mkdirStarted.promise;
            await waitForEventLoopCheckpoint();
            expect(nestedReadStarted).toBe(false);
        } finally {
            releaseMkdir.resolve();
            await operation;
        }
        expect(await mockFsPromises.readFile(path.join(targetNested, 'agent.md'), 'utf8')).toBe('# Agent');
    });

    test('propagates fallback write failures through synchronization', async () => {
        const sourceFile = path.join(tempSourceRoot, 'agents', 'agent.md');
        const targetFile = path.join(tempTargetRoot, 'agents', 'agent.md');
        await mockFsPromises.mkdir(path.dirname(sourceFile), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(sourceFile, '# Agent');

        const writeFileImpl = mockFsPromises.writeFile.getMockImplementation()!;
        const writeFailure = new Error('target became read-only');
        mockFsPromises.writeFile.mockImplementation((destination, content) => {
            if(destination === targetFile) {
                const rejectedWrite = Promise.reject(writeFailure);
                void rejectedWrite.catch(() => undefined);
                return rejectedWrite;
            }
            return writeFileImpl(destination, content);
        });

        await expect(syncAgentsAndSkills(tempSourceRoot, tempTargetRoot)).rejects.toBe(writeFailure);
    });

    test('should use COPYFILE_FICLONE flag when copying', async () => {
        // This test verifies the behavior - the flag is used internally
        // Setup: Create source with content
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'agents', 'agent.md'), '# Agent');

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        // Verify the copy worked (flag was used correctly)
        const agentContent = await mockFsPromises.readFile(path.join(tempTargetRoot, 'agents', 'agent.md'), 'utf8');
        expect(agentContent).toBe('# Agent');
    });

    test('waits for admitted copies to settle and propagates a missing child as an error', async () => {
        const agents = path.join(tempSourceRoot, 'agents');
        const skills = path.join(tempSourceRoot, 'skills');
        await mockFsPromises.mkdir(agents, { recursive: true });
        await mockFsPromises.mkdir(skills, { recursive: true });
        await mockFsPromises.writeFile(path.join(agents, 'held.md'), '# Held');
        await mockFsPromises.writeFile(path.join(agents, 'missing.md'), '# Missing');

        const heldStarted = Promise.withResolvers<void>();
        const releaseHeld = Promise.withResolvers<void>();
        const failedRead = Promise.withResolvers<void>();
        mockFsPromises.readFile.mockImplementation(async (source) => {
            if(source.endsWith('held.md')) {
                heldStarted.resolve();
                await releaseHeld.promise;
                return '# Held';
            }
            if(source.endsWith('missing.md')) {
                await heldStarted.promise;
                failedRead.resolve();
                const error = new Error('child disappeared') as NodeJS.ErrnoException;
                error.code = 'ENOENT';
                throw error;
            }
            throw new Error(`Unexpected read: ${source}`);
        });

        let settled = false;
        const outcome = syncAgentsAndSkills(tempSourceRoot, tempTargetRoot)
            .then(() => null)
            .catch((error: unknown) => error)
            .finally(() => { settled = true; });
        await failedRead.promise;
        await Bun.sleep(1);
        expect(settled).toBe(false);

        releaseHeld.resolve();
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('child disappeared');
        expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.objectContaining({
            msg: expect.stringContaining('Source directory does not exist'),
        }));
    });

    test('bounds file I/O across recursive directories without serializing all copies', async () => {
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await Promise.all(Array.from({ length: 12 }, async (_, index) => {
            const child = path.join(tempSourceRoot, 'agents', `nested-${index}`);
            await mockFsPromises.mkdir(child, { recursive: true });
            await mockFsPromises.writeFile(path.join(child, 'AGENT.md'), '# Agent');
        }));
        let active = 0;
        let peak = 0;
        mockFsPromises.readFile.mockImplementation(async () => {
            active++;
            peak = Math.max(peak, active);
            await Bun.sleep(1);
            active--;
            return '# Agent';
        });

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(8);
        const listings = await Promise.all(Array.from({ length: 12 }, (_, index) =>
            mockFsPromises.readdir(path.join(tempTargetRoot, 'agents', `nested-${index}`))));
        expect(listings.every(names => names.includes('AGENT.md'))).toBe(true);
    });

    test('uses recursive operations to replace existing nested target content', async () => {
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents', 'nested'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'agents', 'nested', 'agent.md'), 'current');
        await mockFsPromises.mkdir(path.join(tempTargetRoot, 'agents', 'old'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempTargetRoot, 'agents', 'old', 'stale.md'), 'stale');
        mockFsPromises.rm.mockClear();
        mockFsPromises.mkdir.mockClear();

        await syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);

        expect(mockFsPromises.rm).toHaveBeenCalledWith(path.join(tempTargetRoot, 'agents'), { recursive: true, force: true });
        expect(mockFsPromises.mkdir).toHaveBeenCalledWith(path.join(tempTargetRoot, 'agents'), { recursive: true });
        expect(mockFsPromises.mkdir).toHaveBeenCalledWith(path.join(tempTargetRoot, 'agents', 'nested'), { recursive: true });
        await expect(mockFsPromises.readdir(path.join(tempTargetRoot, 'agents', 'old'))).rejects.toThrow();
        expect(await mockFsPromises.readFile(path.join(tempTargetRoot, 'agents', 'nested', 'agent.md'), 'utf8')).toBe('current');
    });

    test('recreates a cleared target before copying source entries', async () => {
        const sourceAgents = path.join(tempSourceRoot, 'agents');
        const targetAgents = path.join(tempTargetRoot, 'agents');
        await mockFsPromises.mkdir(sourceAgents, { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.mkdir(targetAgents, { recursive: true });
        await mockFsPromises.writeFile(path.join(sourceAgents, 'agent.md'), '# Agent');

        const mkdirImpl = mockFsPromises.mkdir.getMockImplementation()!;
        const readdirImpl = mockFsPromises.readdir.getMockImplementation()!;
        const mkdirStarted = Promise.withResolvers<void>();
        const releaseMkdir = Promise.withResolvers<void>();
        let sourceReadStarted = false;
        mockFsPromises.mkdir.mockImplementation(async (directory, options) => {
            if(directory === targetAgents) {
                mkdirStarted.resolve();
                await releaseMkdir.promise;
            }
            return mkdirImpl(directory, options);
        });
        mockFsPromises.readdir.mockImplementation(async (directory, options) => {
            if(directory === sourceAgents) {
                sourceReadStarted = true;
            }
            return readdirImpl(directory, options);
        });

        const operation = syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);
        try {
            await mkdirStarted.promise;
            await waitForEventLoopCheckpoint();
            expect(sourceReadStarted).toBe(false);
        } finally {
            releaseMkdir.resolve();
            await operation;
        }
        expect(await mockFsPromises.readFile(path.join(targetAgents, 'agent.md'), 'utf8')).toBe('# Agent');
    });

    test('ignores symbolic links in a source directory', async () => {
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.symlink('/outside/secret', path.join(tempSourceRoot, 'agents', 'link'));
        await expect(syncAgentsAndSkills(tempSourceRoot, tempTargetRoot)).resolves.toBeUndefined();
        expect(await mockFsPromises.readdir(path.join(tempTargetRoot, 'agents'))).toEqual([]);
    });

    test('does not clear a target when its source is a file', async () => {
        await mockFsPromises.mkdir(tempSourceRoot, { recursive: true });
        await mockFsPromises.writeFile(path.join(tempSourceRoot, 'agents'), 'not a directory');
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempTargetRoot, 'agents'), { recursive: true });
        await mockFsPromises.writeFile(path.join(tempTargetRoot, 'agents', 'existing.md'), 'keep');
        await expect(syncAgentsAndSkills(tempSourceRoot, tempTargetRoot)).resolves.toBeUndefined();
        expect(await mockFsPromises.readFile(path.join(tempTargetRoot, 'agents', 'existing.md'), 'utf8')).toBe('keep');
    });

    test('propagates source stat failures other than missing source', async () => {
        const denied = new Error('permission denied') as NodeJS.ErrnoException;
        denied.code = 'EACCES';
        mockFsPromises.stat.mockRejectedValueOnce(denied);
        await expect(syncAgentsAndSkills(tempSourceRoot, tempTargetRoot)).rejects.toBe(denied);
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('recreates the target when removal races with another remover', async () => {
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        const missing = new Error('already removed') as NodeJS.ErrnoException;
        missing.code = 'ENOENT';
        mockFsPromises.rm.mockRejectedValueOnce(missing);
        mockFsPromises.mkdir.mockClear();
        await expect(syncAgentsAndSkills(tempSourceRoot, tempTargetRoot)).resolves.toBeUndefined();
        expect(mockFsPromises.mkdir).toHaveBeenCalledWith(path.join(tempTargetRoot, 'agents'), { recursive: true });
    });

    test('finishes ENOENT recovery before copying source entries', async () => {
        const sourceAgents = path.join(tempSourceRoot, 'agents');
        const targetAgents = path.join(tempTargetRoot, 'agents');
        await mockFsPromises.mkdir(sourceAgents, { recursive: true });
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });
        await mockFsPromises.writeFile(path.join(sourceAgents, 'agent.md'), '# Agent');

        const rmImpl = mockFsPromises.rm.getMockImplementation()!;
        const mkdirImpl = mockFsPromises.mkdir.getMockImplementation()!;
        const readdirImpl = mockFsPromises.readdir.getMockImplementation()!;
        const missing = new Error('already removed') as NodeJS.ErrnoException;
        missing.code = 'ENOENT';
        const mkdirStarted = Promise.withResolvers<void>();
        const releaseMkdir = Promise.withResolvers<void>();
        let sourceReadStarted = false;
        mockFsPromises.rm.mockImplementation(async (directory, options) => {
            if(directory === targetAgents) {
                throw missing;
            }
            return rmImpl(directory, options);
        });
        mockFsPromises.mkdir.mockImplementation(async (directory, options) => {
            if(directory === targetAgents) {
                mkdirStarted.resolve();
                await releaseMkdir.promise;
            }
            return mkdirImpl(directory, options);
        });
        mockFsPromises.readdir.mockImplementation(async (directory, options) => {
            if(directory === sourceAgents) {
                sourceReadStarted = true;
            }
            return readdirImpl(directory, options);
        });

        const operation = syncAgentsAndSkills(tempSourceRoot, tempTargetRoot);
        try {
            await mkdirStarted.promise;
            await waitForEventLoopCheckpoint();
            expect(sourceReadStarted).toBe(false);
        } finally {
            releaseMkdir.resolve();
            await operation;
        }
        expect(await mockFsPromises.readFile(path.join(targetAgents, 'agent.md'), 'utf8')).toBe('# Agent');
    });

    test('creates an empty target for a missing source before synchronization completes', async () => {
        const targetAgents = path.join(tempTargetRoot, 'agents');
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'skills'), { recursive: true });

        const mkdirImpl = mockFsPromises.mkdir.getMockImplementation()!;
        const mkdirStarted = Promise.withResolvers<void>();
        const releaseMkdir = Promise.withResolvers<void>();
        mockFsPromises.mkdir.mockImplementation(async (directory, options) => {
            if(directory === targetAgents) {
                mkdirStarted.resolve();
                await releaseMkdir.promise;
            }
            return mkdirImpl(directory, options);
        });

        let completed = false;
        const operation = syncAgentsAndSkills(tempSourceRoot, tempTargetRoot)
            .finally(() => { completed = true; });
        try {
            await mkdirStarted.promise;
            await waitForEventLoopCheckpoint();
            expect(completed).toBe(false);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        } finally {
            releaseMkdir.resolve();
            await operation;
        }
        expect(await mockFsPromises.readdir(targetAgents)).toEqual([]);
    });

    test('propagates target removal failures other than an already removed directory', async () => {
        await mockFsPromises.mkdir(path.join(tempSourceRoot, 'agents'), { recursive: true });
        const denied = new Error('permission denied') as NodeJS.ErrnoException;
        denied.code = 'EACCES';
        mockFsPromises.rm.mockRejectedValueOnce(denied);
        await expect(syncAgentsAndSkills(tempSourceRoot, tempTargetRoot)).rejects.toBe(denied);
    });
});
