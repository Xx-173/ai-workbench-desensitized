import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptSessionContext,
  resolveSessionCredentials,
  staticCredentials,
  type SessionContextLike,
} from './session-context-bridge.ts';

function baseContext(over: Partial<SessionContextLike> = {}): SessionContextLike {
  return {
    sessionId: 'session-1',
    workspacePath: '/tmp/workspaces/ws-1',
    fs: {
      exists: () => false,
      readFile: () => '',
      writeFile: () => undefined,
      readdir: () => [],
    },
    ...over,
  };
}

const BINDINGS = {
  VOICE_SERVICE_TOKEN: 'voice-service',
  VIDEO_PARSE_TOKEN: 'video-service',
};

test('the bridge exposes only what the business layer needs', () => {
  const ctx = adaptSessionContext(baseContext(), { credentials: staticCredentials({}) });
  assert.equal(ctx.sessionId, 'session-1');
  assert.equal(ctx.workspacePath, '/tmp/workspaces/ws-1');
  assert.equal(typeof ctx.credentials.read, 'function');
});

test('taskId and progress are optional pass-throughs', () => {
  const seen: unknown[] = [];
  const withBoth = adaptSessionContext(baseContext(), {
    credentials: staticCredentials({}),
    taskId: 'task-9',
    progress: (e) => seen.push(e),
  });
  assert.equal(withBoth.taskId, 'task-9');
  withBoth.progress?.({ type: 'status', message: 'x' });
  assert.deepEqual(seen, [{ type: 'status', message: 'x' }]);

  const minimal = adaptSessionContext(baseContext(), { credentials: staticCredentials({}) });
  assert.equal(minimal.taskId, undefined);
  assert.equal(minimal.progress, undefined);
});

test('credentials resolve from the base source store by placeholder name', async () => {
  const base = baseContext({
    credentialManager: {
      getToken: async (source) => (source.config.slug === 'voice-service' ? 'resolved-token' : null),
      hasValidCredentials: async () => true,
    },
  });
  const reader = await resolveSessionCredentials(base, BINDINGS, [
    'VOICE_SERVICE_TOKEN',
    'VIDEO_PARSE_TOKEN',
    'UNKNOWN_TOKEN',
  ]);
  assert.equal(reader.read('VOICE_SERVICE_TOKEN'), 'resolved-token');
  assert.equal(reader.read('VIDEO_PARSE_TOKEN'), null, 'a source with no token must read as unconfigured');
  assert.equal(reader.read('UNKNOWN_TOKEN'), null, 'an unbound placeholder must read as unconfigured');
});

test('explicit overrides win — the headless / local path', async () => {
  const reader = await resolveSessionCredentials(baseContext(), BINDINGS, ['VOICE_SERVICE_TOKEN'], {
    VOICE_SERVICE_TOKEN: 'from-env',
  });
  assert.equal(reader.read('VOICE_SERVICE_TOKEN'), 'from-env');
});

test('a throwing credential store reads as unconfigured, not as valid', async () => {
  const base = baseContext({
    credentialManager: {
      getToken: async () => {
        throw new Error('keychain unavailable');
      },
      hasValidCredentials: async () => false,
    },
  });
  const reader = await resolveSessionCredentials(base, BINDINGS, ['VOICE_SERVICE_TOKEN']);
  assert.equal(reader.read('VOICE_SERVICE_TOKEN'), null);
});

test('no credential manager at all still yields a usable, empty reader', async () => {
  const reader = await resolveSessionCredentials(baseContext(), BINDINGS, ['VOICE_SERVICE_TOKEN']);
  assert.equal(reader.read('VOICE_SERVICE_TOKEN'), null);
});
