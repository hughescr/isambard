import type { Rule } from 'eslint';

declare const rule: Rule.RuleModule;
export default rule;

export declare function isSetupImport(source: string, setupModules: string[]): boolean;
export declare function collectAfterEachResets(body: unknown[]): Set<string>;
export declare function collectCallsInNode(node: unknown, names: Set<string>): void;
