import { createContext, useContext } from 'react';
import { useAclSnippets } from '@nocobase/client-v2';

/**
 * ACL snippets registered by the server plugin.
 *
 * The server treats `manage` as the superset of the other protected
 * capabilities.  The client therefore checks it as a fallback for each
 * capability, while still keeping `read` and `sync` separate: the server
 * does not grant read/list actions to a sync-only role.
 */
export const SKILL_REGISTRY_SNIPPETS = {
  read: 'pm.skill-registry.read',
  sync: 'pm.skill-registry.sync',
  publish: 'pm.skill-registry.publish',
  install: 'pm.skill-registry.install',
  manage: 'pm.skill-registry.manage',
} as const;

export type SkillRegistryCapability = keyof typeof SKILL_REGISTRY_SNIPPETS;

export type AclSnippetAllow = (snippet?: string) => boolean;

export interface SkillRegistryPermissions {
  canRead: boolean;
  canSync: boolean;
  canPublish: boolean;
  canInstall: boolean;
  canManage: boolean;
}

export const SkillRegistryPermissionOverrideContext = createContext<SkillRegistryPermissions | null>(null);

/**
 * Resolve one registry capability from the current role's ACL snippets.
 * `manage` is deliberately an explicit superset fallback because ACL role
 * responses contain snippet grants, not the server snippet action expansion.
 */
export function canUseSkillRegistryCapability(allow: AclSnippetAllow, capability: SkillRegistryCapability): boolean {
  if (capability === 'manage') {
    return allow(SKILL_REGISTRY_SNIPPETS.manage) || allow('pm.*') || allow('pm');
  }

  return (
    allow(SKILL_REGISTRY_SNIPPETS[capability]) || allow(SKILL_REGISTRY_SNIPPETS.manage) || allow('pm.*') || allow('pm')
  );
}

export function resolveSkillRegistryPermissions(allow: AclSnippetAllow): SkillRegistryPermissions {
  return {
    canRead: canUseSkillRegistryCapability(allow, 'read'),
    canSync: canUseSkillRegistryCapability(allow, 'sync'),
    canPublish: canUseSkillRegistryCapability(allow, 'publish'),
    canInstall: canUseSkillRegistryCapability(allow, 'install'),
    canManage: canUseSkillRegistryCapability(allow, 'manage'),
  };
}

export function useSkillRegistryPermissions(): SkillRegistryPermissions {
  const { allow } = useAclSnippets();
  const override = useContext(SkillRegistryPermissionOverrideContext);

  return override ?? resolveSkillRegistryPermissions(allow);
}
