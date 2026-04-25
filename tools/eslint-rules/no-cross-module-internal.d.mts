import type { Rule } from 'eslint';

declare const rule: Rule.RuleModule;
export default rule;

export declare function getModuleForFile(
    filePath: string,
    cwd: string,
    matchers: { type: string, matcher: (s: string) => boolean }[]
): string | null;

export declare function buildMatchers(
    modules: { type: string, pattern: string | string[] }[]
): { type: string, matcher: (s: string) => boolean }[];
