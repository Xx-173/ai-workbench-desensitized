/**
 * Persistent, local-only Control Center state.
 *
 * The store keeps manifests (which contain references, not secret values),
 * while EncryptedFileSecretVault manages the corresponding values separately.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { collectCredentialReferenceNames, parseAgentWorkbenchConfig, type AgentManifest, type AgentWorkbenchConfig } from './agent-manifest.ts';
import { type UsageLedger, type UsageSummary } from './usage-ledger.ts';
import type { EncryptedFileSecretVault, SecretStatus } from './secret-vault.ts';

export interface AgentHealth {
  readonly agentId: string;
  readonly status: 'configured' | 'missing_configuration';
  readonly requiredReferences: readonly string[];
  readonly missingReferences: readonly string[];
  /** This is deliberately a configuration check, never an implicit vendor call. */
  readonly checkedAt: string;
}

export interface AgentUsageDashboardRow extends UsageSummary {
  readonly estimatedCost: number | null;
  readonly currency: string | null;
}

export interface ControlDashboard {
  readonly agents: number;
  readonly configuredSecrets: number;
  readonly usage: readonly AgentUsageDashboardRow[];
}

export class FileManifestStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<AgentWorkbenchConfig> {
    try {
      return parseAgentWorkbenchConfig(JSON.parse(await readFile(this.path, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { includeBuiltinAgents: false, agents: [] };
      throw error;
    }
  }

  async write(config: AgentWorkbenchConfig): Promise<void> {
    const checked = parseAgentWorkbenchConfig(config);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(checked, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.path);
  }
}

export interface ManifestStore {
  read(): Promise<AgentWorkbenchConfig>;
  write(config: AgentWorkbenchConfig): Promise<void>;
}

function costFor(summary: UsageSummary, manifest: AgentManifest | undefined): { estimatedCost: number | null; currency: string | null } {
  const cost = manifest?.policy?.cost;
  if (!cost || (cost.inputPerMillion === undefined && cost.outputPerMillion === undefined)) {
    return { estimatedCost: null, currency: null };
  }
  const estimatedCost = (summary.inputTokens / 1_000_000) * (cost.inputPerMillion ?? 0)
    + (summary.outputTokens / 1_000_000) * (cost.outputPerMillion ?? 0);
  return { estimatedCost, currency: cost.currency ?? 'USD' };
}

export class AgentControlPlane {
  private readonly manifests: ManifestStore;
  private readonly vault: EncryptedFileSecretVault;
  private readonly usage: UsageLedger;

  constructor(
    manifests: ManifestStore,
    vault: EncryptedFileSecretVault,
    usage: UsageLedger,
  ) {
    this.manifests = manifests;
    this.vault = vault;
    this.usage = usage;
  }

  async getConfig(): Promise<AgentWorkbenchConfig> {
    return this.manifests.read();
  }

  async replaceConfig(config: unknown): Promise<AgentWorkbenchConfig> {
    const checked = parseAgentWorkbenchConfig(config);
    await this.manifests.write(checked);
    return checked;
  }

  async listSecrets(): Promise<readonly SecretStatus[]> {
    return this.vault.list();
  }

  async setSecret(name: string, value: string): Promise<void> {
    await this.vault.set(name, value);
  }

  async deleteSecret(name: string): Promise<void> {
    await this.vault.delete(name);
  }

  async checkAgent(agentId: string): Promise<AgentHealth> {
    const config = await this.manifests.read();
    const agent = config.agents.find((entry) => entry.id === agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const requiredReferences = collectCredentialReferenceNames([agent]);
    const missingReferences = requiredReferences.filter((name) => !this.vault.has(name));
    return {
      agentId,
      status: missingReferences.length ? 'missing_configuration' : 'configured',
      requiredReferences,
      missingReferences,
      checkedAt: new Date().toISOString(),
    };
  }

  async dashboard(): Promise<ControlDashboard> {
    const config = await this.manifests.read();
    const byId = new Map(config.agents.map((agent) => [agent.id, agent]));
    const usage = (await this.usage.summarize()).map((summary) => ({ ...summary, ...costFor(summary, byId.get(summary.agentId)) }));
    return { agents: config.agents.length, configuredSecrets: this.vault.list().length, usage };
  }
}
