import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  PathEscapeError,
  assertInsideTask,
  assertSafeRelativePath,
  createTaskWorkspace,
  disposeTaskWorkspace,
  listArtifacts,
  writeTaskFile,
} from '../task-workspace.ts';
import { withTempWorkspace } from './fixtures.ts';

test('each task gets its own inputs/outputs/tmp triple', async () => {
  await withTempWorkspace(async (dir) => {
    const first = await createTaskWorkspace(dir, 'task-a');
    const second = await createTaskWorkspace(dir, 'task-b');
    for (const area of ['inputs', 'outputs', 'tmp'] as const) {
      assert.ok(existsSync(first[area]));
      assert.ok(existsSync(second[area]));
      assert.notEqual(first[area], second[area]);
    }
  });
});

test('two tasks writing the same filename do not collide', async () => {
  await withTempWorkspace(async (dir) => {
    const a = await createTaskWorkspace(dir, 'task-a');
    const b = await createTaskWorkspace(dir, 'task-b');
    await writeTaskFile(a, 'outputs', 'chapters.json', '{"owner":"a"}');
    await writeTaskFile(b, 'outputs', 'chapters.json', '{"owner":"b"}');

    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(a.outputs + '/chapters.json', 'utf8'), '{"owner":"a"}');
    assert.equal(readFileSync(b.outputs + '/chapters.json', 'utf8'), '{"owner":"b"}');
  });
});

test('traversal attempts are rejected before touching the filesystem', async () => {
  await withTempWorkspace(async (dir) => {
    const ws = await createTaskWorkspace(dir, 'task-a');
    // '.' / '..' and parent traversal are attacks; a leading separator is not.
    for (const nasty of ['../../escape.txt', 'a/../../b.txt', '..', '.']) {
      await assert.rejects(() => writeTaskFile(ws, 'outputs', nasty, 'x'), PathEscapeError, `should reject ${nasty}`);
    }
    assert.throws(() => assertInsideTask(ws, '/etc/passwd'), PathEscapeError);
  });
});

test('leading separators are normalized rather than treated as absolute', () => {
  assert.equal(assertSafeRelativePath('t', '/nested/file.json'), 'nested/file.json');
});

test('malformed task ids are refused so paths stay predictable', async () => {
  await withTempWorkspace(async (dir) => {
    await assert.rejects(() => createTaskWorkspace(dir, '../escape'));
    await assert.rejects(() => createTaskWorkspace(dir, 'has spaces'));
  });
});

test('artifacts are listed scoped to the task, then cleanup removes only it', async () => {
  await withTempWorkspace(async (dir) => {
    const a = await createTaskWorkspace(dir, 'task-a');
    const b = await createTaskWorkspace(dir, 'task-b');
    await writeTaskFile(a, 'inputs', 'clip.mp4', 'x');
    await writeTaskFile(a, 'outputs', 'chapters.json', 'y');

    assert.deepEqual(await listArtifacts(a), ['inputs/clip.mp4', 'outputs/chapters.json']);
    assert.equal(existsSync(a.root), true);

    await disposeTaskWorkspace(a);
    assert.equal(existsSync(a.root), false);
    assert.equal(existsSync(b.root), true, 'the other task must survive');
  });
});
