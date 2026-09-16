import test from 'node:test';
import assert from 'node:assert/strict';

import { runVideoChapterEval } from '../video-chapter-eval.ts';
import { SYNTHETIC_SEGMENTS } from './fixtures.ts';

test('fixed-input eval emits reviewable traces for valid and fallback paths', async () => {
  const report = await runVideoChapterEval([
    {
      id: 'throwing-model', segments: SYNTHETIC_SEGMENTS, groupByModel: async () => { throw new Error('synthetic'); },
      expected: { source: 'rule-fallback', reason: 'model-threw' },
    },
    {
      id: 'valid-model', segments: SYNTHETIC_SEGMENTS,
      groupByModel: async () => [
        { section: 'opening', startSec: 0, endSec: 30 }, { section: 'knowledge', startSec: 30, endSec: 120 },
        { section: 'marketing', startSec: 120, endSec: 150 }, { section: 'closing', startSec: 150, endSec: 180 },
      ], expected: { source: 'model' },
    },
  ], '2026-01-01T00:00:00.000Z');
  assert.equal(report.passed, true);
  assert.deepEqual(report.traces.map((trace) => trace.passed), [true, true]);
  assert.equal(report.traces[0]?.contiguous, true);
});
