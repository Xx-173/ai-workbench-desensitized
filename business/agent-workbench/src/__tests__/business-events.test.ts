import test from 'node:test';
import assert from 'node:assert/strict';

import { createProgressReporter, runWithEvents, type WorkbenchEvent } from '../business-events.ts';

function collector(): { sink: (e: WorkbenchEvent) => void; events: WorkbenchEvent[] } {
  const events: WorkbenchEvent[] = [];
  return { sink: (e) => events.push(e), events };
}

test('success emits tool_start then a non-error tool_result then complete', async () => {
  const { sink, events } = collector();
  const value = await runWithEvents(sink, 'turn-1', 'clone_voice', 'tool-1', { text: 'x' }, async () => 'done', (v) => v);
  assert.equal(value, 'done');
  assert.deepEqual(
    events.map((e) => e.type),
    ['tool_start', 'tool_result', 'complete'],
  );
  const result = events[1] as Extract<WorkbenchEvent, { type: 'tool_result' }>;
  assert.equal(result.isError, false);
  assert.equal(result.result, 'done');
});

test('a thrown exception becomes a structured error event, not an unhandled rejection', async () => {
  const { sink, events } = collector();
  const value = await runWithEvents(
    sink,
    'turn-1',
    'parse_video',
    'tool-2',
    {},
    async () => {
      throw new Error('upstream 503');
    },
    (v) => v,
  );
  assert.equal(value, null);
  assert.deepEqual(
    events.map((e) => e.type),
    ['tool_start', 'error', 'tool_result', 'complete'],
  );
  const error = events[1] as Extract<WorkbenchEvent, { type: 'error' }>;
  assert.equal(error.message, 'upstream 503');
  const result = events[2] as Extract<WorkbenchEvent, { type: 'tool_result' }>;
  assert.equal(result.isError, true);
});

test('every event carries the turn id so the UI can group a turn', async () => {
  const { sink, events } = collector();
  await runWithEvents(sink, 'turn-42', 'qc_text', 'tool-3', {}, async () => 1, String);
  for (const event of events) {
    assert.equal('turnId' in event ? event.turnId : undefined, 'turn-42');
  }
});

test('progress reports are clamped, deduplicated and monotonic', () => {
  const { sink, events } = collector();
  const report = createProgressReporter(sink, 'turn-1');
  report(0);
  report(0);
  report(50);
  report(50);
  report(140);
  assert.deepEqual(
    events.map((e) => (e.type === 'status' ? e.message : '')),
    ['progress:0%', 'progress:50%', 'progress:100%'],
  );
});
