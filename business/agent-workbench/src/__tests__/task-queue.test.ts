import test from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryTaskQueue } from '../task-queue.ts';

test('in-memory task queue records an inspectable queued status', async () => {
  const queue = new InMemoryTaskQueue<{ agentId: string }>();
  const task = await queue.enqueue({ agentId: 'video-analysis' });
  assert.equal(task.payload.agentId, 'video-analysis');
  assert.equal((await queue.getStatus(task.id))?.status, 'queued');
  await queue.setStatus({ taskId: task.id, status: 'succeeded', updatedAt: new Date().toISOString(), result: { ok: true } });
  assert.deepEqual((await queue.getStatus(task.id))?.result, { ok: true });
});
