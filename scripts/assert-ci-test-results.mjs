import { readFile } from 'node:fs/promises';

const [reportPath] = process.argv.slice(2);
if (!reportPath) throw new Error('Pass the Vitest JSON report path.');

const report = JSON.parse(await readFile(reportPath, 'utf8'));
const problems = [];
if (!report.success) problems.push('Vitest reported failure.');
if (!Number.isInteger(report.numTotalTests) || report.numTotalTests < 1) problems.push('No tests ran.');
if (report.numPassedTests !== report.numTotalTests) problems.push('Every discovered test must pass.');
if (report.numFailedTests !== 0 || report.numFailedTestSuites !== 0) problems.push('Failed tests or suites were reported.');
if (report.numPendingTests !== 0 || report.numTodoTests !== 0) problems.push('Skipped, pending, or todo tests were reported.');

const results = new Map(report.testResults.map(result => [result.name.replaceAll('\\', '/'), result]));
for (const suite of ['tests/postgres-repository.test.ts', 'tests/workbench-postgres.test.ts', 'tests/workbench-provider-postgres.test.ts']) {
  const result = [...results].find(([name]) => name.endsWith(`/${suite}`))?.[1];
  if (!result || result.status !== 'passed' || result.assertionResults.length === 0 || result.assertionResults.some(assertion => assertion.status !== 'passed')) {
    problems.push(`${suite} must execute at least one test and every assertion must pass.`);
  }
}

if (problems.length) {
  console.error(`CI test gate failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Vitest passed ${report.numPassedTests} tests; all three PostgreSQL suites ran without skips.`);
