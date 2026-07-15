import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentCapabilityCaseSchema,
  agentCapabilityObservationSchema,
  assessAgentCapabilityObservation,
  summarizeAgentCapabilityBenchmark,
  summarizeAgentCapabilityBenchmarkByVersion,
} from './agentCapability';

const defaultCaseDirectory = fileURLToPath(
  new URL('../../../../benchmarks/agent-capability/cases/', import.meta.url),
);

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function main(): Promise<void> {
  const caseDirectory = resolve(process.argv[2] ?? defaultCaseDirectory);
  const filenames = (await readdir(caseDirectory))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const cases = await Promise.all(filenames.map(async (filename) =>
    agentCapabilityCaseSchema.parse(await loadJson(resolve(caseDirectory, filename)))));
  const duplicate = cases.find((item, index) => cases.findIndex((candidate) => candidate.id === item.id) !== index);
  if (duplicate) throw new Error(`duplicate benchmark case id: ${duplicate.id}`);

  const observationPath = process.argv[3];
  if (!observationPath) {
    console.log(JSON.stringify({ validatedCases: cases.length, caseIds: cases.map((item) => item.id) }, null, 2));
    return;
  }
  const rawObservations = await loadJson(resolve(observationPath));
  const observations = agentCapabilityObservationSchema.array().parse(rawObservations);
  const byId = new Map(cases.map((item) => [item.id, item]));
  const assessments = observations.map((observation) => {
    const benchmarkCase = byId.get(observation.caseId);
    if (!benchmarkCase) return { caseId: observation.caseId, pass: false, reasons: ['unknown benchmark case'] };
    return { caseId: observation.caseId, ...assessAgentCapabilityObservation(benchmarkCase, observation) };
  });
  const report = {
    validatedCases: cases.length,
    observedCases: observations.length,
    metrics: summarizeAgentCapabilityBenchmark(observations),
    byHarnessVersion: summarizeAgentCapabilityBenchmarkByVersion(observations),
    assessments,
  };
  console.log(JSON.stringify(report, null, 2));
  if (assessments.some((assessment) => !assessment.pass)) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
