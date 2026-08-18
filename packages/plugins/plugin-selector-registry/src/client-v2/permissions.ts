import { createContext, useContext } from 'react';
import { useAclSnippets } from '@nocobase/client-v2';

/**
 * ACL snippets registered by the server plugin.
 *
 * The server treats `manage` as the superset of `read` (and of the bot-facing
 * `client` capability). The client therefore checks `manage` as a fallback for
 * each capability, because ACL role responses contain snippet grants, not the
 * server snippet action expansion.
 */
export const SELECTOR_REGISTRY_SNIPPETS = {
  client: 'pm.selector-registry.client',
  read: 'pm.selector-registry.read',
  manage: 'pm.selector-registry.manage',
} as const;

export type SelectorRegistryCapability = keyof typeof SELECTOR_REGISTRY_SNIPPETS;

export type AclSnippetAllow = (snippet?: string) => boolean;

export interface SelectorRegistryPermissions {
  canRead: boolean;
  canManage: boolean;
}

export const SelectorRegistryPermissionOverrideContext = createContext<SelectorRegistryPermissions | null>(null);

/**
 * Resolve one registry capability from the current role's ACL snippets.
 */
export function canUseSelectorRegistryCapability(
  allow: AclSnippetAllow,
  capability: SelectorRegistryCapability,
): boolean {
  if (capability === 'manage') {
    return allow(SELECTOR_REGISTRY_SNIPPETS.manage) || allow('pm.*') || allow('pm');
  }

  return (
    allow(SELECTOR_REGISTRY_SNIPPETS[capability]) ||
    allow(SELECTOR_REGISTRY_SNIPPETS.manage) ||
    allow('pm.*') ||
    allow('pm')
  );
}

export function resolveSelectorRegistryPermissions(allow: AclSnippetAllow): SelectorRegistryPermissions {
  return {
    canRead: canUseSelectorRegistryCapability(allow, 'read'),
    canManage: canUseSelectorRegistryCapability(allow, 'manage'),
  };
}

export function useSelectorRegistryPermissions(): SelectorRegistryPermissions {
  const { allow } = useAclSnippets();
  const override = useContext(SelectorRegistryPermissionOverrideContext);

  return override ?? resolveSelectorRegistryPermissions(allow);
}
