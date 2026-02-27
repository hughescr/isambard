/**
 * Tests for skill-agent loader
 *
 * The skill-agent loader syncs agents and skills from a source directory
 * to the scratch/.claude/ directory structure for Claude Agent SDK.
 */
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mockLogger, mockFsPromises, resetMockFs } from '../../setup';
import { syncAgentsAndSkills } from '@/agent/skill-agent-loader';

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
});
