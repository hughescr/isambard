/**
 * Test Redundancy Analyzer
 *
 * Analyzes Stryker's mutation.json to identify redundant tests based on unique kill counts.
 *
 * A test is considered:
 * - Redundant: uniqueKills = 0 AND totalKills > 0
 * - Zero-Kill: totalKills = 0
 * - Unique: uniqueKills > 0
 *
 * Usage:
 *   bun tools/test-redundancy.ts                    # Default analysis
 *   bun tools/test-redundancy.ts --json             # JSON output
 *   bun tools/test-redundancy.ts --show-zero-kill   # Include zero-kill tests
 *   bun tools/test-redundancy.ts -o report.md       # Write to file
 *   bun tools/test-redundancy.ts -i path.json       # Custom input
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import _ from 'lodash';

// ============================================================================
// Types
// ============================================================================

class CliError extends Error {
    constructor(message: string, public readonly exitCode = 1) {
        super(message);
        this.name = 'CliError';
    }
}

interface MutationReport {
    schemaVersion: string
    thresholds: {
        high:    number
        low:     number
        'break': number
    }
    files: Record<string, {
        language: string
        mutants:  Mutant[]
        source:   string
    }>
    testFiles: Record<string, {
        tests: TestInfo[]
    }>
}

interface Mutant {
    id:          string
    mutatorName: string
    replacement: string
    status:      string
    killedBy?:   string[]
    location: {
        start: { line: number, column: number }
        end:   { line: number, column: number }
    }
}

interface TestInfo {
    id:       string
    name:     string
    location: {
        start: { line: number, column: number }
        end:   { line: number, column: number }
    }
}

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

interface CLIArgs {
    input:        string
    json:         boolean
    showZeroKill: boolean
    output?:      string
    help:         boolean
}

// ============================================================================
// Constants
// ============================================================================

const PROJECT_ROOT = process.cwd();
const DEFAULT_MUTATION_FILE = path.join(PROJECT_ROOT, 'reports', 'mutation', 'mutation.json');

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): CLIArgs {
    const args: CLIArgs = {
        input:        DEFAULT_MUTATION_FILE,
        json:         false,
        showZeroKill: false,
        help:         false,
    };

    const argv = process.argv.slice(2);
    for(let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch(arg) {
            case '-i':
            case '--input':
                args.input = argv[++i];
                break;
            case '--json':
                args.json = true;
                break;
            case '--show-zero-kill':
                args.showZeroKill = true;
                break;
            case '-o':
            case '--output':
                args.output = argv[++i];
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
            default:
                throw new CliError(`Unknown argument: ${arg}`, 1);
        }
    }

    return args;
}

function printHelp(): void {
    // eslint-disable-next-line no-console -- CLI tool needs console output
    console.log(`
Test Redundancy Analyzer

Analyzes Stryker's mutation.json to identify redundant tests based on unique kill counts.

DEFINITIONS:
    Redundant:  uniqueKills = 0 AND totalKills > 0
    Zero-Kill:  totalKills = 0
    Unique:     uniqueKills > 0

USAGE:
    bun tools/test-redundancy.ts [OPTIONS]

OPTIONS:
    -i, --input <path>    Path to mutation.json (default: reports/mutation/mutation.json)
    --json                Output JSON instead of markdown
    --show-zero-kill      Include zero-kill tests in report
    -o, --output <path>   Write report to file instead of stdout
    -h, --help            Show this help message

EXAMPLES:
    # Default analysis
    bun tools/test-redundancy.ts

    # JSON output
    bun tools/test-redundancy.ts --json

    # Include zero-kill tests
    bun tools/test-redundancy.ts --show-zero-kill

    # Custom input and output
    bun tools/test-redundancy.ts -i custom.json -o report.md
`);
}

// ============================================================================
// Core Functions
// ============================================================================

export function parseMutationReport(filePath: string): MutationReport {
    // eslint-disable-next-line n/no-sync -- CLI tool uses sync for simplicity
    if(!fs.existsSync(filePath)) {
        throw new CliError(`File not found: ${filePath}`, 1);
    }

    try {
        // eslint-disable-next-line n/no-sync -- CLI tool uses sync for simplicity
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as MutationReport;
    } catch (error) {
        const errorMessage = _.isError(error) ? error.message : String(error);
        throw new CliError(`Failed to parse mutation report: ${errorMessage}`, 1);
    }
}

export function extractKilledMutants(report: MutationReport): Mutant[] {
    const killedMutants: Mutant[] = [];

    for(const fileData of _.values(report.files)) {
        for(const mutant of fileData.mutants) {
            if(mutant.status === 'Killed') {
                killedMutants.push(mutant);
            }
        }
    }

    return killedMutants;
}

export function buildTestToMutantsIndex(mutants: Mutant[]): Map<string, Set<string>> {
    const testToMutants = new Map<string, Set<string>>();

    for(const mutant of mutants) {
        for(const testId of mutant.killedBy ?? []) {
            if(!testToMutants.has(testId)) {
                testToMutants.set(testId, new Set());
            }
            testToMutants.get(testId)!.add(mutant.id);
        }
    }

    return testToMutants;
}

export function calculateTestMetrics(
    testToMutants: Map<string, Set<string>>,
    mutantToTests: Map<string, Set<string>>,
    testFiles: Record<string, { tests: TestInfo[] }>
): TestMetrics[] {
    const metrics: TestMetrics[] = [];

    for(const [testFile, { tests }] of _.toPairs(testFiles)) {
        for(const test of tests) {
            const killedMutants = testToMutants.get(test.id) ?? new Set();
            const totalKills = killedMutants.size;

            // Count unique kills (mutants killed only by this test)
            let uniqueKills = 0;
            const overlappingTestIds = new Set<string>();

            for(const mutantId of killedMutants) {
                const testsKillingThisMutant = mutantToTests.get(mutantId);
                if(testsKillingThisMutant) {
                    if(testsKillingThisMutant.size === 1) {
                        uniqueKills++;
                    } else {
                        // Add overlapping tests (excluding self)
                        for(const testId of testsKillingThisMutant) {
                            if(testId !== test.id) {
                                overlappingTestIds.add(testId);
                            }
                        }
                    }
                }
            }

            const sharedKills = totalKills - uniqueKills;
            const uniqueRatio = totalKills > 0 ? uniqueKills / totalKills : 0;
            const redundant = uniqueKills === 0 && totalKills > 0;
            const zeroKill = totalKills === 0;

            metrics.push({
                id:               test.id,
                name:             test.name,
                file:             testFile,
                uniqueKills,
                sharedKills,
                totalKills,
                uniqueRatio,
                redundant,
                zeroKill,
                overlappingTests: Array.from(overlappingTestIds),
            });
        }
    }

    return metrics;
}

function aggregateByFile(metrics: TestMetrics[]): FileMetrics[] {
    const byFile = _.groupBy(metrics, 'file');

    return _.map(byFile, (tests, file) => ({
        file,
        tests:          _.orderBy(tests, ['redundant', 'uniqueRatio'], ['desc', 'asc']),
        totalTests:     tests.length,
        redundantTests: _.filter(tests, { redundant: true }).length,
        zeroKillTests:  _.filter(tests, { zeroKill: true }).length,
        uniqueTests:    _.filter(tests, t => t.uniqueKills > 0).length,
    }));
}

function buildReport(metrics: TestMetrics[]): TestRedundancyReport {
    const fileMetrics = aggregateByFile(metrics);

    const totalTests = metrics.length;
    const redundantTests = _.filter(metrics, { redundant: true }).length;
    const zeroKillTests = _.filter(metrics, { zeroKill: true }).length;
    const uniqueTests = _.filter(metrics, t => t.uniqueKills > 0).length;
    const redundantPercentage = totalTests > 0 ? (redundantTests / totalTests) * 100 : 0;

    return {
        summary: {
            totalTests,
            redundantTests,
            zeroKillTests,
            uniqueTests,
            redundantPercentage,
        },
        fileMetrics: _.orderBy(fileMetrics, 'redundantTests', 'desc'),
    };
}

// ============================================================================
// Report Generation
// ============================================================================

export function generateMarkdownReport(
    report: TestRedundancyReport,
    options: { showZeroKill?: boolean }
): string {
    const timestamp = new Date().toISOString();

    let md = `# Test Redundancy Analysis

Generated: ${timestamp}

## Summary

| Metric | Value |
|--------|-------|
| Total Tests | ${report.summary.totalTests} |
| Redundant Tests | ${report.summary.redundantTests} (${report.summary.redundantPercentage.toFixed(1)}%) |
| Zero-Kill Tests | ${report.summary.zeroKillTests} |
| Unique Tests | ${report.summary.uniqueTests} |

## Redundancy by File

| File | Total | Redundant | Zero-Kill | Unique |
|------|-------|-----------|-----------|--------|
`;

    for(const fm of report.fileMetrics) {
        const relPath = _.replace(fm.file, /^tests\//, '');
        md += `| ${relPath} | ${fm.totalTests} | ${fm.redundantTests} | ${fm.zeroKillTests} | ${fm.uniqueTests} |\n`;
    }

    md += '\n## Detailed Test Analysis\n\n';

    for(const fm of report.fileMetrics) {
        if(fm.redundantTests === 0 && !options.showZeroKill) {
            continue;
        }

        md += `### ${fm.file}\n\n`;

        const testsToShow = options.showZeroKill
            ? fm.tests
            : _.filter(fm.tests, t => !t.zeroKill);

        if(testsToShow.length === 0) {
            md += '_No tests to report._\n\n';
            continue;
        }

        md += '| Test | Total Kills | Unique Kills | Shared Kills | Unique Ratio | Status |\n';
        md += '|------|-------------|--------------|--------------|--------------|--------|\n';

        for(const test of testsToShow) {
            let status = 'Unique';
            if(test.zeroKill) {
                status = '⚠️ Zero-Kill';
            } else if(test.redundant) {
                status = '❌ Redundant';
            }

            const ratio = (test.uniqueRatio * 100).toFixed(1);
            md += `| ${test.name} | ${test.totalKills} | ${test.uniqueKills} | ${test.sharedKills} | ${ratio}% | ${status} |\n`;
        }

        md += '\n';
    }

    md += `## Definitions

| Category | Definition |
|----------|------------|
| **Redundant** | \`uniqueKills = 0\` AND \`totalKills > 0\` |
| **Zero-Kill** | \`totalKills = 0\` |
| **Unique** | \`uniqueKills > 0\` |

A redundant test doesn't uniquely catch any mutants - all mutants it kills are also killed by other tests.
`;

    return md;
}

export function generateJsonReport(report: TestRedundancyReport): string {
    return JSON.stringify(
        {
            generated: new Date().toISOString(),
            ...report,
        },
        null,
        2
    );
}

function outputReport(report: string, outputPath?: string): void {
    if(outputPath) {
        // eslint-disable-next-line n/no-sync -- CLI tool uses sync for simplicity
        fs.writeFileSync(outputPath, report);
        // eslint-disable-next-line no-console -- CLI tool needs console output
        console.error(`Report written to ${outputPath}`);
    } else {
        // eslint-disable-next-line no-console -- CLI tool needs console output
        console.log(report);
    }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    const args = parseArgs();

    if(args.help) {
        printHelp();
        throw new CliError('Help displayed', 0);
    }

    // Parse mutation report
    const mutationReport = parseMutationReport(args.input);

    // Extract killed mutants
    const killedMutants = extractKilledMutants(mutationReport);

    // Build test -> mutants index
    const testToMutants = buildTestToMutantsIndex(killedMutants);

    // Build mutant -> tests index
    const mutantToTests = new Map<string, Set<string>>();
    for(const mutant of killedMutants) {
        mutantToTests.set(mutant.id, new Set(mutant.killedBy ?? []));
    }

    // Calculate test metrics
    const metrics = calculateTestMetrics(testToMutants, mutantToTests, mutationReport.testFiles);

    // Build report
    const report = buildReport(metrics);

    // Generate and output report
    const output = args.json
        ? generateJsonReport(report)
        : generateMarkdownReport(report, { showZeroKill: args.showZeroKill });
    outputReport(output, args.output);
}

// Only run main() when executed directly, not when imported by tests
if(import.meta.main) {
    main().catch((error) => {
        if(error instanceof CliError) {
            if(error.exitCode !== 0) {
                // eslint-disable-next-line no-console -- CLI tool needs console output
                console.error('Error:', error.message);
            }
            process.exitCode = error.exitCode;
        } else {
            // eslint-disable-next-line no-console -- CLI tool needs console output
            console.error('Fatal error:', error);
            process.exitCode = 1;
        }
    });
}
