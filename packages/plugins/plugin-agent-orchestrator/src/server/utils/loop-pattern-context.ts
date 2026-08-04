import type { Plugin } from '@nocobase/server';
import { asObject } from './ctx-utils';

export function worktreeCapability(plugin: Plugin) {
  const pluginManager = plugin.app.pm as unknown as { get?: (name: string) => unknown };
  const gitManager = pluginManager.get?.('plugin-git-manager') as { loopWorktreeService?: unknown } | undefined;
  return {
    available: Boolean(gitManager?.loopWorktreeService),
    provider: gitManager?.loopWorktreeService ? 'plugin-git-manager' : undefined,
  };
}

export function employeeHarnessResolver(plugin: Plugin) {
  return async (username: string) => {
    const employee = await plugin.db.getRepository('aiEmployees')?.findOne({ filter: { username } });
    if (!employee) return undefined;
    const skillSettings = asObject(employee.get?.('skillSettings'));
    return skillSettings.orchestratorHarness;
  };
}
