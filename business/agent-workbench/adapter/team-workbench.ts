/**
 * Browser/team adapter for the Agent Workbench.
 *
 * It is intentionally passed into Craft's WebUI handler as a narrow HTTP
 * adapter: Craft keeps owning its chat/runtime, while this layer owns only
 * business Agent execution, admin-issued accounts and privacy-safe usage.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import { createWorkbenchRegistry } from '../src/index.ts';
import { AgentControlPlane, FileManifestStore } from '../src/control-plane.ts';
import { EncryptedFileSecretVault } from '../src/secret-vault.ts';
import { JsonlUsageLedger, type AgentUsageEvent } from '../src/usage-ledger.ts';
import { JsonlCaseMemory } from '../src/case-memory.ts';
import { mapAgentResult } from '../src/result-mapper.ts';
import { TeamDirectory, type AccountStatus, type TeamRole, type TeamUser } from '../src/team-directory.ts';
import type { JsonObject, JsonValue, ToolContext } from '../src/ports.ts';
import type { AgentManifest } from '../src/agent-manifest.ts';

const SESSION_COOKIE = 'craft_team_session';
const SESSION_SECONDS = 8 * 60 * 60;
const BODY_LIMIT = 1_000_000;

class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export interface TeamIdentity {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly departmentId: string;
  readonly role: TeamRole;
}

interface SignedSession {
  readonly userId: string;
  readonly exp: number;
  readonly nonce: string;
}

export interface TeamWorkbenchOptions {
  readonly workspaceRootPath: string;
  readonly masterKey: string;
  readonly sessionSecret: string;
  readonly bootstrapAdmin?: {
    readonly username: string;
    readonly password: string;
    readonly displayName?: string;
    readonly departmentName?: string;
  };
  readonly manifestsPath?: string;
  readonly secretStorePath?: string;
  readonly teamStorePath?: string;
  readonly usagePath?: string;
  /** Optional content-free operational case memory path. */
  readonly caseMemoryPath?: string;
}

export interface TeamAuthProvider {
  authenticate(credentials: { username?: string; password: string }, requestInfo: { ip: string }): Promise<{ identity: TeamIdentity; token: string } | null>;
  validateSession(cookieHeader: string | null): Promise<TeamIdentity | null>;
  buildSessionCookie(token: string, secure: boolean): string;
  buildLogoutCookie(secure: boolean): string;
}

export interface WorkbenchHttpApi {
  fetch(request: Request, identity: TeamIdentity): Promise<Response | null>;
  /** Resolve the only Craft workspace a normal team member may use. */
  getDefaultWorkspaceId(identity: TeamIdentity): Promise<string | null>;
}

export interface TeamWorkspaceControl {
  setWorkspaceResolver(resolver: (identity: TeamIdentity) => Promise<string>): void;
  canAccessWorkspace(identity: TeamIdentity, workspaceId: string | null | undefined): Promise<boolean>;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function sessionCookie(value: string, secure: boolean, maxAge: number): string {
  const parts = [`${SESSION_COOKIE}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function asIdentity(user: TeamUser): TeamIdentity {
  return { userId: user.id, username: user.username, displayName: user.displayName, departmentId: user.departmentId, role: user.role };
}

class DirectoryAuthProvider implements TeamAuthProvider {
  private readonly directory: TeamDirectory;
  private readonly secret: string;

  constructor(directory: TeamDirectory, secret: string) {
    this.directory = directory;
    this.secret = secret;
  }

  async authenticate(credentials: { username?: string; password: string }): Promise<{ identity: TeamIdentity; token: string } | null> {
    if (!credentials.username) return null;
    const user = await this.directory.authenticate(credentials.username, credentials.password);
    if (!user) return null;
    return { identity: asIdentity(user), token: this.sign(user.id) };
  }

  async validateSession(cookieHeader: string | null): Promise<TeamIdentity | null> {
    const token = getCookie(cookieHeader, SESSION_COOKIE);
    const payload = token ? this.verify(token) : null;
    if (!payload || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    const user = this.directory.getUser(payload.userId);
    return user && user.status === 'active' ? asIdentity(user) : null;
  }

  buildSessionCookie(token: string, secure: boolean): string {
    return sessionCookie(token, secure, SESSION_SECONDS);
  }

  buildLogoutCookie(secure: boolean): string {
    return sessionCookie('', secure, 0);
  }

  private sign(userId: string): string {
    const payload: SignedSession = { userId, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, nonce: base64url(randomBytes(12)) };
    const encoded = base64url(JSON.stringify(payload));
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private verify(token: string): SignedSession | null {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return null;
    const expected = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    if (!constantTimeEquals(signature, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedSession;
      return typeof payload.userId === 'string' && typeof payload.exp === 'number' && typeof payload.nonce === 'string' ? payload : null;
    } catch {
      return null;
    }
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > BODY_LIMIT) throw new Error('Request body exceeds 1 MB');
  const text = await request.text();
  if (text.length > BODY_LIMIT) throw new Error('Request body exceeds 1 MB');
  return JSON.parse(text) as unknown;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be an object');
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required`);
  return value;
}

interface UsageFilter {
  readonly from?: number;
  readonly to?: number;
  readonly includeTests: boolean;
}

function parseUsageFilter(url: URL): UsageFilter {
  const parse = (value: string | null): number | undefined => {
    if (!value) return undefined;
    const timestamp = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  };
  const toRaw = url.searchParams.get('to');
  const parsedTo = parse(toRaw);
  const to = parsedTo === undefined || !toRaw || toRaw.length !== 10 ? parsedTo : parsedTo + 86_400_000;
  return { from: parse(url.searchParams.get('from')), to, includeTests: url.searchParams.get('includeTests') === 'true' };
}

function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input must be a JSON object');
  return value as JsonObject;
}

function eventTotals(events: readonly AgentUsageEvent[]) {
  const totals = { calls: 0, successes: 0, failures: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 };
  for (const event of events) {
    totals.calls += 1;
    totals.successes += event.status === 'success' ? 1 : 0;
    totals.failures += event.status === 'error' ? 1 : 0;
    totals.durationMs += event.durationMs;
    totals.inputTokens += event.inputTokens ?? 0;
    totals.outputTokens += event.outputTokens ?? 0;
  }
  return totals;
}

class TeamWorkbenchApi implements WorkbenchHttpApi, TeamWorkspaceControl {
  private readonly directory: TeamDirectory;
  private readonly plane: AgentControlPlane;
  private readonly vault: EncryptedFileSecretVault;
  private readonly usage: JsonlUsageLedger;
  private readonly caseMemory: JsonlCaseMemory;
  private readonly workspaceRootPath: string;
  private workspaceResolver: ((identity: TeamIdentity) => Promise<string>) | null = null;

  constructor(
    directory: TeamDirectory,
    plane: AgentControlPlane,
    vault: EncryptedFileSecretVault,
    usage: JsonlUsageLedger,
    caseMemory: JsonlCaseMemory,
    workspaceRootPath: string,
  ) {
    this.directory = directory;
    this.plane = plane;
    this.vault = vault;
    this.usage = usage;
    this.caseMemory = caseMemory;
    this.workspaceRootPath = workspaceRootPath;
  }

  setWorkspaceResolver(resolver: (identity: TeamIdentity) => Promise<string>): void {
    this.workspaceResolver = resolver;
  }

  async getDefaultWorkspaceId(identity: TeamIdentity): Promise<string | null> {
    return this.workspaceResolver ? this.workspaceResolver(identity) : null;
  }

  async canAccessWorkspace(identity: TeamIdentity, workspaceId: string | null | undefined): Promise<boolean> {
    if (identity.role === 'admin') return true;
    if (!workspaceId || !this.workspaceResolver) return false;
    return workspaceId === await this.workspaceResolver(identity);
  }

  async fetch(request: Request, identity: TeamIdentity): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/workbench')) return null;
    try {
      if (request.method === 'GET' && path === '/api/workbench/bootstrap') return json(await this.bootstrap(identity));
      if (request.method === 'POST' && path === '/api/workbench/invoke') return json(await this.invokeWithSource(identity, await readJson(request), 'user'));
      if (request.method === 'GET' && path === '/api/workbench/usage/me') return json(await this.usageFor(identity.userId, parseUsageFilter(new URL(request.url))));
      if (identity.role !== 'admin') return json({ error: 'Administrator role required' }, 403);

      if (request.method === 'GET' && path === '/api/workbench/departments') return json(this.directory.listDepartments());
      if (request.method === 'POST' && path === '/api/workbench/departments') {
        const body = requireObject(await readJson(request));
        return json(await this.directory.createDepartment(requireString(body.name, 'name')), 201);
      }
      if (request.method === 'GET' && path === '/api/workbench/users') return json(this.directory.listUsers());
      if (request.method === 'POST' && path === '/api/workbench/users') return json(await this.createUser(await readJson(request)), 201);
      const userMatch = path.match(/^\/api\/workbench\/users\/([0-9a-f-]+)$/i);
      if (request.method === 'PATCH' && userMatch) return json(await this.updateUser(userMatch[1]!, await readJson(request)));
      if (request.method === 'GET' && path === '/api/workbench/usage/team') return json(await this.teamUsage(parseUsageFilter(new URL(request.url))));
      if (request.method === 'GET' && path === '/api/workbench/config') return json(await this.plane.getConfig());
      if (request.method === 'PUT' && path === '/api/workbench/config') return json(await this.plane.replaceConfig(await readJson(request)));
      const agentMatch = path.match(/^\/api\/workbench\/agents\/([A-Za-z0-9_-]+)$/);
      if (agentMatch && request.method === 'PATCH') return json(await this.updateAgent(agentMatch[1]!, await readJson(request)));
      if (agentMatch && request.method === 'DELETE') return json(await this.deleteAgent(agentMatch[1]!));
      const testMatch = path.match(/^\/api\/workbench\/agents\/([A-Za-z0-9_-]+)\/test$/);
      if (testMatch && request.method === 'POST') {
        return json(await this.invokeWithSource(identity, { agentId: testMatch[1], input: await readJson(request) }, 'admin_test'));
      }
      if (request.method === 'GET' && path === '/api/workbench/secrets') return json(await this.plane.listSecrets());
      if (request.method === 'POST' && path === '/api/workbench/secrets') {
        const body = requireObject(await readJson(request));
        const name = requireString(body.name, 'name');
        await this.plane.setSecret(name, requireString(body.value, 'value'));
        return json({ name, configured: true }, 201);
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof ForbiddenError ? 403 : 400);
    }
  }

  private async bootstrap(identity: TeamIdentity) {
    const config = await this.plane.getConfig();
    const visibleAgents = config.agents.filter((agent) => (identity.role === 'admin' || agent.enabled !== false) && this.canUseAgent(identity, agent));
    const agents = await Promise.all(visibleAgents.map(async (agent) => ({
      id: agent.id, toolName: agent.toolName, description: agent.description, kind: agent.kind,
      credentialMode: agent.credentialMode, enabled: agent.enabled !== false,
      inputSchema: agent.inputSchema, access: agent.access, health: await this.plane.checkAgent(agent.id),
    })));
    return {
      identity,
      workspaceId: await this.getDefaultWorkspaceId(identity),
      agents,
      ownUsage: await this.usageFor(identity.userId),
      ...(identity.role === 'admin' ? {
        departments: this.directory.listDepartments(), users: this.directory.listUsers(), teamUsage: await this.teamUsage(),
      } : {}),
    };
  }

  private async invokeWithSource(identity: TeamIdentity, input: unknown, source: 'user' | 'admin_test') {
    const body = requireObject(input);
    const agentId = requireString(body.agentId, 'agentId');
    const config = await this.plane.getConfig();
    const agent = config.agents.find((entry) => entry.id === agentId && entry.enabled !== false);
    if (!agent) throw new Error('Unknown agent');
    if (!this.canUseAgent(identity, agent)) throw new ForbiddenError('You are not allowed to use this Agent');
    const context: ToolContext = {
      sessionId: `web-${identity.userId}-${Date.now()}`,
      taskId: `web-${identity.userId}-${Date.now()}`,
      workspacePath: this.workspaceRootPath,
      credentials: this.vault,
      actor: { userId: identity.userId, departmentId: identity.departmentId },
      usageSource: source,
    };
    const registry = createWorkbenchRegistry({
      agents: [agent], includeBuiltinAgents: false,
      runtime: { usageRecorder: this.usage, usageReader: this.usage, caseMemory: this.caseMemory },
    });
    const result = await registry.invoke(agent.id, context, asJsonObject(body.input));
    const mapped = result.raw === undefined ? null : mapAgentResult(result.raw);
    return { summary: result.summary, artifacts: [...new Set([...(result.artifacts ?? []), ...(mapped?.artifacts ?? [])])], mapped };
  }

  private async updateAgent(agentId: string, input: unknown) {
    const body = requireObject(input);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    const config = await this.plane.getConfig();
    const index = config.agents.findIndex((agent) => agent.id === agentId);
    if (index < 0) throw new Error(`Unknown agent: ${agentId}`);
    const agents = config.agents.map((agent, current) => current === index ? {
      ...agent,
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(body.description === undefined ? {} : { description: requireString(body.description, 'description') }),
    } : agent);
    return this.plane.replaceConfig({ ...config, agents });
  }

  private async deleteAgent(agentId: string) {
    const config = await this.plane.getConfig();
    const removed = config.agents.find((agent) => agent.id === agentId);
    if (!removed) throw new Error(`Unknown agent: ${agentId}`);
    const agents = config.agents.filter((agent) => agent.id !== agentId);
    const saved = await this.plane.replaceConfig({ ...config, agents });
    const usedReferences = new Set((await this.plane.getConfig()).agents.flatMap((agent) => {
      const refs: string[] = [...(agent.credentials ?? [])].map((binding) => binding.source);
      if (agent.kind === 'http') {
        const http = agent.config as { baseUrlEnv: string; tokenEnv?: string };
        refs.push(http.baseUrlEnv, ...(http.tokenEnv ? [http.tokenEnv] : []));
      }
      return refs;
    }));
    const removedReferences: string[] = [];
    const removedRefs = [...(removed.credentials ?? [])].map((binding) => binding.source);
    if (removed.kind === 'http') {
      const http = removed.config as { baseUrlEnv: string; tokenEnv?: string };
      removedRefs.push(http.baseUrlEnv, ...(http.tokenEnv ? [http.tokenEnv] : []));
    }
    for (const reference of new Set(removedRefs)) {
      if (!usedReferences.has(reference)) {
        await this.plane.deleteSecret(reference);
        removedReferences.push(reference);
      }
    }
    return { ...saved, removedReferences };
  }

  private async createUser(input: unknown): Promise<TeamUser> {
    const body = requireObject(input);
    const role = body.role === undefined ? undefined : requireString(body.role, 'role') as TeamRole;
    return this.directory.createUser({
      username: requireString(body.username, 'username'), displayName: requireString(body.displayName, 'displayName'),
      password: requireString(body.password, 'password'), departmentId: requireString(body.departmentId, 'departmentId'), role,
    });
  }

  private async updateUser(id: string, input: unknown): Promise<TeamUser> {
    const body = requireObject(input);
    const update: { displayName?: string; password?: string; departmentId?: string; role?: TeamRole; status?: AccountStatus } = {};
    if (body.displayName !== undefined) update.displayName = requireString(body.displayName, 'displayName');
    if (body.password !== undefined) update.password = requireString(body.password, 'password');
    if (body.departmentId !== undefined) update.departmentId = requireString(body.departmentId, 'departmentId');
    if (body.role !== undefined) update.role = requireString(body.role, 'role') as TeamRole;
    if (body.status !== undefined) update.status = requireString(body.status, 'status') as AccountStatus;
    return this.directory.updateUser(id, update);
  }

  private async usageFor(userId: string, filter: UsageFilter = { includeTests: false }) {
    const events = this.filterUsageEvents(await this.usage.listSince(new Date(filter.from ?? 0)), filter).filter((event) => event.userId === userId);
    const byAgent = this.groupUsage(events, (event) => event.agentId, (id) => id);
    return { ...eventTotals(events), byAgent };
  }

  private async teamUsage(filter: UsageFilter = { includeTests: false }) {
    const events = this.filterUsageEvents(await this.usage.listSince(new Date(filter.from ?? 0)), filter);
    const departments = new Map(this.directory.listDepartments().map((department) => [department.id, department.name]));
    const users = new Map(this.directory.listUsers().map((user) => [user.id, user]));
    return {
      total: eventTotals(events),
      byDepartment: this.groupUsage(events, (event) => event.departmentId ?? 'unassigned', (id) => departments.get(id) ?? '未分配'),
      byUser: this.groupUsage(events, (event) => event.userId ?? 'unknown', (id) => users.get(id)?.displayName ?? '未知账号'),
      byAgent: this.groupUsage(events, (event) => event.agentId, (id) => id),
    };
  }

  private filterUsageEvents(events: readonly AgentUsageEvent[], filter: UsageFilter): readonly AgentUsageEvent[] {
    return events.filter((event) => {
      const timestamp = Date.parse(event.occurredAt);
      return (filter.includeTests || event.source !== 'admin_test') && (filter.to === undefined || timestamp < filter.to);
    });
  }

  private canUseAgent(identity: TeamIdentity, agent: AgentManifest): boolean {
    if (identity.role === 'admin') return true;
    const access = agent.access;
    if (!access) return true;
    if (access.roles && !access.roles.includes(identity.role)) return false;
    return !access.departmentIds || access.departmentIds.includes(identity.departmentId);
  }

  private groupUsage<T extends string>(events: readonly AgentUsageEvent[], key: (event: AgentUsageEvent) => T, name: (id: T) => string) {
    const groups = new Map<T, AgentUsageEvent[]>();
    for (const event of events) {
      const id = key(event);
      groups.set(id, [...(groups.get(id) ?? []), event]);
    }
    return [...groups.entries()].map(([id, values]) => ({ id, name: name(id), ...eventTotals(values) })).sort((a, b) => b.calls - a.calls);
  }
}

export async function createTeamWorkbenchRuntime(options: TeamWorkbenchOptions): Promise<{
  authProvider: TeamAuthProvider;
  httpApi: WorkbenchHttpApi;
  workspaceControl: TeamWorkspaceControl;
}> {
  const controlDir = join(options.workspaceRootPath, '.agent-workbench');
  const bootstrap = options.bootstrapAdmin;
  const directory = await TeamDirectory.open(options.teamStorePath ?? join(controlDir, 'team.json'), bootstrap ? {
    adminUsername: bootstrap.username,
    adminPassword: bootstrap.password,
    ...(bootstrap.displayName ? { adminDisplayName: bootstrap.displayName } : {}),
    ...(bootstrap.departmentName ? { departmentName: bootstrap.departmentName } : {}),
  } : undefined);
  const vault = await EncryptedFileSecretVault.open(options.secretStorePath ?? join(controlDir, 'secrets.enc.json'), options.masterKey);
  const usage = new JsonlUsageLedger(options.usagePath ?? join(controlDir, 'usage.jsonl'));
  const caseMemory = new JsonlCaseMemory(options.caseMemoryPath ?? join(controlDir, 'case-memory.jsonl'));
  const plane = new AgentControlPlane(
    new FileManifestStore(options.manifestsPath ?? join(controlDir, 'agents.json')),
    vault,
    usage,
  );
  const httpApi = new TeamWorkbenchApi(directory, plane, vault, usage, caseMemory, options.workspaceRootPath);
  return {
    authProvider: new DirectoryAuthProvider(directory, options.sessionSecret),
    httpApi,
    workspaceControl: httpApi,
  };
}
