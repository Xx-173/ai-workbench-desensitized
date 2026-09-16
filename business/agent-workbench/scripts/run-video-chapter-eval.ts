import { resolve } from 'node:path';

import { runVideoChapterEval, writeVideoChapterEvalArtifact } from '../src/video-chapter-eval.ts';

const segments = [
  { startSec: 0, endSec: 30, text: 'synthetic-1' },
  { startSec: 30, endSec: 60, text: 'synthetic-2' },
  { startSec: 60, endSec: 90, text: 'synthetic-3' },
  { startSec: 90, endSec: 120, text: 'synthetic-4' },
  { startSec: 120, endSec: 150, text: 'synthetic-5' },
  { startSec: 150, endSec: 180, text: 'synthetic-6' },
] as const;

const valid = [
  { section: 'opening', startSec: 0, endSec: 30, summary: 'a' },
  { section: 'knowledge', startSec: 30, endSec: 120, summary: 'b' },
  { section: 'marketing', startSec: 120, endSec: 150, summary: 'c' },
  { section: 'closing', startSec: 150, endSec: 180, summary: 'd' },
];

const outputFlag = process.argv.indexOf('--out');
const output = outputFlag >= 0 ? process.argv[outputFlag + 1] : 'artifacts/video-chapter-eval.json';
if (!output) throw new Error('--out needs a file path');

const report = await runVideoChapterEval([
  { id: 'model-throws', segments, groupByModel: async () => { throw new Error('synthetic failure'); }, expected: { source: 'rule-fallback', reason: 'model-threw' } },
  { id: 'missing-section', segments, groupByModel: async () => valid.slice(0, 3), expected: { source: 'rule-fallback', reason: 'missing-sections' } },
  { id: 'valid-model', segments, groupByModel: async () => [...valid].reverse(), expected: { source: 'model' } },
]);

await writeVideoChapterEvalArtifact(resolve(output), report);
console.log(`video chapter eval: ${report.passed ? 'passed' : 'failed'} (${report.traces.length} cases)`);
if (!report.passed) process.exitCode = 1;
