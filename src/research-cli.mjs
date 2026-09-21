import { open, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hashResearchDataset, runWalkForwardEvaluation } from './domain/research-evaluation.mjs';

const MAX_DATASET_BYTES = 256 * 1024 * 1024;

function usage() {
  return [
    'Usage:',
    '  npm run research-hash -- <dataset.json>',
    '  npm run evaluate -- <dataset.json> [--fold-count N] [--training-fraction F] [--minimum-training-bars N]',
    '',
    'Evaluation accepts BROKER_HISTORICAL datasets only. It never connects to a broker or enables live trading.',
  ].join('\n');
}

async function readDataset(path) {
  const absolute = resolve(process.cwd(), path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.size > MAX_DATASET_BYTES) throw new Error('RESEARCH_DATASET_FILE_INVALID_OR_TOO_LARGE');
  return JSON.parse(await readFile(absolute, 'utf8'));
}

function parseEvaluationArgs(args) {
  let datasetPath = null;
  const options = {};
  const supported = new Map([
    ['--fold-count', 'foldCount'],
    ['--training-fraction', 'trainingFraction'],
    ['--minimum-training-bars', 'minimumTrainingBars'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      if (datasetPath) throw new Error('RESEARCH_CLI_ARGUMENTS_INVALID');
      datasetPath = argument;
      continue;
    }
    const [flag, inlineValue] = argument.split('=', 2);
    const optionName = supported.get(flag);
    const value = inlineValue ?? args[++index];
    if (!optionName || value == null || value.startsWith('--') || !Number.isFinite(Number(value))) {
      throw new Error('RESEARCH_CLI_ARGUMENTS_INVALID');
    }
    options[optionName] = Number(value);
  }
  if (!datasetPath) throw new Error('RESEARCH_CLI_ARGUMENTS_INVALID');
  return { datasetPath, options };
}

async function ensurePlainDirectory(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('RESEARCH_OUTPUT_DIRECTORY_UNSAFE');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path);
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('RESEARCH_OUTPUT_DIRECTORY_UNSAFE');
  }
}

async function saveReport(report) {
  const dataDirectory = resolve(process.cwd(), 'data');
  await ensurePlainDirectory(dataDirectory);
  const outputDirectory = resolve(dataDirectory, 'research-results');
  await ensurePlainDirectory(outputDirectory);
  const outputPath = resolve(outputDirectory, `${report.runId}.json`);
  if (dirname(outputPath) !== outputDirectory) throw new Error('RESEARCH_OUTPUT_PATH_INVALID');
  const handle = await open(outputPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return outputPath;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'hash') {
    if (args.length !== 1) throw new Error('RESEARCH_CLI_ARGUMENTS_INVALID');
    const dataset = await readDataset(args[0]);
    process.stdout.write(`${hashResearchDataset(dataset)}\n`);
    return;
  }
  if (mode !== 'evaluate') throw new Error('RESEARCH_CLI_ARGUMENTS_INVALID');
  const { datasetPath, options } = parseEvaluationArgs(args);
  const dataset = await readDataset(datasetPath);
  const report = await runWalkForwardEvaluation(dataset, options);
  const outputPath = await saveReport(report);
  process.stdout.write([
    'Offline historical replay completed.',
    `Evidence class: ${report.evidenceClass}`,
    `Dataset SHA-256: ${report.provenance.datasetSha256}`,
    `Walk-forward folds: ${report.folds.length}`,
    `Live trading enabled: ${report.liveTradingEnabled}`,
    `Report: ${outputPath}`,
  ].join('\n') + '\n');
}

main().catch((error) => {
  const reason = error?.code === 'EEXIST' ? 'RESEARCH_REPORT_ALREADY_EXISTS'
    : typeof error?.message === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message
      : 'RESEARCH_CLI_FAILED';
  process.stderr.write(`${reason}\n${usage()}\n`);
  process.exitCode = 1;
});
