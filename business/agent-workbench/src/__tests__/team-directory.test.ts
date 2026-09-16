import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TeamDirectory } from '../team-directory.ts';

test('team directory bootstraps an administrator, distinguishes departments and revokes disabled accounts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'team-directory-'));
  try {
    const directory = await TeamDirectory.open(join(dir, 'team.json'), {
      adminUsername: 'admin', adminPassword: 'very-strong-password', departmentName: '运营部',
    });
    const department = await directory.createDepartment('市场部');
    const member = await directory.createUser({
      username: 'li.na', displayName: '李娜', password: 'another-strong-password', departmentId: department.id,
    });
    assert.equal((await directory.authenticate('li.na', 'another-strong-password'))?.departmentId, department.id);
    await directory.updateUser(member.id, { status: 'disabled' });
    assert.equal(await directory.authenticate('li.na', 'another-strong-password'), null);
    assert.equal(directory.listUsers().some((user) => Object.hasOwn(user, 'passwordHash')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
