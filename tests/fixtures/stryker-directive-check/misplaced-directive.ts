// Fixture for tests/unit/tools/stryker-directive-check.test.ts's checkFiles aggregation-order
// tests: a deliberately misplaced Stryker directive (attached to an operator continuation line,
// not to any statement), so checkFiles(['this file', ...]) has a real, stable, non-empty
// checkSource() result to combine with other files' results. Excluded from scanRepoFiles()
// (which only globs src/ and tools/) and from stryker.conf.mjs's mutate glob, so it never
// participates in the tool's own lint gate or in real mutation testing.
const _a = 1
  // Stryker disable next-line ArithmeticOperator: reason
  + 2;
