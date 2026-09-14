import test from 'node:test';
import assert from 'node:assert/strict';

import { SECTIONS, buildChapters, chaptersByEqualIntervals, normalizeModelChapters } from '../video-chapters.ts';
import { SYNTHETIC_SEGMENTS } from './fixtures.ts';

const segments = [...SYNTHETIC_SEGMENTS];
const bounds = { start: 0, end: 180 };

const goodModelOutput = [
  { section: 'opening', startSec: 0, endSec: 30, summary: '开场' },
  { section: 'knowledge', startSec: 30, endSec: 120, summary: '知识讲解' },
  { section: 'marketing', startSec: 120, endSec: 150, summary: '资料介绍' },
  { section: 'closing', startSec: 150, endSec: 180, summary: '收尾' },
];

test('model grouping is accepted and reordered into canonical order', async () => {
  const shuffled = [goodModelOutput[2]!, goodModelOutput[0]!, goodModelOutput[3]!, goodModelOutput[1]!];
  const result = await buildChapters(segments, { groupByModel: async () => shuffled });
  assert.equal(result.source, 'model');
  assert.deepEqual(
    result.chapters.map((c) => c.section),
    [...SECTIONS],
  );
});

test('a throwing model falls back to equal intervals and never rejects', async () => {
  const result = await buildChapters(segments, {
    groupByModel: async () => {
      throw new Error('model unavailable');
    },
  });
  assert.equal(result.source, 'rule-fallback');
  assert.equal(result.reason, 'model-threw');
  assert.equal(result.chapters.length, 4);
});

test('a dropped section is a failure, not silently rendered', async () => {
  const result = await buildChapters(segments, { groupByModel: async () => goodModelOutput.slice(0, 3) });
  assert.equal(result.source, 'rule-fallback');
  assert.equal(result.reason, 'missing-sections');
  assert.match(result.warnings.join(','), /closing/);
});

test('chapters outside the transcript bounds are rejected', async () => {
  const overflow = [...goodModelOutput];
  overflow[3] = { section: 'closing', startSec: 150, endSec: 9999, summary: 'out of range' };
  const result = await buildChapters(segments, { groupByModel: async () => overflow });
  assert.equal(result.source, 'rule-fallback');
  assert.equal(result.reason, 'out-of-bounds');
});

test('overlapping chapters are rejected', async () => {
  const overlapping = [
    { section: 'opening', startSec: 0, endSec: 90, summary: '' },
    { section: 'knowledge', startSec: 30, endSec: 120, summary: '' },
    { section: 'marketing', startSec: 120, endSec: 150, summary: '' },
    { section: 'closing', startSec: 150, endSec: 180, summary: '' },
  ];
  const result = await buildChapters(segments, { groupByModel: async () => overlapping });
  assert.equal(result.source, 'rule-fallback');
  assert.equal(result.reason, 'non-monotonic');
});

test('garbage shapes are rejected without throwing', () => {
  assert.equal(normalizeModelChapters('not-an-array', bounds).ok, false);
  assert.equal(normalizeModelChapters([null, 42, {}], bounds).ok, false);
});

test('empty transcript yields empty chapters rather than crashing', async () => {
  const result = await buildChapters([], { groupByModel: async () => goodModelOutput });
  assert.deepEqual(result.chapters, []);
  assert.equal(result.reason, 'no-segments');
});

test('the fallback rule always produces four contiguous, ordered chapters', () => {
  const chapters = chaptersByEqualIntervals(segments);
  assert.equal(chapters.length, 4);
  assert.equal(chapters[0]!.startSec, 0);
  assert.equal(chapters[3]!.endSec, 180);
  for (let i = 1; i < chapters.length; i += 1) {
    assert.equal(chapters[i]!.startSec, chapters[i - 1]!.endSec);
  }
});

test('page hints attach a page range per chapter', async () => {
  const result = await buildChapters(segments, {
    pageHints: [
      { startSec: 10, page: 1 },
      { startSec: 70, page: 4 },
      { startSec: 100, page: 7 },
      { startSec: 160, page: 12 },
    ],
    groupByModel: async () => goodModelOutput,
  });
  const pages = result.chapters.map((c) => c.pageRange);
  assert.deepEqual(pages[0], { from: 1, to: 1 });
  assert.deepEqual(pages[1], { from: 4, to: 7 });
  assert.deepEqual(pages[3], { from: 12, to: 12 });
});
