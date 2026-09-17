/**
 * Enterprise persistence adapters.
 *
 * The business layer keeps file-backed implementations for a zero-dependency
 * local preview. When AGENT_WORKBENCH_DATABASE_URL is present, the server
 * selects these PostgreSQL implementations instead. Secrets remain in the
 * encrypted vault/secret manager and are never copied into these tables.
 */

import { randomUUID, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool, type QueryResultRow } from 'pg';

import { parseAgentWorkbenchConfig, type AgentManifest, type AgentWorkbenchConfig } from './agent-manifest.ts';
import { InMemoryUsageLedger, type AgentUsageEvent, type UsageLedger, type UsageSummary } from './usage-ledger.ts';
import type { ManifestStore } from './control-plane.ts';
import type {
  CreateTeamUserInput,
  TeamDepartment,
  TeamDirectoryPort,
  TeamRole,
  TeamUser,
  UpdateTeamUserInput,
  AccountStatus,
} from './team-directory.ts';
import type { AgentCaseMemoryEntry, CaseMemoryRecorder } from './case-memory.ts';

const scrypt = promisify(scryptCallback);
const PASSWORD_MIN_LENGTH = 10;

export interface EnterpriseStorageOptions {
  readonly databaseUrl: string;
  readonly maxConnections?: number;
  readonly ssl?: boolean;
}

export interface EnterpriseStorage {
  readonly pool: Pool;
  readonly directory: TeamDirectoryPort;
  readonly manifests: ManifestStore;
  readonly usage: UsageLedger;
  readonly caseMemory: CaseMemoryRecorder;
}

function rowString(row: QueryResultRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Database column ${key} is invalid`);
  return value;
}

function normalizeName(value: string, label: string, min = 1, max = 80): string {
  const result = value.trim();
  if (result.length < min || result.length > max) throw new Error(`${label} must be ${min}..${max} characters`);
  return result;
}

function validateUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(username)) {
    throw new Error('username must be 3..64 letters, numbers, dots, underscores or hyphens');
  }
  return username;
}

function validateRole(value: TeamRole): TeamRole {
  if (value !== 'admin' && value !== 'member') throw new Error('role must be admin or member');
  return value;
}

function validateStatus(value: AccountStatus): AccountStatus {
  if (value !== 'active' && value !== 'disabled') throw new Error('status must be active or disabled');
  return value;
}

async function hashPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltValue, digestValue] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !digestValue) return false;
  try {
    const digest = Buffer.from(digestValue, 'base64url');
    const derived = await scrypt(password, Buffer.from(saltValue, 'base64url'), digest.length) as Buffer;
    return digest.length === derived.length && timingSafeEqual(digest, derived);
  } catch {
    return false;
  }
}

function asDepartment(row: QueryResultRow): TeamDepartment {
  return { id: rowString(row, 'id'), name: rowString(row, 'name'), createdAt: new Date(row.created_at as string).toISOString() };
}

function asUser(row: QueryResultRow): TeamUser {
  return {
    id: rowString(row, 'id'), username: rowString(row, 'username'), displayName: rowString(row, 'display_name'),
    departmentId: rowString(row, 'department_id'), role: rowString(row, 'role') as TeamRole,
    status: rowString(row, 'status') as AccountStatus,
    createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

interface UserRow extends QueryResultRow {
  id: string; username: string; display_name: string; department_id: string; role: TeamRole; status: AccountStatus;
  password_hash: string; created_at: string; updated_at: string;
}

export class PostgresTeamDirectory implements TeamDirectoryPort {
  constructor(private readonly pool: Pool) {}

  static async open(pool: Pool, bootstrap?: { adminUsername: string; adminDisplayName?: string; adminPassword: string; departmentName?: string }): Promise<PostgresTeamDirectory> {
    const directory = new PostgresTeamDirectory(pool);
    const count = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM workbench_users');
    if (Number(count.rows[0]?.count ?? 0) === 0) {
      if (!bootstrap) throw new Error('PostgreSQL team directory has no users; provide bootstrap administrator credentials');
      const department = await directory.createDepartment(bootstrap.departmentName ?? '管理部');
      await directory.createUser({
        username: bootstrap.adminUsername, displayName: bootstrap.adminDisplayName ?? '系统管理员', password: bootstrap.adminPassword,
        departmentId: department.id, role: 'admin',
      });
    }
    return directory;
  }

  async listDepartments(): Promise<readonly TeamDepartment[]> {
    const result = await this.pool.query('SELECT id, name, created_at FROM departments ORDER BY name');
    return result.rows.map(asDepartment);
  }

  async listUsers(): Promise<readonly TeamUser[]> {
    const result = await this.pool.query('SELECT id, username, display_name, department_id, role, status, created_at, updated_at FROM workbench_users ORDER BY username');
    return result.rows.map(asUser);
  }

  async getUser(id: string): Promise<TeamUser | null> {
    const result = await this.pool.query('SELECT id, username, display_name, department_id, role, status, created_at, updated_at FROM workbench_users WHERE id = $1', [id]);
    return result.rows[0] ? asUser(result.rows[0]) : null;
  }

  async createDepartment(name: string): Promise<TeamDepartment> {
    const normalized = normalizeName(name, 'department name');
    const id = randomUUID();
    const result = await this.pool.query('INSERT INTO departments (id, name) VALUES ($1, $2) RETURNING id, name, created_at', [id, normalized]);
    return asDepartment(result.rows[0]!);
  }

  async createUser(input: CreateTeamUserInput): Promise<TeamUser> {
    const username = validateUsername(input.username);
    const displayName = normalizeName(input.displayName, 'display name');
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO workbench_users (id, username, display_name, department_id, role, status, password_hash)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)
       RETURNING id, username, display_name, department_id, role, status, created_at, updated_at`,
      [id, username, displayName, input.departmentId, validateRole(input.role ?? 'member'), passwordHash],
    );
    return asUser(result.rows[0]!);
  }

  async updateUser(id: string, update: UpdateTeamUserInput): Promise<TeamUser> {
    const current = await this.pool.query<UserRow>('SELECT * FROM workbench_users WHERE id = $1', [id]);
    const row = current.rows[0];
    if (!row) throw new Error('user does not exist');
    const nextRole = update.role === undefined ? row.role : validateRole(update.role);
    const nextStatus = update.status === undefined ? row.status : validateStatus(update.status);
    if (row.role === 'admin' && row.status === 'active' && (nextRole !== 'admin' || nextStatus !== 'active')) {
      const admins = await this.pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM workbench_users WHERE role = 'admin' AND status = 'active'");
      if (Number(admins.rows[0]?.count ?? 0) <= 1) throw new Error('the last active administrator cannot be disabled or demoted');
    }
    const passwordHash = update.password === undefined ? row.password_hash : await hashPassword(update.password);
    const result = await this.pool.query(
      `UPDATE workbench_users
       SET display_name = COALESCE($2, display_name), department_id = COALESCE($3, department_id),
           role = $4, status = $5, password_hash = $6, updated_at = now()
       WHERE id = $1
       RETURNING id, username, display_name, department_id, role, status, created_at, updated_at`,
      [id, update.displayName === undefined ? null : normalizeName(update.displayName, 'display name'), update.departmentId ?? null, nextRole, nextStatus, passwordHash],
    );
    return asUser(result.rows[0]!);
  }

  async authenticate(usernameInput: string, password: string): Promise<TeamUser | null> {
    const result = await this.pool.query<UserRow>('SELECT * FROM workbench_users WHERE username = $1 AND status = \'active\'', [usernameInput.trim().toLowerCase()]);
    const row = result.rows[0];
    if (!row || !(await verifyPassword(password, row.password_hash))) return null;
    return asUser(row);
  }
}

export class PostgresManifestStore implements ManifestStore {
  constructor(private readonly pool: Pool) {}

  async read(): Promise<AgentWorkbenchConfig> {
    const result = await this.pool.query<{ manifest: unknown; enabled: boolean }>('SELECT manifest, enabled FROM agents ORDER BY id');
    const agents = result.rows.map((row) => ({ ...(row.manifest as AgentManifest), enabled: row.enabled }));
    return parseAgentWorkbenchConfig({ includeBuiltinAgents: false, agents });
  }

  async write(config: AgentWorkbenchConfig): Promise<void> {
    const checked = parseAgentWorkbenchConfig(config);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM agents');
      for (const agent of checked.agents) {
        await client.query(
          `INSERT INTO agents (id, manifest, enabled, version) VALUES ($1, $2::jsonb, $3, 1)`,
          [agent.id, JSON.stringify(agent), agent.enabled !== false],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function eventFromRow(row: QueryResultRow): AgentUsageEvent {
  return {
    agentId: rowString(row, 'agent_id'), kind: (row.kind === 'python' || row.kind === 'mcp' ? row.kind : 'http'),
    occurredAt: new Date(row.occurred_at as string).toISOString(), durationMs: Number(row.duration_ms),
    status: row.success ? 'success' : 'error', inputBytes: Number(row.input_bytes), outputBytes: Number(row.output_bytes),
    ...(row.input_tokens == null ? {} : { inputTokens: Number(row.input_tokens) }),
    ...(row.output_tokens == null ? {} : { outputTokens: Number(row.output_tokens) }),
    ...(row.user_id ? { userId: row.user_id as string } : {}), ...(row.department_id ? { departmentId: row.department_id as string } : {}),
    source: row.source === 'admin_test' ? 'admin_test' : 'user',
  };
}

export class PostgresUsageLedger implements UsageLedger {
  constructor(private readonly pool: Pool) {}

  async record(event: AgentUsageEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_events (id, occurred_at, user_id, department_id, agent_id, source, kind, success, duration_ms, input_bytes, output_bytes, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [randomUUID(), event.occurredAt, event.userId ?? null, event.departmentId ?? null, event.agentId, event.source ?? 'user', event.kind, event.status === 'success', event.durationMs, event.inputBytes, event.outputBytes, event.inputTokens ?? null, event.outputTokens ?? null],
    );
  }

  async listSince(occurredAfter: Date): Promise<readonly AgentUsageEvent[]> {
    const result = await this.pool.query('SELECT * FROM usage_events WHERE occurred_at >= $1 ORDER BY occurred_at', [occurredAfter.toISOString()]);
    return result.rows.map(eventFromRow);
  }

  async summarize(): Promise<readonly UsageSummary[]> {
    const ledger = new InMemoryUsageLedger();
    for (const event of await this.listSince(new Date(0))) ledger.record(event);
    return ledger.summarize();
  }
}

export class PostgresCaseMemory implements CaseMemoryRecorder {
  constructor(private readonly pool: Pool) {}

  async record(entry: AgentCaseMemoryEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO case_memory (id, agent_id, occurred_at, outcome, input_fingerprint, input_bytes, output_bytes, duration_ms, attempts, strategy, failure_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [entry.id, entry.agentId, entry.occurredAt, entry.outcome, entry.inputFingerprint, entry.inputBytes, entry.outputBytes, entry.durationMs, entry.attempts, entry.strategy, entry.failureCategory ?? null],
    );
  }
}

export async function createEnterpriseStorage(options: EnterpriseStorageOptions, bootstrap?: { adminUsername: string; adminDisplayName?: string; adminPassword: string; departmentName?: string }): Promise<EnterpriseStorage> {
  const pool = new Pool({ connectionString: options.databaseUrl, max: options.maxConnections ?? 10, ...(options.ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
  await pool.query('SELECT 1');
  return {
    pool,
    directory: await PostgresTeamDirectory.open(pool, bootstrap),
    manifests: new PostgresManifestStore(pool),
    usage: new PostgresUsageLedger(pool),
    caseMemory: new PostgresCaseMemory(pool),
  };
}
