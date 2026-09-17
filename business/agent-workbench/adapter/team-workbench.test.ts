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
    runtime.workspaceControl.setWorkspaceResolver(async (identity) => `workspace-${identity.userId}`);
    assert.equal(await runtime.httpApi.getDefaultWorkspaceId(signedIn.identity), `workspace-${signedIn.identity.userId}`);
    assert.equal(await runtime.workspaceControl.canAccessWorkspace(signedIn.identity, 'any-admin-workspace'), true);
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

test('department-scoped Agents are hidden and denied by the server for other members', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-workbench-access-'));
  try {
    const runtime = await createTeamWorkbenchRuntime({
      workspaceRootPath: root,
      masterKey: randomBytes(32).toString('base64'),
      sessionSecret: 'session-signing-secret',
      bootstrapAdmin: { username: 'admin', password: 'very-strong-password', departmentName: '平台部' },
    });
    const admin = await runtime.authProvider.authenticate({ username: 'admin', password: 'very-strong-password' }, { ip: 'test' });
    assert.ok(admin);
    const departmentResponse = await runtime.httpApi.fetch(new Request('http://local/api/workbench/departments', {
      method: 'POST', body: JSON.stringify({ name: '市场部' }), headers: { 'content-type': 'application/json' },
    }), admin.identity);
    const marketing = await departmentResponse?.json() as { id: string };
    const userResponse = await runtime.httpApi.fetch(new Request('http://local/api/workbench/users', {
      method: 'POST', body: JSON.stringify({ username: 'member', displayName: '成员', password: 'very-strong-password', departmentId: marketing.id }), headers: { 'content-type': 'application/json' },
    }), admin.identity);
    assert.equal(userResponse?.status, 201);
    const configResponse = await runtime.httpApi.fetch(new Request('http://local/api/workbench/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ includeBuiltinAgents: false, agents: [
        { id: 'marketing-copy', toolName: 'marketing_copy', description: '市场文案', kind: 'python', access: { departmentIds: [marketing.id], roles: ['member'] }, inputSchema: { type: 'object', properties: {} }, config: { command: 'python' } },
        { id: 'finance-copy', toolName: 'finance_copy', description: '财务文案', kind: 'python', access: { departmentIds: ['other-department'], roles: ['member'] }, inputSchema: { type: 'object', properties: {} }, config: { command: 'python' } },
      ] }),
    }), admin.identity);
    assert.equal(configResponse?.status, 200);
    const adminBootstrap = await runtime.httpApi.fetch(new Request('http://local/api/workbench/bootstrap'), admin.identity);
    const adminPayload = await adminBootstrap?.json() as { agents: Array<{ id: string; enabled?: boolean; credentialMode?: string }> };
    assert.equal(adminPayload.agents.find((agent) => agent.id === 'marketing-copy')?.enabled, true);

    const disabled = await runtime.httpApi.fetch(new Request('http://local/api/workbench/agents/marketing-copy', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    }), admin.identity);
    assert.equal(disabled?.status, 200);
    const disabledBootstrap = await runtime.httpApi.fetch(new Request('http://local/api/workbench/bootstrap'), admin.identity);
    const disabledPayload = await disabledBootstrap?.json() as { agents: Array<{ id: string; enabled?: boolean }> };
    assert.equal(disabledPayload.agents.find((agent) => agent.id === 'marketing-copy')?.enabled, false);

    const member = await runtime.authProvider.authenticate({ username: 'member', password: 'very-strong-password' }, { ip: 'test' });
    assert.ok(member);
    runtime.workspaceControl.setWorkspaceResolver(async (identity) => `workspace-${identity.userId}`);
    assert.equal(await runtime.workspaceControl.canAccessWorkspace(member.identity, `workspace-${member.identity.userId}`), true);
    assert.equal(await runtime.workspaceControl.canAccessWorkspace(member.identity, 'another-workspace'), false);
    const bootstrap = await runtime.httpApi.fetch(new Request('http://local/api/workbench/bootstrap'), member.identity);
    const payload = await bootstrap?.json() as { agents: Array<{ id: string }> };
    assert.deepEqual(payload.agents.map((agent) => agent.id), []);
    const denied = await runtime.httpApi.fetch(new Request('http://local/api/workbench/invoke', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'finance-copy', input: {} }),
    }), member.identity);
    assert.equal(denied?.status, 403);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
