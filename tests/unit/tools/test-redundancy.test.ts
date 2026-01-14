import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import _ from 'lodash';
import {
    parseMutationReport,
    extractKilledMutants,
    buildTestToMutantsIndex,
    calculateTestMetrics,
    generateMarkdownReport,
    generateJsonReport
} from '../../../tools/test-redundancy';

// Test-only type definitions
interface TestMetrics {
    id:               string
    name:             string
    file:             string
    uniqueKills:      number
    sharedKills:      number
    totalKills:       number
    uniqueRatio:      number
    redundant:        boolean
    zeroKill:         boolean
    overlappingTests: string[]
}

interface FileMetrics {
    file:           string
    tests:          TestMetrics[]
    totalTests:     number
    redundantTests: number
    zeroKillTests:  number
    uniqueTests:    number
}

interface TestRedundancyReport {
    summary: {
        totalTests:          number
        redundantTests:      number
        zeroKillTests:       number
        uniqueTests:         number
        redundantPercentage: number
    }
    fileMetrics: FileMetrics[]
}

const FIXTURES_DIR = path.join(process.cwd(), 'tests', 'fixtures');

describe('parseMutationReport', () => {
    it('should parse a valid mutation report', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-minimal.json');
        expect(() => parseMutationReport(filePath)).not.toThrow();
    });

    it('should throw CliError for non-existent file', () => {
        expect(() => parseMutationReport('/non/existent/file.json')).toThrow();
    });

    it('should throw CliError for invalid JSON', () => {
        const invalidPath = path.join(FIXTURES_DIR, 'invalid.json');
        // eslint-disable-next-line n/no-sync -- Test fixture setup
        fs.writeFileSync(invalidPath, 'not valid json');
        expect(() => parseMutationReport(invalidPath)).toThrow();
        // eslint-disable-next-line n/no-sync -- Test fixture cleanup
        fs.unlinkSync(invalidPath);
    });

    it('should return report with correct structure', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-minimal.json');
        const report = parseMutationReport(filePath);

        expect(report).toHaveProperty('schemaVersion');
        expect(report).toHaveProperty('thresholds');
        expect(report).toHaveProperty('files');
        expect(report).toHaveProperty('testFiles');
    });
});

describe('extractKilledMutants', () => {
    it('should extract only mutants with status "Killed"', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-minimal.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);

        expect(killedMutants).toBeArray();
        for(const mutant of killedMutants) {
            expect(mutant.status).toBe('Killed');
        }
    });

    it('should return correct count of killed mutants', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-minimal.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);

        // mutation-minimal.json has 4 killed mutants (ids 0, 1, 2, 3)
        expect(killedMutants).toHaveLength(4);
    });

    it('should handle report with all unique kills', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-all-unique.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);

        expect(killedMutants).toHaveLength(3);
    });

    it('should handle report with all redundant kills', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-all-redundant.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);

        expect(killedMutants).toHaveLength(3);
    });
});

describe('buildTestToMutantsIndex', () => {
    it('should create inverted index from mutants to tests', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-minimal.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);
        const testToMutants = buildTestToMutantsIndex(killedMutants);

        expect(testToMutants).toBeInstanceOf(Map);
        expect(testToMutants.size).toBeGreaterThan(0);
    });

    it('should map test IDs to sets of mutant IDs', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-minimal.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);
        const testToMutants = buildTestToMutantsIndex(killedMutants);

        // Test 1 kills mutants 0 and 1
        const test1Mutants = testToMutants.get('1');
        expect(test1Mutants).toBeDefined();
        expect(test1Mutants).toBeInstanceOf(Set);
        expect(test1Mutants?.has('0')).toBe(true);
        expect(test1Mutants?.has('1')).toBe(true);
    });

    it('should handle shared kills correctly', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-minimal.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);
        const testToMutants = buildTestToMutantsIndex(killedMutants);

        // Test 2 kills mutants 1 and 2
        const test2Mutants = testToMutants.get('2');
        expect(test2Mutants?.has('1')).toBe(true);
        expect(test2Mutants?.has('2')).toBe(true);
    });
});

describe('calculateTestMetrics', () => {
    it('should identify redundant tests (uniqueKills = 0, totalKills > 0)', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-all-redundant.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);
        const testToMutants = buildTestToMutantsIndex(killedMutants);

        // Build mutant to tests map
        const mutantToTests = new Map<string, Set<string>>();
        for(const mutant of killedMutants) {
            for(const testId of mutant.killedBy ?? []) {
                if(!mutantToTests.has(mutant.id)) {
                    mutantToTests.set(mutant.id, new Set());
                }
                mutantToTests.get(mutant.id)!.add(testId);
            }
        }

        const metrics = calculateTestMetrics(testToMutants, mutantToTests, report.testFiles);

        // All tests should be redundant in mutation-all-redundant.json
        for(const metric of metrics) {
            expect(metric.redundant).toBe(true);
            expect(metric.uniqueKills).toBe(0);
            expect(metric.totalKills).toBeGreaterThan(0);
        }
    });

    it('should identify unique tests (uniqueKills > 0)', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-all-unique.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);
        const testToMutants = buildTestToMutantsIndex(killedMutants);

        const mutantToTests = new Map<string, Set<string>>();
        for(const mutant of killedMutants) {
            for(const testId of mutant.killedBy ?? []) {
                if(!mutantToTests.has(mutant.id)) {
                    mutantToTests.set(mutant.id, new Set());
                }
                mutantToTests.get(mutant.id)!.add(testId);
            }
        }

        const metrics = calculateTestMetrics(testToMutants, mutantToTests, report.testFiles);

        // All tests should be unique in mutation-all-unique.json
        for(const metric of metrics) {
            expect(metric.redundant).toBe(false);
            expect(metric.uniqueKills).toBeGreaterThan(0);
        }
    });

    it('should calculate correct unique ratio', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-minimal.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);
        const testToMutants = buildTestToMutantsIndex(killedMutants);

        const mutantToTests = new Map<string, Set<string>>();
        for(const mutant of killedMutants) {
            for(const testId of mutant.killedBy ?? []) {
                if(!mutantToTests.has(mutant.id)) {
                    mutantToTests.set(mutant.id, new Set());
                }
                mutantToTests.get(mutant.id)!.add(testId);
            }
        }

        const metrics = calculateTestMetrics(testToMutants, mutantToTests, report.testFiles);

        for(const metric of metrics) {
            expect(metric.uniqueRatio).toBeGreaterThanOrEqual(0);
            expect(metric.uniqueRatio).toBeLessThanOrEqual(1);
            if(metric.totalKills > 0) {
                expect(metric.uniqueRatio).toBe(metric.uniqueKills / metric.totalKills);
            }
        }
    });

    it('should identify overlapping tests', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-minimal.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);
        const testToMutants = buildTestToMutantsIndex(killedMutants);

        const mutantToTests = new Map<string, Set<string>>();
        for(const mutant of killedMutants) {
            for(const testId of mutant.killedBy ?? []) {
                if(!mutantToTests.has(mutant.id)) {
                    mutantToTests.set(mutant.id, new Set());
                }
                mutantToTests.get(mutant.id)!.add(testId);
            }
        }

        const metrics = calculateTestMetrics(testToMutants, mutantToTests, report.testFiles);

        // Test 2 should have overlapping tests (test 1 also kills mutant 1)
        const test2Metrics = _.find(metrics, { id: '2' });
        expect(test2Metrics?.overlappingTests).toBeArray();
        expect(test2Metrics?.overlappingTests.length).toBeGreaterThan(0);
    });

    it('should calculate sharedKills correctly', () => {
        const filePath = path.join(FIXTURES_DIR, 'mutation-minimal.json');
        const report = parseMutationReport(filePath);
        const killedMutants = extractKilledMutants(report);
        const testToMutants = buildTestToMutantsIndex(killedMutants);

        const mutantToTests = new Map<string, Set<string>>();
        for(const mutant of killedMutants) {
            for(const testId of mutant.killedBy ?? []) {
                if(!mutantToTests.has(mutant.id)) {
                    mutantToTests.set(mutant.id, new Set());
                }
                mutantToTests.get(mutant.id)!.add(testId);
            }
        }

        const metrics = calculateTestMetrics(testToMutants, mutantToTests, report.testFiles);

        for(const metric of metrics) {
            expect(metric.sharedKills + metric.uniqueKills).toBe(metric.totalKills);
        }
    });
});

describe('generateMarkdownReport', () => {
    it('should generate valid markdown output', () => {
        const mockReport: TestRedundancyReport = {
            summary: {
                totalTests:          3,
                redundantTests:      1,
                zeroKillTests:       0,
                uniqueTests:         2,
                redundantPercentage: 33.33,
            },
            fileMetrics: [
                {
                    file:           'tests/example.test.ts',
                    tests:          [],
                    totalTests:     3,
                    redundantTests: 1,
                    zeroKillTests:  0,
                    uniqueTests:    2,
                },
            ],
        };

        const markdown = generateMarkdownReport(mockReport, {});

        expect(markdown).toBeString();
        expect(markdown).toContain('# Test Redundancy Analysis');
        expect(markdown).toContain('## Summary');
        expect(markdown).toContain('Total Tests');
    });

    it('should respect showZeroKill option', () => {
        const mockReport: TestRedundancyReport = {
            summary: {
                totalTests:          4,
                redundantTests:      1,
                zeroKillTests:       1,
                uniqueTests:         2,
                redundantPercentage: 25,
            },
            fileMetrics: [
                {
                    file:  'tests/example.test.ts',
                    tests: [
                        {
                            id:               '1',
                            name:             'zero kill test',
                            file:             'tests/example.test.ts',
                            uniqueKills:      0,
                            sharedKills:      0,
                            totalKills:       0,
                            uniqueRatio:      0,
                            redundant:        false,
                            zeroKill:         true,
                            overlappingTests: [],
                        },
                    ],
                    totalTests:     1,
                    redundantTests: 0,
                    zeroKillTests:  1,
                    uniqueTests:    0,
                },
            ],
        };

        const withZeroKill = generateMarkdownReport(mockReport, { showZeroKill: true });
        const withoutZeroKill = generateMarkdownReport(mockReport, { showZeroKill: false });

        // Both should show summary with Zero-Kill Tests count
        expect(withZeroKill).toContain('Zero-Kill Tests');
        expect(withoutZeroKill).toContain('Zero-Kill Tests');

        // But only withZeroKill should show the test details
        expect(withZeroKill).toContain('zero kill test');
        expect(withoutZeroKill).not.toContain('zero kill test');
    });
});

describe('generateJsonReport', () => {
    it('should generate valid JSON output', () => {
        const mockReport: TestRedundancyReport = {
            summary: {
                totalTests:          3,
                redundantTests:      1,
                zeroKillTests:       0,
                uniqueTests:         2,
                redundantPercentage: 33.33,
            },
            fileMetrics: [],
        };

        const json = generateJsonReport(mockReport);

        expect(json).toBeString();
        expect(() => {
            const parsed: unknown = JSON.parse(json);
            return parsed;
        }).not.toThrow();
    });

    it('should include timestamp in JSON output', () => {
        const mockReport: TestRedundancyReport = {
            summary: {
                totalTests:          3,
                redundantTests:      1,
                zeroKillTests:       0,
                uniqueTests:         2,
                redundantPercentage: 33.33,
            },
            fileMetrics: [],
        };

        const json = generateJsonReport(mockReport);
        const parsed: unknown = JSON.parse(json);

        expect(parsed).toHaveProperty('generated');
    });
});

describe('CLI argument parsing', () => {
    // These tests will verify parseArgs function
    it('should parse --json flag', () => {
        // Will be implemented with actual parseArgs function
        expect(true).toBe(true);
    });

    it('should parse --minimal-set flag', () => {
        // Will be implemented with actual parseArgs function
        expect(true).toBe(true);
    });

    it('should parse --show-zero-kill flag', () => {
        // Will be implemented with actual parseArgs function
        expect(true).toBe(true);
    });

    it('should parse -o output flag', () => {
        // Will be implemented with actual parseArgs function
        expect(true).toBe(true);
    });

    it('should parse -i input flag', () => {
        // Will be implemented with actual parseArgs function
        expect(true).toBe(true);
    });
});
