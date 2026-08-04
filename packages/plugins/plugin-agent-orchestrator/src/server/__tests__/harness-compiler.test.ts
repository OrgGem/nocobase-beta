import { describe, expect, it } from 'vitest';
import { compileHarness, decideTool } from '../services/HarnessCompiler';
import { parseHarnessSettings, validateHarnessSettings } from '../services/HarnessSchema';

describe('HarnessSchema', () => {
  it('normalizes existing flat profile settings', () => {
    const settings = parseHarnessSettings({
      nativeObserverEnabled: true,
      memoryInjectionEnabled: true,
      memoryScopes: ['public', 'user'],
      maxMemoryContextChars: 4000,
      tracingRetentionDays: 14,
    });

    expect(settings.memory).toEqual({
      enabled: true,
      scopes: ['public', 'user'],
      maxChars: 4000,
    });
    expect(settings.observability.enabled).toBe(true);
    expect(settings.observability.tracingRetentionDays).toBe(14);
  });

  it('rejects invalid limits and unknown typed settings', () => {
    expect(validateHarnessSettings({ limits: { recursionLimit: 0 } }).success).toBe(false);
    expect(validateHarnessSettings({ unsupported: true }).success).toBe(false);
  });
});

describe('HarnessCompiler', () => {
  it('applies most-restrictive-wins across every policy layer', () => {
    const compiled = compileHarness([
      {
        source: 'platform',
        settings: {
          tools: {
            allow: ['read_file', 'write_file', 'http'],
            ask: [],
            deny: ['shell'],
            effects: { read_file: 'read', write_file: 'write', http: 'external' },
            trustedPreHandlerTools: ['write_file', 'http'],
          },
          memory: { scopes: ['public', 'user', 'agent_user'], maxChars: 8000 },
          delegation: { allowedEmployees: ['maker-a', 'maker-b'], maxDepth: 3, maxCount: 8 },
          limits: { timeoutMs: 60_000, recursionLimit: 30, maxTotalTokens: 20_000, maxCost: 5 },
          isolation: {
            mode: 'none',
            requireWorktree: false,
            allowedConnectors: ['github', 'jira'],
            networkAccess: 'allow',
          },
          observability: { tracingRetentionDays: 30 },
        },
      },
      {
        source: 'pattern',
        settings: {
          tools: {
            allow: ['read_file', 'write_file'],
            ask: ['write_file'],
            deny: ['http'],
            effects: { write_file: 'write' },
            trustedPreHandlerTools: ['write_file'],
          },
          memory: { scopes: ['public', 'user'], maxChars: 6000 },
          delegation: { allowedEmployees: ['maker-b'], maxDepth: 2, maxCount: 4 },
          limits: { timeoutMs: 45_000, recursionLimit: 20, maxTotalTokens: 12_000, maxCost: 3 },
          isolation: {
            mode: 'worktree',
            requireWorktree: true,
            allowedConnectors: ['github'],
            networkAccess: 'restricted',
          },
          observability: { tracingRetentionDays: 14 },
        },
      },
      {
        source: 'run',
        settings: {
          tools: { deny: ['write_file'] },
          memory: { scopes: ['public'], maxChars: 3000 },
          delegation: { maxCount: 2 },
          limits: { timeoutMs: 30_000, maxTotalTokens: 8000 },
          isolation: { networkAccess: 'deny' },
          observability: { tracingRetentionDays: 7 },
        },
      },
    ]);

    expect(compiled.sources).toEqual(['platform', 'pattern', 'run']);
    expect(compiled.tools.allow).toEqual(['read_file', 'write_file']);
    expect(compiled.tools.deny).toEqual(['http', 'shell', 'write_file']);
    expect(compiled.memory.scopes).toEqual(['public']);
    expect(compiled.memory.maxChars).toBe(3000);
    expect(compiled.delegation.allowedEmployees).toEqual(['maker-b']);
    expect(compiled.delegation.maxDepth).toBe(2);
    expect(compiled.delegation.maxCount).toBe(2);
    expect(compiled.limits.timeoutMs).toBe(30_000);
    expect(compiled.limits.maxTotalTokens).toBe(8000);
    expect(compiled.isolation).toMatchObject({
      mode: 'worktree',
      requireWorktree: true,
      allowedConnectors: ['github'],
      networkAccess: 'deny',
    });
    expect(compiled.observability.tracingRetentionDays).toBe(7);
    expect(decideTool(compiled, 'write_file', 'write')).toBe('deny');
    expect(decideTool(compiled, 'http', 'external')).toBe('deny');
    expect(decideTool(compiled, 'read_file', 'read')).toBe('allow');
  });

  it('forces unknown and untrusted mutating tools to ask', () => {
    const compiled = compileHarness([
      {
        source: 'profile',
        settings: {
          tools: {
            allow: ['read_file', 'write_file', 'trusted_write'],
            effects: { read_file: 'read', write_file: 'write', trusted_write: 'write' },
            trustedPreHandlerTools: ['trusted_write'],
          },
        },
      },
    ]);

    expect(decideTool(compiled, 'read_file')).toBe('allow');
    expect(decideTool(compiled, 'write_file')).toBe('ask');
    expect(decideTool(compiled, 'trusted_write')).toBe('allow');
    expect(decideTool(compiled, 'unknown_tool')).toBe('ask');
  });
});
