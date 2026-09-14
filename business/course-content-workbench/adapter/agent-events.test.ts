import test from 'node:test';
import assert from 'node:assert/strict';

import { EMITTED_EVENT_TYPES, toAgentEvent } from './agent-events.ts';
import type { WorkbenchEvent } from '../src/business-events.ts';

test('every business event maps onto a real member of the base union', () => {
  const events: WorkbenchEvent[] = [
    { type: 'status', message: 'progress:10%' },
    { type: 'text_delta', text: 'hi', turnId: 't1' },
    { type: 'tool_start', toolName: 'clone_voice', toolUseId: 'u1', input: {}, turnId: 't1' },
    { type: 'tool_result', toolUseId: 'u1', toolName: 'clone_voice', result: 'ok', isError: false, turnId: 't1' },
    { type: 'error', message: 'boom', turnId: 't1' },
    { type: 'complete', turnId: 't1' },
  ];
  for (const event of events) {
    const mapped = toAgentEvent(event);
    assert.equal(mapped.type, event.type);
  }
});

test('turnId survives the mapping so the UI can still group a turn', () => {
  const mapped = toAgentEvent({ type: 'text_delta', text: 'x', turnId: 'turn-7' });
  assert.equal('turnId' in mapped ? mapped.turnId : undefined, 'turn-7');
});

test('optional fields are omitted rather than emitted as undefined', () => {
  const mapped = toAgentEvent({ type: 'complete' });
  assert.deepEqual(mapped, { type: 'complete' });
});

test('tool_result preserves the error flag — recovery depends on it', () => {
  const mapped = toAgentEvent({ type: 'tool_result', toolUseId: 'u1', result: 'upstream 503', isError: true });
  assert.equal(mapped.type, 'tool_result');
  if (mapped.type === 'tool_result') assert.equal(mapped.isError, true);
});

test('the emitted set is exactly the six documented members', () => {
  assert.deepEqual([...EMITTED_EVENT_TYPES], ['status', 'text_delta', 'tool_start', 'tool_result', 'error', 'complete']);
});
