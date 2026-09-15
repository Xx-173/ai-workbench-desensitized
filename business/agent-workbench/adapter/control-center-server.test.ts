import test from 'node:test';
import assert from 'node:assert/strict';

import { parseControlCenterArgs } from './control-center-server.ts';

test('Control Center defaults to loopback and its private workspace state directory', () => {
  const config = parseControlCenterArgs(['--workspace-root', '/tmp/workspace'], { AGENT_WORKBENCH_ADMIN_TOKEN: '' } as NodeJS.ProcessEnv);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4318);
  assert.match(config.manifestsPath, /\.agent-workbench/);
});

test('a non-loopback Control Center requires an admin token', () => {
  assert.throws(
    () => parseControlCenterArgs(['--workspace-root', '/tmp/workspace', '--host', '0.0.0.0'], {}),
    /requires AGENT_WORKBENCH_ADMIN_TOKEN/,
  );
});
