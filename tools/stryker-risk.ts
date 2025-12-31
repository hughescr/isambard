/**
 * Stryker Mutation Testing Risk Analysis Script
 *
 * Analyzes source files for mutation testing risk factors:
 * - Mutant density (mutants per line, mutants per KB)
 * - Large string/template/object/array literals
 *
 * Usage:
 *   bun tools/stryker-risk.ts --log ./stryker.log       # Parse existing log
 *   bun tools/stryker-risk.ts --run-stryker             # Run Stryker with debug logging
 *   bun tools/stryker-risk.ts --cached                  # Use cached data only
 *   bun tools/stryker-risk.ts --json                    # JSON output instead of markdown
 *   bun tools/stryker-risk.ts --output ./report.md      # Write to file
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

// ============================================================================
// Types
// ============================================================================

interface LiteralInfo {
    line:       number
    column:     number
    size:       number
    preview:    string // first 50 chars
    isDynamic?: boolean
}

type ActionType = 'Leave' | 'Monitor' | 'Refactor' | 'Critical';

interface FileMetrics {
    path:           string
    lines:          number
    bytes:          number
    mutants:        number
    mutantsPerLine: number
    mutantsPerKB:   number
    largeStrings:   LiteralInfo[]
    largeTemplates: LiteralInfo[]
    largeObjects:   LiteralInfo[]
    largeArrays:    LiteralInfo[]
    riskScore:      number
    action:         ActionType
}

interface CacheData {
    timestamp:    number
    mutantCounts: Record<string, number>
    fileMetrics:  FileMetrics[]
}

interface CLIArgs {
    logFile?:   string
    runStryker: boolean
    cached:     boolean
    json:       boolean
    output?:    string
    help:       boolean
}

// ============================================================================
// Constants
// ============================================================================

const LARGE_LITERAL_THRESHOLD = 2048; // 2KB
const CACHE_FILE = '.stryker-risk-cache.json';
const PROJECT_ROOT = process.cwd();

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): CLIArgs {
    const args: CLIArgs = {
        runStryker: false,
        cached:     false,
        json:       false,
        help:       false,
    };

    const argv = process.argv.slice(2);
    for(let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch(arg) {
            case '--log':
                args.logFile = argv[++i];
                break;
            case '--run-stryker':
                args.runStryker = true;
                break;
            case '--cached':
                args.cached = true;
                break;
            case '--json':
                args.json = true;
                break;
            case '--output':
                args.output = argv[++i];
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
            default:
                console.error(`Unknown argument: ${arg}`);
                process.exit(1);
        }
    }

    return args;
}

function printHelp(): void {
    console.log(`
Stryker Risk Analysis Tool

Analyzes source files for mutation testing risk factors including
mutant density and large literals that may cause excessive mutants.

USAGE:
    bun tools/stryker-risk.ts [OPTIONS]

OPTIONS:
    --log <path>      Parse an existing Stryker log file
    --run-stryker     Run Stryker with debug logging to collect mutant data
    --cached          Use cached data only (fail if cache is stale)
    --json            Output JSON instead of markdown
    --output <path>   Write report to file instead of stdout
    -h, --help        Show this help message

EXAMPLES:
    # Run Stryker and generate markdown report
    bun tools/stryker-risk.ts --run-stryker

    # Parse existing log and output JSON
    bun tools/stryker-risk.ts --log ./stryker.log --json

    # Use cache and write report to file
    bun tools/stryker-risk.ts --cached --output ./risk-report.md

RISK THRESHOLDS:
    0-30:   Leave (Healthy)
    31-50:  Monitor
    51-70:  Refactor
    71+:    Critical (Extract+Exclude)
`);
}

// ============================================================================
// Stryker Log Parsing
// ============================================================================

const INSTRUMENTED_REGEX = /Instrumented\s+(.+?)\s+\((\d+)\s+mutant/;

function parseMutantCounts(logContent: string): Record<string, number> {
    const counts: Record<string, number> = {};
    const lines = logContent.split('\n');

    for(const line of lines) {
        const match = INSTRUMENTED_REGEX.exec(line);
        if(match) {
            const filePath = match[1];
            const mutantCount = parseInt(match[2], 10);
            // Normalize path relative to project root
            const normalizedPath = filePath.startsWith('/')
                ? path.relative(PROJECT_ROOT, filePath)
                : filePath;
            counts[normalizedPath] = mutantCount;
        }
    }

    return counts;
}

// ============================================================================
// Run Stryker
// ============================================================================

async function runStryker(): Promise<string> {
    return new Promise((resolve, reject) => {
        const cleanPath
            = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
        const child = spawn('bunx', ['stryker', 'run', '--logLevel', 'debug'], {
            env:   { ...process.env, PATH: cleanPath },
            stdio: ['inherit', 'pipe', 'pipe'],
            cwd:   PROJECT_ROOT,
        });

        let output = '';

        child.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            output += text;
            process.stdout.write(text);
        });

        child.stderr?.on('data', (data: Buffer) => {
            const text = data.toString();
            output += text;
            process.stderr.write(text);
        });

        child.on('close', (code) => {
            if(code === 0 || output.includes('Instrumented')) {
                resolve(output);
            } else {
                reject(new Error(`Stryker exited with code ${code}`));
            }
        });

        child.on('error', reject);
    });
}

// ============================================================================
// TypeScript AST Analysis
// ============================================================================

function getSourceFiles(): string[] {
    const configPath = ts.findConfigFile(PROJECT_ROOT, ts.sys.fileExists, 'tsconfig.json');
    if(!configPath) {
        throw new Error('Could not find tsconfig.json');
    }

    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, PROJECT_ROOT);

    // Filter to only src files
    return parsedConfig.fileNames.filter(f => f.includes('/src/'));
}

function estimateObjectSize(node: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): number {
    // Estimate size based on the text representation
    const text = node.getText(sourceFile);
    return text.length;
}

function estimateArraySize(node: ts.ArrayLiteralExpression, sourceFile: ts.SourceFile): number {
    const text = node.getText(sourceFile);
    return text.length;
}

function getTemplateStaticSize(node: ts.TemplateExpression, sourceFile: ts.SourceFile): number {
    let size = node.head.text.length;
    for(const span of node.templateSpans) {
        size += span.literal.text.length;
    }
    return size;
}

function createPreview(text: string, maxLength = 50): string {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if(cleaned.length <= maxLength) {
        return cleaned;
    }
    return cleaned.slice(0, maxLength - 3) + '...';
}

function isInImportStatement(node: ts.Node): boolean {
    let current: ts.Node | undefined = node;
    while(current) {
        if(ts.isImportDeclaration(current) || ts.isImportSpecifier(current)) {
            return true;
        }
        current = current.parent;
    }
    return false;
}

function analyzeFile(filePath: string): {
    lines:          number
    bytes:          number
    largeStrings:   LiteralInfo[]
    largeTemplates: LiteralInfo[]
    largeObjects:   LiteralInfo[]
    largeArrays:    LiteralInfo[]
} {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_ROOT, filePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const lines = content.split('\n').length;
    const bytes = Buffer.byteLength(content, 'utf-8');

    const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );

    const largeStrings: LiteralInfo[] = [];
    const largeTemplates: LiteralInfo[] = [];
    const largeObjects: LiteralInfo[] = [];
    const largeArrays: LiteralInfo[] = [];

    function visit(node: ts.Node): void {
        // String literals
        if(ts.isStringLiteral(node) && !isInImportStatement(node)) {
            const size = node.text.length;
            if(size >= LARGE_LITERAL_THRESHOLD) {
                const { line, character } = sourceFile.getLineAndCharacterOfPosition(
                    node.getStart(sourceFile)
                );
                largeStrings.push({
                    line:    line + 1,
                    column:  character + 1,
                    size,
                    preview: createPreview(node.text),
                });
            }
        }

        // No-substitution template literals (simple backtick strings)
        if(ts.isNoSubstitutionTemplateLiteral(node)) {
            const size = node.text.length;
            if(size >= LARGE_LITERAL_THRESHOLD) {
                const { line, character } = sourceFile.getLineAndCharacterOfPosition(
                    node.getStart(sourceFile)
                );
                largeTemplates.push({
                    line:      line + 1,
                    column:    character + 1,
                    size,
                    preview:   createPreview(node.text),
                    isDynamic: false,
                });
            }
        }

        // Template expressions with substitutions
        if(ts.isTemplateExpression(node)) {
            const staticSize = getTemplateStaticSize(node, sourceFile);
            if(staticSize >= LARGE_LITERAL_THRESHOLD) {
                const { line, character } = sourceFile.getLineAndCharacterOfPosition(
                    node.getStart(sourceFile)
                );
                const fullText = node.getText(sourceFile);
                largeTemplates.push({
                    line:      line + 1,
                    column:    character + 1,
                    size:      staticSize,
                    preview:   createPreview(fullText),
                    isDynamic: true,
                });
            }
        }

        // Object literals
        if(ts.isObjectLiteralExpression(node)) {
            const size = estimateObjectSize(node, sourceFile);
            if(size >= LARGE_LITERAL_THRESHOLD) {
                const { line, character } = sourceFile.getLineAndCharacterOfPosition(
                    node.getStart(sourceFile)
                );
                const text = node.getText(sourceFile);
                largeObjects.push({
                    line:    line + 1,
                    column:  character + 1,
                    size,
                    preview: createPreview(text),
                });
            }
        }

        // Array literals
        if(ts.isArrayLiteralExpression(node)) {
            const size = estimateArraySize(node, sourceFile);
            if(size >= LARGE_LITERAL_THRESHOLD) {
                const { line, character } = sourceFile.getLineAndCharacterOfPosition(
                    node.getStart(sourceFile)
                );
                const text = node.getText(sourceFile);
                largeArrays.push({
                    line:    line + 1,
                    column:  character + 1,
                    size,
                    preview: createPreview(text),
                });
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    return { lines, bytes, largeStrings, largeTemplates, largeObjects, largeArrays };
}

// ============================================================================
// Risk Score Calculation
// ============================================================================

function calculateRiskScore(metrics: Omit<FileMetrics, 'riskScore' | 'action'>): number {
    const { mutantsPerLine, mutantsPerKB, largeStrings, largeTemplates, largeObjects, largeArrays }
        = metrics;

    // Normalize mutants/line (0-100, cap at 5 mutants/line)
    // Note: mutantsPerLine is already per 100 lines, so divide by 100
    const actualMutantsPerLine = mutantsPerLine / 100;
    const normalizedMPL = Math.min(actualMutantsPerLine, 5) * 20;

    // Normalize mutants/KB (0-100, cap at 50 mutants/KB)
    const normalizedMPK = Math.min(mutantsPerKB, 50) * 2;

    const score
        = normalizedMPL * 1.0
          + normalizedMPK * 0.5
          + largeStrings.length * 10
          + largeTemplates.length * 15
          + largeObjects.length * 8
          + largeArrays.length * 5;

    return Math.round(score * 100) / 100;
}

function getAction(score: number): ActionType {
    if(score <= 30) { return 'Leave'; }
    if(score <= 50) { return 'Monitor'; }
    if(score <= 70) { return 'Refactor'; }
    return 'Critical';
}

// ============================================================================
// Caching
// ============================================================================

function loadCache(): CacheData | null {
    const cachePath = path.join(PROJECT_ROOT, CACHE_FILE);
    if(!fs.existsSync(cachePath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(cachePath, 'utf-8');
        return JSON.parse(content) as CacheData;
    } catch{
        return null;
    }
}

function saveCache(data: CacheData): void {
    const cachePath = path.join(PROJECT_ROOT, CACHE_FILE);
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
}

function isCacheValid(cache: CacheData, sourceFiles: string[]): boolean {
    // Check if any source file is newer than the cache
    for(const file of sourceFiles) {
        const absolutePath = path.isAbsolute(file) ? file : path.join(PROJECT_ROOT, file);
        try {
            const stat = fs.statSync(absolutePath);
            if(stat.mtimeMs > cache.timestamp) {
                return false;
            }
        } catch{
            // File doesn't exist, cache is invalid
            return false;
        }
    }
    return true;
}

// ============================================================================
// Report Generation
// ============================================================================

function generateMarkdownReport(metrics: FileMetrics[]): string {
    const sorted = [...metrics].sort((a, b) => b.riskScore - a.riskScore);
    const timestamp = new Date().toISOString();

    let report = `# Stryker Risk Analysis

Generated: ${timestamp}

## Summary

| Metric | Value |
|--------|-------|
| Total Files | ${metrics.length} |
| Critical Files | ${metrics.filter(m => m.action === 'Critical').length} |
| Refactor Files | ${metrics.filter(m => m.action === 'Refactor').length} |
| Monitor Files | ${metrics.filter(m => m.action === 'Monitor').length} |
| Healthy Files | ${metrics.filter(m => m.action === 'Leave').length} |

## Risk Analysis

| File | Lines | Mutants | M/100L | M/KB | Large Literals | Risk | Action |
|------|-------|---------|--------|------|----------------|------|--------|
`;

    for(const m of sorted) {
        const largeLiterals
            = m.largeStrings.length
              + m.largeTemplates.length
              + m.largeObjects.length
              + m.largeArrays.length;
        const relativePath = m.path.replace(/^src\//, '');
        report += `| ${relativePath} | ${m.lines} | ${m.mutants} | ${m.mutantsPerLine.toFixed(1)} | ${m.mutantsPerKB.toFixed(1)} | ${largeLiterals} | ${m.riskScore.toFixed(1)} | ${m.action} |\n`;
    }

    // Large Literals Detail section
    const filesWithLargeLiterals = sorted.filter(
        m =>
            m.largeStrings.length > 0
            || m.largeTemplates.length > 0
            || m.largeObjects.length > 0
            || m.largeArrays.length > 0
    );

    if(filesWithLargeLiterals.length > 0) {
        report += `
## Large Literals Detail

`;
        for(const m of filesWithLargeLiterals) {
            report += `### ${m.path}\n\n`;

            if(m.largeStrings.length > 0) {
                report += `**Strings (${m.largeStrings.length}):**\n`;
                for(const lit of m.largeStrings) {
                    report += `- Line ${lit.line}: ${lit.size} bytes - \`${lit.preview}\`\n`;
                }
                report += '\n';
            }

            if(m.largeTemplates.length > 0) {
                report += `**Templates (${m.largeTemplates.length}):**\n`;
                for(const lit of m.largeTemplates) {
                    const dynamic = lit.isDynamic ? ' (dynamic)' : '';
                    report += `- Line ${lit.line}: ${lit.size} bytes${dynamic} - \`${lit.preview}\`\n`;
                }
                report += '\n';
            }

            if(m.largeObjects.length > 0) {
                report += `**Objects (${m.largeObjects.length}):**\n`;
                for(const lit of m.largeObjects) {
                    report += `- Line ${lit.line}: ${lit.size} bytes - \`${lit.preview}\`\n`;
                }
                report += '\n';
            }

            if(m.largeArrays.length > 0) {
                report += `**Arrays (${m.largeArrays.length}):**\n`;
                for(const lit of m.largeArrays) {
                    report += `- Line ${lit.line}: ${lit.size} bytes - \`${lit.preview}\`\n`;
                }
                report += '\n';
            }
        }
    }

    report += `
## Thresholds

| Score Range | Action | Description |
|-------------|--------|-------------|
| 0-30 | Leave | Healthy - no action needed |
| 31-50 | Monitor | Watch for changes |
| 51-70 | Refactor | Consider refactoring |
| 71+ | Critical | Extract large literals and/or exclude from mutation testing |
`;

    return report;
}

function generateJsonReport(metrics: FileMetrics[]): string {
    const sorted = [...metrics].sort((a, b) => b.riskScore - a.riskScore);
    return JSON.stringify(
        {
            generated: new Date().toISOString(),
            summary:   {
                totalFiles: metrics.length,
                critical:   metrics.filter(m => m.action === 'Critical').length,
                refactor:   metrics.filter(m => m.action === 'Refactor').length,
                monitor:    metrics.filter(m => m.action === 'Monitor').length,
                healthy:    metrics.filter(m => m.action === 'Leave').length,
            },
            files: sorted,
        },
        null,
        2
    );
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    const args = parseArgs();

    if(args.help) {
        printHelp();
        process.exit(0);
    }

    // Get source files
    const sourceFiles = getSourceFiles();
    console.error(`Found ${sourceFiles.length} source files`);

    // Get mutant counts
    let mutantCounts: Record<string, number> = {};
    const cache = loadCache();

    if(args.cached) {
        if(!cache) {
            console.error('Error: No cache file found');
            process.exit(1);
        }
        if(!isCacheValid(cache, sourceFiles)) {
            console.error('Error: Cache is stale (source files modified)');
            process.exit(1);
        }
        mutantCounts = cache.mutantCounts;
        console.error('Using cached mutant data');
    } else if(args.logFile) {
        if(!fs.existsSync(args.logFile)) {
            console.error(`Error: Log file not found: ${args.logFile}`);
            process.exit(1);
        }
        const logContent = fs.readFileSync(args.logFile, 'utf-8');
        mutantCounts = parseMutantCounts(logContent);
        console.error(`Parsed ${Object.keys(mutantCounts).length} files from log`);
    } else if(args.runStryker) {
        console.error('Running Stryker with debug logging...');
        try {
            const output = await runStryker();
            mutantCounts = parseMutantCounts(output);
            console.error(`\nCollected mutant counts for ${Object.keys(mutantCounts).length} files`);
        } catch (error) {
            console.error('Error running Stryker:', error);
            process.exit(1);
        }
    } else if(cache && isCacheValid(cache, sourceFiles)) {
        mutantCounts = cache.mutantCounts;
        console.error('Using cached mutant data (cache is valid)');
    } else {
        console.error('No mutant data available. Use --run-stryker or --log <file>');
        process.exit(1);
    }

    // Analyze all files
    const fileMetrics: FileMetrics[] = [];

    for(const file of sourceFiles) {
        const relativePath = path.relative(PROJECT_ROOT, file);
        const analysis = analyzeFile(file);
        const mutants = mutantCounts[relativePath] ?? 0;

        const mutantsPerLine = analysis.lines > 0 ? (mutants / analysis.lines) * 100 : 0;
        const mutantsPerKB = analysis.bytes > 0 ? (mutants / analysis.bytes) * 1024 : 0;

        const partialMetrics = {
            path:           relativePath,
            lines:          analysis.lines,
            bytes:          analysis.bytes,
            mutants,
            mutantsPerLine,
            mutantsPerKB,
            largeStrings:   analysis.largeStrings,
            largeTemplates: analysis.largeTemplates,
            largeObjects:   analysis.largeObjects,
            largeArrays:    analysis.largeArrays,
        };

        const riskScore = calculateRiskScore(partialMetrics);
        const action = getAction(riskScore);

        fileMetrics.push({
            ...partialMetrics,
            riskScore,
            action,
        });
    }

    // Save cache
    saveCache({
        timestamp: Date.now(),
        mutantCounts,
        fileMetrics,
    });

    // Generate report
    const report = args.json ? generateJsonReport(fileMetrics) : generateMarkdownReport(fileMetrics);

    // Output
    if(args.output) {
        fs.writeFileSync(args.output, report);
        console.error(`Report written to ${args.output}`);
    } else {
        console.log(report);
    }
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
