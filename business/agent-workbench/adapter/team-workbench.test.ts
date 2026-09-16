import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { createTeamWorkbenchRuntime } from './team-workbench.ts';

test('team workbench authorizes only provisioned users and exposes department-safe admin data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-workbench-'));
  try {
    const runtime = await createTeamWorkbenchRuntime({
      workspaceRootPath: root,
      masterKey: randomBytes(32).toString('base64'),
      sessionSecret: 'session-signing-secret',
      bootstrapAdmin: { username: 'admin', password: 'very-strong-password', departmentName: '平台部' },
    });
    assert.equal(await runtime.authProvider.authenticate({ username: 'nobody', password: 'very-strong-password' }, { ip: 'test' }), null);
    const signedIn = await runtime.authProvider.authenticate({ username: 'admin', password: 'very-strong-password' }, { ip: 'test' });
    assert.ok(signedIn);
    const cookie = runtime.authProvider.buildSessionCookie(signedIn.token, false).split(';')[0]!;
    assert.equal((await runtime.authProvider.validateSession(cookie))?.username, 'admin');

    const bootstrap = await runtime.httpApi.fetch(new Request('http://local/api/workbench/bootstrap'), signedIn.identity);
    assert.equal(bootstrap?.status, 200);
    const payload = await bootstrap?.json() as { identity: { role: string }; departments: unknown[]; users: Array<Record<string, unknown>> };
    assert.equal(payload.identity.role, 'admin');
    assert.equal(payload.departments.length, 1);
    assert.equal(payload.users.some((user) => Object.hasOwn(user, 'passwordHash')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
