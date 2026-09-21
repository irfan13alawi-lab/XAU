import { open, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWalkForwardEvaluation, verifyResearchReport } from '../domain/research-evaluation.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DATA_DIRECTORY = resolve(ROOT, 'data');
const DATASET_DIRECTORY = resolve(DATA_DIRECTORY, 'research-datasets');
const REPORT_DIRECTORY = resolve(DATA_DIRECTORY, 'research-results');
const MAX_DATASET_BYTES = 256 * 1024 * 1024;

function serviceError(code, statusCode) {
  return Object.assign(new Error(code), { statusCode });
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw serviceError(code, 400);
  return value;
}

export function validateResearchRequest(body) {
  const request = assertPlainObject(body, 'RESEARCH_REQUEST_INVALID');
  const allowed = new Set(['datasetName', 'options']);
  if (Object.keys(request).some((key) => !allowed.has(key))) throw serviceError('RESEARCH_REQUEST_FIELDS_INVALID', 400);
  if (typeof request.datasetName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/.test(request.datasetName)) {
    throw serviceError('RESEARCH_DATASET_NAME_INVALID', 400);
  }
  const rawOptions = request.options == null ? {} : assertPlainObject(request.options, 'RESEARCH_OPTIONS_INVALID');
  const optionNames = new Set(['foldCount', 'trainingFraction', 'minimumTrainingBars']);
  if (Object.keys(rawOptions).some((key) => !optionNames.has(key))) throw serviceError('RESEARCH_OPTIONS_INVALID', 400);
  const options = {
    foldCount: rawOptions.foldCount ?? 3,
    trainingFraction: rawOptions.trainingFraction ?? 0.7,
    minimumTrainingBars: rawOptions.minimumTrainingBars ?? 100,
  };
  if (!Number.isInteger(options.foldCount) || options.foldCount < 1 || options.foldCount > 10
    || typeof options.trainingFraction !== 'number' || !Number.isFinite(options.trainingFraction)
    || options.trainingFraction <= 0 || options.trainingFraction >= 1
    || !Number.isInteger(options.minimumTrainingBars) || options.minimumTrainingBars < 100 || options.minimumTrainingBars > 100_000) {
    throw serviceError('RESEARCH_OPTIONS_INVALID', 400);
  }
  return { datasetName: request.datasetName, options };
}

async function ensureDirectory(path, { create = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw serviceError('RESEARCH_STORAGE_UNAVAILABLE', 503);
    try {
      await mkdir(path, { mode: 0o700 });
      metadata = await lstat(path);
    } catch {
      throw serviceError('RESEARCH_STORAGE_UNAVAILABLE', 503);
    }
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw serviceError('RESEARCH_STORAGE_PATH_UNSAFE', 503);
}

async function loadDataset(datasetName) {
  await ensureDirectory(DATA_DIRECTORY, { create: true });
  await ensureDirectory(DATASET_DIRECTORY);
  const datasetPath = resolve(DATASET_DIRECTORY, datasetName);
  if (dirname(datasetPath) !== DATASET_DIRECTORY) throw serviceError('RESEARCH_DATASET_NAME_INVALID', 400);
  let metadata;
  try {
    metadata = await lstat(datasetPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw serviceError('RESEARCH_DATASET_NOT_FOUND', 404);
    throw serviceError('RESEARCH_DATASET_UNAVAILABLE', 503);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DATASET_BYTES) {
    throw serviceError('RESEARCH_DATASET_FILE_INVALID_OR_TOO_LARGE', 400);
  }
  try {
    return JSON.parse(await readFile(datasetPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw serviceError('RESEARCH_DATASET_JSON_INVALID', 400);
    throw serviceError('RESEARCH_DATASET_UNAVAILABLE', 503);
  }
}

export async function persistResearchReport(report, reportDirectory = REPORT_DIRECTORY) {
  if (!/^[a-f0-9]{64}$/.test(report.runId) || !verifyResearchReport(report)) {
    throw serviceError('RESEARCH_REPORT_INVALID', 500);
  }
  const directory = resolve(reportDirectory);
  await ensureDirectory(dirname(directory), { create: true });
  await ensureDirectory(directory, { create: true });
  const reportPath = resolve(directory, `${report.runId}.json`);
  if (dirname(reportPath) !== directory) throw serviceError('RESEARCH_REPORT_PATH_INVALID', 500);
  let handle;
  try {
    handle = await open(reportPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw serviceError('RESEARCH_REPORT_WRITE_FAILED', 503);
    try {
      const existing = JSON.parse(await readFile(reportPath, 'utf8'));
      if (existing.runId === report.runId && existing.reportSha256 === report.reportSha256 && verifyResearchReport(existing)) return existing;
    } catch {
      // A colliding or interrupted report is not overwritten; preserve it for review.
    }
    throw serviceError('RESEARCH_REPORT_ALREADY_EXISTS_INVALID', 409);
  }
  let complete = false;
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await handle.sync();
    complete = true;
    return report;
  } catch {
    throw serviceError('RESEARCH_REPORT_WRITE_FAILED', 503);
  } finally {
    await handle.close();
    if (!complete) await unlink(reportPath).catch(() => {});
  }
}

export async function runResearchDataset({ datasetName, options }) {
  const dataset = await loadDataset(datasetName);
  const report = await runWalkForwardEvaluation(dataset, options);
  if (report.liveTradingEnabled !== false || report.profitabilityClaim !== false) {
    throw serviceError('RESEARCH_SAFETY_INVARIANT_FAILED', 500);
  }
  return persistResearchReport(report);
}

export function summarizeResearchReport(report) {
  if (!report || typeof report !== 'object' || !/^[a-f0-9]{64}$/.test(report.runId)
    || report.liveTradingEnabled !== false || report.profitabilityClaim !== false || !Array.isArray(report.folds)) {
    throw serviceError('RESEARCH_REPORT_INVALID', 500);
  }
  return {
    status: 'COMPLETED',
    runId: report.runId,
    reportFileName: `${report.runId}.json`,
    evidenceClass: report.evidenceClass,
    performanceEvidenceEligible: report.performanceEvidenceEligible === true,
    profitabilityClaim: false,
    liveTradingEnabled: false,
    buildId: report.buildId,
    schemaVersionUsed: report.schemaVersionUsed,
    strategyVersion: report.strategyVersion,
    reportSha256: report.reportSha256,
    provenance: {
      datasetId: report.provenance.datasetId,
      dataClass: report.provenance.dataClass,
      sourceAttestation: report.provenance.sourceAttestation,
      datasetSha256: report.provenance.datasetSha256,
      provider: report.provenance.provider,
      quoteCount: report.provenance.quoteCount,
      quoteCoverage: report.provenance.quoteCoverage,
      candleCounts: report.provenance.candleCounts,
    },
    foldOptions: report.foldOptions,
    folds: report.folds.map((fold) => ({
      fold: fold.fold,
      testStartAt: fold.testStartAt,
      testEndAt: fold.testEndAt,
      testBars: fold.testBars,
      scans: fold.scans,
      scanCoveragePct: fold.scanCoveragePct,
      closedTradeCount: fold.closedTradeCount,
      performance: {
        sampleCount: fold.performance?.sampleCount ?? fold.closedTradeCount ?? 0,
        metrics: fold.performance?.metrics ?? null,
        suppressedReason: fold.performance?.suppressedReason ?? 'PERFORMANCE_EVIDENCE_UNAVAILABLE',
      },
      remaining: fold.remaining,
    })),
    limitations: report.methodology?.limitations ?? [],
  };
}
