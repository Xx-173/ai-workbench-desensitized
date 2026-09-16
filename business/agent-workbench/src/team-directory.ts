/**
 * Small, server-side team directory for the self-hosted workbench baseline.
 *
 * It deliberately persists only department metadata and salted password
 * hashes.  It has no prompt/content fields and never returns password hashes
 * to a caller.  The file implementation is suitable for a single Craft
 * server instance; the exported port makes replacing it with Postgres/SSO a
 * deployment concern rather than a UI rewrite.
 */

import { randomUUID, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/;
const PASSWORD_MIN_LENGTH = 10;

export type TeamRole = 'admin' | 'member';
export type AccountStatus = 'active' | 'disabled';

export interface TeamDepartment {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

interface StoredUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly departmentId: string;
  readonly role: TeamRole;
  readonly status: AccountStatus;
  readonly passwordHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TeamUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly departmentId: string;
  readonly role: TeamRole;
  readonly status: AccountStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DirectoryFile {
  readonly version: 1;
  readonly departments: readonly TeamDepartment[];
  readonly users: readonly StoredUser[];
}

export interface CreateTeamUserInput {
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
  readonly departmentId: string;
  readonly role?: TeamRole;
}

export interface UpdateTeamUserInput {
  readonly displayName?: string;
  readonly password?: string;
  readonly departmentId?: string;
  readonly role?: TeamRole;
  readonly status?: AccountStatus;
}

export interface TeamBootstrapInput {
  readonly adminUsername: string;
  readonly adminDisplayName?: string;
  readonly adminPassword: string;
  readonly departmentName?: string;
}

function publicUser(user: StoredUser): TeamUser {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

function normalizeName(value: string, label: string, min = 1, max = 80): string {
  const result = value.trim();
  if (result.length < min || result.length > max) throw new Error(`${label} must be ${min}..${max} characters`);
  return result;
}

function validateUsername(value: string): string {
  const username = value.trim();
  if (!USERNAME.test(username)) throw new Error('username must be 3..64 letters, numbers, dots, underscores or hyphens');
  return username.toLowerCase();
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

function parseFile(value: unknown): DirectoryFile {
  if (!value || typeof value !== 'object') throw new Error('Team directory file is invalid');
  const candidate = value as Partial<DirectoryFile>;
  if (candidate.version !== 1 || !Array.isArray(candidate.departments) || !Array.isArray(candidate.users)) {
    throw new Error('Team directory file is invalid');
  }
  return candidate as DirectoryFile;
}

export class TeamDirectory {
  private readonly path: string;
  private departments: TeamDepartment[];
  private users: StoredUser[];
  private writes: Promise<void> = Promise.resolve();

  private constructor(path: string, state: DirectoryFile) {
    this.path = path;
    this.departments = [...state.departments];
    this.users = [...state.users];
  }

  static async open(path: string, bootstrap?: TeamBootstrapInput): Promise<TeamDirectory> {
    let state: DirectoryFile;
    try {
      state = parseFile(JSON.parse(await readFile(path, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = { version: 1, departments: [], users: [] };
    }
    const directory = new TeamDirectory(path, state);
    if (directory.users.length === 0) {
      if (!bootstrap) throw new Error('Team directory has no users; provide bootstrap administrator credentials');
      await directory.bootstrap(bootstrap);
    }
    return directory;
  }

  listDepartments(): readonly TeamDepartment[] {
    return [...this.departments].sort((a, b) => a.name.localeCompare(b.name));
  }

  listUsers(): readonly TeamUser[] {
    return this.users.map(publicUser).sort((a, b) => a.username.localeCompare(b.username));
  }

  getUser(id: string): TeamUser | null {
    const user = this.users.find((item) => item.id === id);
    return user ? publicUser(user) : null;
  }

  async createDepartment(name: string): Promise<TeamDepartment> {
    const normalized = normalizeName(name, 'department name');
    if (this.departments.some((entry) => entry.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
      throw new Error('department name already exists');
    }
    const department = { id: randomUUID(), name: normalized, createdAt: new Date().toISOString() };
    this.departments.push(department);
    await this.persist();
    return department;
  }

  async createUser(input: CreateTeamUserInput): Promise<TeamUser> {
    const username = validateUsername(input.username);
    const displayName = normalizeName(input.displayName, 'display name');
    if (!this.departments.some((department) => department.id === input.departmentId)) throw new Error('department does not exist');
    if (this.users.some((user) => user.username === username)) throw new Error('username already exists');
    const now = new Date().toISOString();
    const user: StoredUser = {
      id: randomUUID(), username, displayName, departmentId: input.departmentId,
      role: validateRole(input.role ?? 'member'), status: 'active', passwordHash: await hashPassword(input.password),
      createdAt: now, updatedAt: now,
    };
    this.users.push(user);
    await this.persist();
    return publicUser(user);
  }

  async updateUser(id: string, update: UpdateTeamUserInput): Promise<TeamUser> {
    const index = this.users.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('user does not exist');
    const current = this.users[index]!;
    if (update.departmentId && !this.departments.some((department) => department.id === update.departmentId)) {
      throw new Error('department does not exist');
    }
    const next: StoredUser = {
      ...current,
      ...(update.displayName === undefined ? {} : { displayName: normalizeName(update.displayName, 'display name') }),
      ...(update.departmentId === undefined ? {} : { departmentId: update.departmentId }),
      ...(update.role === undefined ? {} : { role: validateRole(update.role) }),
      ...(update.status === undefined ? {} : { status: validateStatus(update.status) }),
      ...(update.password === undefined ? {} : { passwordHash: await hashPassword(update.password) }),
      updatedAt: new Date().toISOString(),
    };
    // Never let an administrator disable/demote the last active administrator.
    if (current.role === 'admin' && current.status === 'active'
      && (next.role !== 'admin' || next.status !== 'active')
      && this.users.filter((item) => item.role === 'admin' && item.status === 'active').length <= 1) {
      throw new Error('the last active administrator cannot be disabled or demoted');
    }
    this.users[index] = next;
    await this.persist();
    return publicUser(next);
  }

  async authenticate(usernameInput: string, password: string): Promise<TeamUser | null> {
    const username = usernameInput.trim().toLowerCase();
    const user = this.users.find((item) => item.username === username);
    if (!user || user.status !== 'active') return null;
    return await verifyPassword(password, user.passwordHash) ? publicUser(user) : null;
  }

  private async bootstrap(input: TeamBootstrapInput): Promise<void> {
    const department = await this.createDepartment(input.departmentName ?? '管理部');
    await this.createUser({
      username: input.adminUsername,
      displayName: input.adminDisplayName ?? '系统管理员',
      password: input.adminPassword,
      departmentId: department.id,
      role: 'admin',
    });
  }

  private async persist(): Promise<void> {
    const write = async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      const payload: DirectoryFile = { version: 1, departments: this.departments, users: this.users };
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
}
