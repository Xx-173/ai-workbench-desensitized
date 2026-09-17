import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalTaskArtifactStore } from '../task-artifacts.ts';

test('local task artifact store keeps input and output files under one task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-artifacts-'));
  try {
    const store = new LocalTaskArtifactStore();
    const input = await store.put({ workspacePath: root, taskId: 'web-user-1', area: 'inputs', filename: 'lesson.mp4', mimeType: 'video/mp4', bytes: Buffer.from('video') });
    assert.equal(input.relativePath, 'inputs/lesson.mp4');
    const output = await store.put({ workspacePath: root, taskId: 'web-user-1', area: 'outputs', filename: 'chapters.json', mimeType: 'application/json', bytes: Buffer.from('{}') });
    assert.equal(output.relativePath, 'outputs/chapters.json');
    assert.deepEqual((await store.list(root, 'web-user-1')).map((item) => item.relativePath), ['inputs/lesson.mp4', 'outputs/chapters.json']);
    const read = await store.read(root, 'web-user-1', 'inputs', 'lesson.mp4');
    assert.equal(read?.bytes.toString(), 'video');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local task artifact store rejects traversal in artifact names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-artifacts-'));
  try {
    const store = new LocalTaskArtifactStore();
    await assert.rejects(() => store.put({ workspacePath: root, taskId: 'web-user-1', area: 'inputs', filename: '../../escape.mp4', bytes: Buffer.from('x') }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
