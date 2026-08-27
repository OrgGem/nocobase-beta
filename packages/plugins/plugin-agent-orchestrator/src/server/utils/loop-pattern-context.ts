import type { Plugin } from '@nocobase/server';
import type { Database } from '@nocobase/database';
import { asObject } from './ctx-utils';

export function worktreeCapability(plugin: Plugin) {
  const pluginManager = plugin.app.pm as unknown as { get?: (name: string) => unknown };
  const gitManager = pluginManager.get?.('plugin-git-manager') as { loopWorktreeService?: unknown } | undefined;
  return {
    available: Boolean(gitManager?.loopWorktreeService),
    provider: gitManager?.loopWorktreeService ? 'plugin-git-manager' : undefined,
  };
}

/**
 * Build an employee harness resolution chain with layered fallback.
 *
 * Resolution order (first non-null wins):
 *   1. Employee-specific `skillSettings.orchestratorHarness` — direct override set by the
 *      employee's own configuration. This is the highest-priority layer.
 *   2. Role-based harness mapping — when the employee is bound to a loop pattern role via
 *      `orchestratorConfig`, its `harnessTag` settings can supply a fallback. This covers
 *      cases where the employee has no personal override but the pattern has expectations.
 *   3. `undefined` — signals to `LoopPatternService.compileRole()` that no employee layer is
 *      needed; the profile + pattern layers already govern the employee.
 *
 * Each layer's settings are returned individually so `compileHarness()` can stack them
 * independently with most-restrictive-wins semantics.
 */
export function employeeHarnessResolver(plugin: Plugin) {
  return async (username: string) => {
    const db: Database = plugin.db;

    // ── Layer 1: Employee-specific orchestratorHarness override ──
    try {
      const employee = await db.getRepository('aiEmployees')?.findOne({ filter: { username } });
      if (employee) {
        const skillSettings = asObject(employee.get?.('skillSettings'));
        const directOverride = skillSettings.orchestratorHarness;
        if (directOverride && typeof directOverride === 'object' && Object.keys(directOverride).length > 0) {
          return directOverride;
        }
      }
    } catch {
      // Employee lookup failed; continue to fallback layers.
    }

    // ── Layer 2: Role-based harness from orchestratorConfig ──
    // orchestratorConfig stores leader<->sub-agent bindings with harnessTag overrides.
    // When this username appears as a sub-agent and the config specifies a harnessTag,
    // resolve the tag's published harness settings as a fallback.
    try {
      const config = await db.getRepository('orchestratorConfig')?.findOne({
        filter: { subAgentUsername: username, enabled: true },
      });
      if (config) {
        const harnessTag = config.get?.('harnessTag') || (config as Record<string, unknown>).harnessTag;
        if (typeof harnessTag === 'string' && harnessTag.trim()) {
          const profile = await db.getRepository('agentHarnessProfiles')?.findOne({
            filter: { tag: harnessTag.trim(), enabled: true },
          });
          if (profile) {
            const currentVersionId = Number(profile.get?.('currentVersionId') || 0);
            if (currentVersionId > 0) {
              const version = await db.getRepository('agentHarnessProfileVersions')?.findOne({
                filter: { id: currentVersionId, status: 'published' },
              });
              if (version) {
                const settings = version.get?.('settings');
                if (settings && typeof settings === 'object' && Object.keys(settings).length > 0) {
                  return settings;
                }
              }
            }
          }
        }
      }
    } catch {
      // Config lookup failed; fall through to no override.
    }

    // ── Layer 3: No employee-level override — profile + pattern layers suffice ──
    return undefined;
  };
}
