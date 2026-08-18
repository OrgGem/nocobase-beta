import { describe, expect, it } from 'vitest';
import type { Database } from '@nocobase/database';
import { compileHarness } from '../services/HarnessCompiler';
import type { CompiledHarness } from '../services/HarnessCompiler';
import {
  REDACTED_PLACEHOLDER,
  harnessTimeoutMs,
  redactSecretsIn,
  resolveRunRoleHarness,
  resolveTraceHarness,
  spilledText,
} from '../services/harness-runtime-policy';

function resolved(harness: CompiledHarness | null): CompiledHarness {
  if (!harness) throw new Error('expected resolveTraceHarness to return a harness');
  return harness;
}

describe('redactSecretsIn', () => {
  it('replaces values whose keys look secret-bearing, recursively', () => {
    const input = {
      apiKey: 'abc123',
      db_password: 'hunter2',
      accessToken: 'tok-1',
      session_passwd: 'pw',
      clientCredential: 'cred',
      nested: { clientSecret: 'shh', keep: 'visible' },
      list: [{ sessionToken: 'xyz', ok: 1 }],
      plain: 'free text mentioning TOKEN stays untouched',
    };

    const out = redactSecretsIn(input);

    expect(out.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(out.db_password).toBe(REDACTED_PLACEHOLDER);
    expect(out.accessToken).toBe(REDACTED_PLACEHOLDER);
    expect(out.session_passwd).toBe(REDACTED_PLACEHOLDER);
    expect(out.clientCredential).toBe(REDACTED_PLACEHOLDER);
    expect(out.nested.clientSecret).toBe(REDACTED_PLACEHOLDER);
    expect(out.nested.keep).toBe('visible');
    expect(out.list[0].sessionToken).toBe(REDACTED_PLACEHOLDER);
    expect(out.list[0].ok).toBe(1);
    expect(out.plain).toBe(input.plain);
  });

  it('leaves non-object values untouched', () => {
    expect(redactSecretsIn('text')).toBe('text');
    expect(redactSecretsIn(42)).toBe(42);
    expect(redactSecretsIn(null)).toBeNull();
  });
});

describe('spilledText', () => {
  it('returns null when the text fits the inline budget', () => {
    expect(spilledText('small output', 1000, 'loc')).toBeNull();
  });

  it('replaces oversized output with a bounded head/tail preview plus locator', () => {
    const head = 'HEAD-MARKER ';
    const tail = ' TAIL-MARKER';
    const text = head + 'x'.repeat(20_000) + tail;
    const budget = 1200;

    const replaced = spilledText(text, budget, '/api/skillHub:download?execId=1&f=abc');
    if (replaced === null) throw new Error('expected spilledText to replace oversized output');

    expect(Buffer.byteLength(replaced, 'utf8')).toBeLessThanOrEqual(budget);
    expect(replaced).toContain('HEAD-MARKER');
    expect(replaced).toContain('TAIL-MARKER');
    expect(replaced).toContain('/api/skillHub:download?execId=1&f=abc');
    expect(replaced).toContain('bytes omitted');
  });

  it('never splits a multi-byte character at the cut point', () => {
    const text = '😀'.repeat(2000); // 4 bytes each
    const budget = 600;

    const replaced = spilledText(text, budget, 'loc');
    if (replaced === null) throw new Error('expected spilledText to replace oversized output');

    expect(Buffer.byteLength(replaced, 'utf8')).toBeLessThanOrEqual(budget);
    expect(replaced).not.toContain('�');
  });
});

describe('harnessTimeoutMs', () => {
  it('prefers the per-tool timeout and falls back to the generic skill timeout', () => {
    const harness = compileHarness([
      {
        source: 'test',
        settings: { tools: { timeouts: { skill_hub_report: 5000, skill_hub_execute: 90_000 } } },
      },
    ]);

    expect(harnessTimeoutMs(harness, 'skill_hub_report')).toBe(5000);
    expect(harnessTimeoutMs(harness, 'skill_hub_anything_else')).toBe(90_000);
  });

  it('returns null when no timeout applies', () => {
    const harness = compileHarness([{ source: 'test', settings: {} }]);
    expect(harnessTimeoutMs(harness, 'skill_hub_report')).toBeNull();
  });
});

type MockDbOptions = {
  runs?: Record<number, Record<string, unknown>>;
  employees?: Record<string, Record<string, unknown>>;
  profilesByTag?: Record<string, { currentVersionId: number }>;
  versionsById?: Record<number, Record<string, unknown>>;
};

function mockDatabase(options: MockDbOptions): Database {
  return {
    getRepository(name: string) {
      if (name === 'agentLoopRuns') {
        return {
          findOne: async (opts: { filterByTk?: number }) => options.runs?.[Number(opts.filterByTk)] ?? null,
        };
      }
      if (name === 'aiEmployees') {
        return {
          findOne: async (opts: { filter?: { username?: string } }) =>
            options.employees?.[String(opts.filter?.username)] ?? null,
        };
      }
      if (name === 'agentHarnessProfiles') {
        return {
          findOne: async (opts: { filter?: { tag?: string; enabled?: boolean } }) => {
            const profile = options.profilesByTag?.[String(opts.filter?.tag)];
            return profile ?? null;
          },
        };
      }
      if (name === 'agentHarnessProfileVersions') {
        return {
          findOne: async (opts: { filter?: { id?: number; status?: string } }) => {
            const version = options.versionsById?.[Number(opts.filter?.id)];
            if (!version || opts.filter?.status !== version.status) return null;
            return version;
          },
        };
      }
      return { findOne: async () => null };
    },
  } as unknown as Database;
}

const compiledEffective = (settings: Record<string, unknown>) => compileHarness([{ source: 'test', settings }]);

describe('resolveTraceHarness', () => {
  it('resolves the run snapshot for the leader role', async () => {
    const database = mockDatabase({
      runs: {
        7: {
          roleBindingsSnapshot: { leader: 'leader-ai', verifier: 'verifier-ai' },
          leaderHarnessSnapshot: {
            effective: compiledEffective({ tools: { timeouts: { skill_hub_execute: 45_000 } } }),
          },
        },
      },
    });

    const harness = resolved(await resolveTraceHarness(database, { agentLoopRunId: 7, employeeUsername: 'leader-ai' }));

    expect(harness.tools.timeouts).toEqual({ skill_hub_execute: 45_000 });
  });

  it('resolves the per-maker snapshot from the makers map', async () => {
    const database = mockDatabase({
      runs: {
        8: {
          roleBindingsSnapshot: { leader: 'leader-ai' },
          makerHarnessSnapshot: {
            'maker-ai': {
              effective: compiledEffective({ context: { spill: { maxInlineBytes: 12_000 } } }),
            },
          },
        },
      },
    });

    const harness = resolved(await resolveTraceHarness(database, { agentLoopRunId: 8, employeeUsername: 'maker-ai' }));

    expect(harness.context.spill.maxInlineBytes).toBe(12_000);
  });

  it('backfills new policy fields with defaults for snapshots compiled by older revisions', async () => {
    // What the previous compiler revision persisted: no context section, no timeouts,
    // no redactSecrets/sharing keys.
    const legacyEffective = {
      sources: ['legacy'],
      tools: { allow: [], ask: [], deny: [], effects: {}, trustedPreHandlerTools: [] },
      memory: { enabled: true, scopes: ['public'], maxChars: 6000 },
      delegation: { allowedEmployees: [], maxDepth: null, maxCount: null },
      limits: {
        timeoutMs: null,
        recursionLimit: null,
        maxInvocations: null,
        maxToolCalls: null,
        maxInputTokens: null,
        maxOutputTokens: null,
        maxTotalTokens: null,
        maxCost: null,
      },
      isolation: { mode: 'none', requireWorktree: false, allowedConnectors: [], networkAccess: 'restricted' },
      observability: { enabled: true, tracingRetentionDays: 30, captureInputs: true, captureOutputs: true },
    };

    const database = mockDatabase({
      runs: {
        9: {
          roleBindingsSnapshot: { leader: 'leader-ai' },
          leaderHarnessSnapshot: { effective: legacyEffective },
        },
      },
    });

    const harness = resolved(await resolveTraceHarness(database, { agentLoopRunId: 9, employeeUsername: 'leader-ai' }));

    expect(harness.tools.timeouts).toEqual({});
    expect(harness.context.spill.maxInlineBytes).toBeNull();
    expect(harness.observability.redactSecrets).toBe(true);
    expect(harness.observability.sharing).toBe('full');
  });

  it('falls back to the employee harness-tag profile outside a loop run', async () => {
    const database = mockDatabase({
      employees: { 'solo-ai': { username: 'solo-ai', skillSettings: { harnessTag: 'strict' } } },
      profilesByTag: { strict: { currentVersionId: 11 } },
      versionsById: {
        11: {
          id: 11,
          profileId: 1,
          version: 2,
          schemaVersion: 1,
          status: 'published',
          settings: { tools: { timeouts: { skill_hub_execute: 20_000 } } },
        },
      },
    });

    const harness = resolved(await resolveTraceHarness(database, { employeeUsername: 'solo-ai' }));

    expect(harness.tools.timeouts).toEqual({ skill_hub_execute: 20_000 });
  });

  it('returns null when no run snapshot matches and no employee profile applies', async () => {
    const database = mockDatabase({});

    expect(await resolveTraceHarness(database, { employeeUsername: 'ghost' })).toBeNull();
    expect(await resolveTraceHarness(database, {})).toBeNull();
  });
});

describe('resolveRunRoleHarness', () => {
  it('returns the compiled role snapshot for a known run and role', async () => {
    const database = mockDatabase({
      runs: {
        7: {
          roleBindingsSnapshot: { leader: 'leader-ai', makers: ['maker-ai'], verifier: 'verifier-ai' },
          leaderHarnessSnapshot: {
            effective: compiledEffective({ delegation: { maxDepth: 3 } }),
          },
          makerHarnessSnapshot: {
            'maker-ai': { effective: compiledEffective({ delegation: { maxDepth: 2 } }) },
          },
        },
      },
    });

    const leader = resolved(await resolveRunRoleHarness(database, 7, 'leader-ai'));
    expect(leader.delegation.maxDepth).toBe(3);

    const maker = resolved(await resolveRunRoleHarness(database, 7, 'maker-ai'));
    expect(maker.delegation.maxDepth).toBe(2);
  });

  it('returns null for unknown runs, unbound roles, or missing usernames', async () => {
    const database = mockDatabase({
      runs: {
        7: {
          roleBindingsSnapshot: { leader: 'leader-ai' },
          leaderHarnessSnapshot: { effective: compiledEffective({}) },
        },
      },
    });

    expect(await resolveRunRoleHarness(database, 999, 'leader-ai')).toBeNull();
    expect(await resolveRunRoleHarness(database, 7, 'unbound-ai')).toBeNull();
    expect(await resolveRunRoleHarness(database, 7, undefined)).toBeNull();
    expect(await resolveRunRoleHarness(database, 0, 'leader-ai')).toBeNull();
  });
});
