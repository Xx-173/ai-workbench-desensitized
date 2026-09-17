#!/usr/bin/env bun

import { homedir } from 'node:os';
import { join } from 'node:path';

import { createTeamWorkbenchRuntime } from '../adapter/team-workbench.ts';

const masterKey = process.env.AGENT_WORKBENCH_MASTER_KEY;
const sessionSecret = process.env.CRAFT_SERVER_TOKEN;
if (!masterKey || !sessionSecret) {
  throw new Error('Worker requires AGENT_WORKBENCH_MASTER_KEY and CRAFT_SERVER_TOKEN');
}

const runtime = await createTeamWorkbenchRuntime({
  workspaceRootPath: process.env.AGENT_WORKBENCH_ROOT ?? join(homedir(), '.craft-agent', 'agent-workbench'),
  masterKey,
  sessionSecret,
  asyncTasks: true,
  startWorker: true,
  workerConsumer: process.env.AGENT_WORKBENCH_WORKER_CONSUMER ?? `craft-worker-${process.pid}`,
});
if (!runtime.taskQueue) throw new Error('Worker requires AGENT_WORKBENCH_REDIS_URL');

console.log('[workbench-worker] consuming Redis task stream');
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await runtime.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise<void>(() => undefined);
