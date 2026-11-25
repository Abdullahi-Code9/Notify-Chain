const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mutants = require('./mutants.cjs');

const root = path.resolve(__dirname, '../..');
const reportDir = path.join(root, 'reports/mutation');
// Keep the sandbox below listener so node_modules resolves without copying it.
const sandbox = fs.mkdtempSync(path.join(root, '.mutation-'));
const results = [];
let baseline;

function runSuite(label) {
  const outputFile = path.join(reportDir, `${label}.jest.json`);
  fs.rmSync(outputFile, { force: true });
  const result = spawnSync(process.execPath, [
    path.join(root, 'node_modules/jest/bin/jest.js'),
    '--config', path.join(sandbox, 'jest.config.cjs'),
    '--runInBand', '--no-cache', '--json', '--outputFile', outputFile,
  ], {
    cwd: sandbox,
    env: { ...process.env, CI: 'true', TZ: 'UTC', FORCE_COLOR: '0' },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(reportDir, `${label}.log`),
    `${result.stdout || ''}\n${result.stderr || ''}\n${result.error?.message || ''}`);
  if (result.error || result.signal || !fs.existsSync(outputFile)) return 'error';
  const report = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  // A syntax/import failure must never be credited as a detected defect.
  if (report.numRuntimeErrorTestSuites > 0 || report.numTotalTests === 0) return 'error';
  if (result.status === 0 && report.success) return 'survived';
  if (report.numFailedTests > 0) return 'killed';
  return 'error';
}

try {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.cpSync(path.join(root, 'src'), path.join(sandbox, 'src'), { recursive: true });
  const config = {
    rootDir: sandbox,
    testEnvironment: 'node',
    testMatch: ['<rootDir>/src/services/event-normalization.test.ts',
      '<rootDir>/src/utils/event-utils.test.ts', '<rootDir>/src/mutation/critical-events.test.ts'],
    transform: { '^.+\\.tsx?$': [require.resolve('@swc/jest', { paths: [root] }), {
      jsc: { parser: { syntax: 'typescript' }, target: 'es2020' },
      module: { type: 'commonjs' },
    }] },
    moduleNameMapper: {
      '^@stellar/stellar-sdk$': '<rootDir>/src/__mocks__/@stellar/stellar-sdk.ts',
      '^uuid$': '<rootDir>/src/__mocks__/uuid.js',
      '^node-cache$': '<rootDir>/src/__mocks__/node-cache.ts',
    },
  };
  fs.writeFileSync(path.join(sandbox, 'jest.config.cjs'), `module.exports = ${JSON.stringify(config)};`);
  // Fail closed when source moves: do not silently run zero or stale mutations.
  for (const mutant of mutants) {
    const source = fs.readFileSync(path.join(root, mutant.file), 'utf8');
    if (source.split(mutant.before).length !== 2) {
      throw new Error(`Mutation anchor must occur once: ${mutant.id} (${mutant.file})`);
    }
  }
  baseline = runSuite('baseline');
  if (baseline !== 'survived') throw new Error('Baseline suite failed; inspect baseline.log before interpreting mutations.');
  for (const mutant of mutants) {
    const target = path.join(sandbox, mutant.file);
    const original = fs.readFileSync(target, 'utf8');
    try {
      fs.writeFileSync(target, original.replace(mutant.before, mutant.after));
      const status = runSuite(mutant.id);
      results.push({ ...mutant, status });
      console.log(`${status}: ${mutant.id}`);
    } finally {
      fs.writeFileSync(target, original);
    }
  }
  if (results.some(({ status }) => status !== 'killed')) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  results.push({ id: 'harness', status: 'error', message: error.message });
  process.exitCode = 1;
} finally {
  fs.mkdirSync(reportDir, { recursive: true });
  const killed = results.filter(({ status }) => status === 'killed').length;
  const surviving = results.filter(({ status }) => status === 'survived').length;
  const score = killed + surviving ? 100 * killed / (killed + surviving) : null;
  const report = { node: process.version, baseline, mutationScore: score, results };
  fs.writeFileSync(path.join(reportDir, 'results.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(reportDir, 'summary.md'), [
    '# Critical event mutation results', '',
    `Node: ${process.version}. Score: ${score === null ? 'unavailable' : score.toFixed(1) + '%'}.`, '',
    '| Mutation | Status |', '| --- | --- |',
    ...results.map(({ id, status }) => `| ${id} | ${status} |`), '',
    'Survivors require a stronger behavioral assertion or a documented equivalent-mutation explanation.',
    'Errors are infrastructure failures and are excluded from the score.', '',
  ].join('\n'));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
