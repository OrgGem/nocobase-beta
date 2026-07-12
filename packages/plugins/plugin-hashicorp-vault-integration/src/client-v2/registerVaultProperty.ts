import type { FlowContext, PropertyMeta } from '@nocobase/flow-engine';

/**
 * Shared registration of the `$vault` property on a flow-engine context —
 * used by BOTH runtimes: v2 registers it on its own flow-engine context, v1
 * imports this helper (allowed v1 → v2 direction) and registers it on v1's
 * context. Framework-agnostic: no React, no `@nocobase/client` import.
 */

type VaultApiClient = {
  request(options: { url: string; skipNotify?: boolean }): Promise<unknown>;
};

type Translate = (key: string) => unknown;

const VAULT_ROOT = '$vault';

export async function fetchExposedKeys(apiClient: VaultApiClient): Promise<string[]> {
  try {
    const response = await apiClient.request({ url: 'vault:listKeys', skipNotify: true });
    const list = (response as { data?: { data?: unknown } })?.data?.data;
    if (!Array.isArray(list)) return [];
    return (list as { variableKey?: string }[]).map((item) => item.variableKey).filter((key): key is string => !!key);
  } catch {
    return [];
  }
}

async function fetchValues(apiClient: VaultApiClient): Promise<Record<string, string>> {
  try {
    const response = await apiClient.request({ url: 'vault:resolve', skipNotify: true });
    const values = (response as { data?: { data?: { values?: unknown } } })?.data?.data?.values;
    return values && typeof values === 'object' ? (values as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function registerVaultProperty(context: FlowContext, apiClient: VaultApiClient, t: Translate): void {
  context.defineProperty(VAULT_ROOT, {
    get: async () => fetchValues(apiClient),
    meta: {
      type: 'object',
      title: String(t('Vault secrets')),
      properties: async (): Promise<Record<string, PropertyMeta>> => {
        const keys = await fetchExposedKeys(apiClient);
        return Object.fromEntries(keys.map((key) => [key, { type: 'string', title: key }]));
      },
    },
  });
}
