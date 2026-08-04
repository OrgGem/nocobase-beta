import type { Database, Model } from '@nocobase/database';
import { compileHarness } from './HarnessCompiler';
import type { CompiledHarness, HarnessLayer } from './HarnessCompiler';
import { HarnessProfileService } from './HarnessProfileService';
import { parseLoopPattern } from './LoopPatternSchema';
import type { LoopPattern } from './LoopPatternSchema';

export type WorktreeCapability = {
  available: boolean;
  provider?: string;
};

export type EmployeeHarnessResolver = (username: string) => Promise<unknown>;

export type HarnessSnapshot = {
  tag: string;
  versionId: number;
  version: number;
  schemaVersion: number;
  effective: CompiledHarness;
};

export type CompiledPatternSnapshot = {
  pattern: LoopPattern;
  roleBindings: {
    leader: string;
    makers: string[];
    verifier: string;
  };
  leaderHarness: HarnessSnapshot;
  makerHarnesses: Record<string, HarnessSnapshot>;
  verifierHarness: HarnessSnapshot;
  policy: LoopPattern['policy'];
};

const platformHarness = {
  tools: {},
  memory: { maxChars: 20_000 },
  delegation: { maxDepth: 8, maxCount: 100 },
  limits: { timeoutMs: 3_600_000, recursionLimit: 100, maxTotalTokens: 1_000_000, maxCost: 1000 },
  isolation: { networkAccess: 'allow' },
  observability: { tracingRetentionDays: 3650 },
};

function read(record: Model | Record<string, unknown>, key: string) {
  const model = record as Model & { get?: (name: string) => unknown };
  return typeof model.get === 'function' ? model.get(key) : (record as Record<string, unknown>)[key];
}

function toPlain(record: Model | Record<string, unknown>) {
  return typeof (record as Model).toJSON === 'function'
    ? ((record as Model).toJSON() as Record<string, unknown>)
    : (record as Record<string, unknown>);
}

export class LoopPatternService {
  private readonly harnessProfiles: HarnessProfileService;

  constructor(
    private readonly database: Database,
    private readonly resolveEmployeeHarness: EmployeeHarnessResolver,
    private readonly worktreeCapability: () => Promise<WorktreeCapability>,
  ) {
    this.harnessProfiles = new HarnessProfileService(database);
  }

  async get(patternId: number) {
    const record = await this.database.getRepository('agentLoopPatterns').findOne({ filterByTk: patternId });
    if (!record) throw new Error(`Loop pattern ${patternId} was not found.`);
    return { id: Number(read(record, 'id')), pattern: parseLoopPattern(toPlain(record)) };
  }

  async validate(value: unknown) {
    const pattern = parseLoopPattern(value);
    await this.assertCapabilities(pattern);
    return pattern;
  }

  async compile(patternId: number, perRunHarness?: unknown): Promise<CompiledPatternSnapshot> {
    const { pattern } = await this.get(patternId);
    if (!pattern.enabled) throw new Error(`Loop pattern ${pattern.key} is disabled.`);
    await this.assertCapabilities(pattern);

    const makerUsernames = pattern.makerUsernames.length ? pattern.makerUsernames : [pattern.leaderUsername];
    const [leaderHarness, verifierHarness, ...makerSnapshots] = await Promise.all([
      this.compileRole(pattern.leaderHarnessTag, pattern.leaderUsername, pattern.policy.harness, perRunHarness),
      this.compileRole(pattern.verifierHarnessTag, pattern.verifierUsername, pattern.policy.harness, perRunHarness),
      // Every maker gets its own snapshot: employee-level harness overrides differ per username,
      // so reusing the first maker's compilation would grant or deny the wrong tools.
      ...makerUsernames.map((username) =>
        this.compileRole(pattern.makerHarnessTag, username, pattern.policy.harness, perRunHarness),
      ),
    ]);
    const makerHarnesses = Object.fromEntries(
      makerUsernames.map((username, index) => [username, makerSnapshots[index]]),
    );

    return {
      pattern,
      roleBindings: {
        leader: pattern.leaderUsername,
        // The effective list, not the raw pattern array. A pattern with no makers falls back to the
        // leader (line above), and `makerHarnesses` is keyed by that same list; returning the raw
        // empty array here would make the worker iterate zero makers while the harness map holds one,
        // so the execution phase would silently never run.
        makers: [...makerUsernames],
        verifier: pattern.verifierUsername,
      },
      leaderHarness,
      makerHarnesses,
      verifierHarness,
      policy: structuredClone(pattern.policy),
    };
  }

  private async compileRole(tag: string, username: string, patternHarness: unknown, perRunHarness?: unknown) {
    const published = await this.harnessProfiles.getPublishedByTag(tag);
    if (!published) throw new Error(`Harness profile "${tag}" has no published version.`);
    const employeeHarness = await this.resolveEmployeeHarness(username);
    const layers: HarnessLayer[] = [
      { source: 'platform', settings: platformHarness },
      { source: `profile:${tag}@${published.version}`, settings: published.settings },
      { source: 'pattern', settings: patternHarness },
    ];
    if (employeeHarness) layers.push({ source: `employee:${username}`, settings: employeeHarness });
    if (perRunHarness) layers.push({ source: 'run', settings: perRunHarness });
    return {
      tag,
      versionId: published.id,
      version: published.version,
      schemaVersion: published.schemaVersion,
      effective: compileHarness(layers),
    };
  }

  private async assertCapabilities(pattern: LoopPattern) {
    if (pattern.autonomyLevel === 'L1') return;
    const capability = await this.worktreeCapability();
    if (!capability.available) {
      throw new Error('L2 and L3 patterns require an available worktree provider.');
    }
  }
}
