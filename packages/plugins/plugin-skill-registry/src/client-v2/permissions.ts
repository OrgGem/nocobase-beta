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
  read: 'pm.plugin-skill-registry.read',
  sync: 'pm.plugin-skill-registry.sync',
  publish: 'pm.plugin-skill-registry.publish',
  install: 'pm.plugin-skill-registry.install',
  manage: 'pm.plugin-skill-registry.manage',
} as const;

export type SkillRegistryCapability = keyof typeof SKILL_REGISTRY_SNIPPETS;

export type AclSnippetAllow = (snippet?: string) => boolean;

/**
 * Resolve one registry capability from the current role's ACL snippets.
 * `manage` is deliberately an explicit superset fallback because ACL role
 * responses contain snippet grants, not the server snippet action expansion.
 */
export function canUseSkillRegistryCapability(allow: AclSnippetAllow, capability: SkillRegistryCapability): boolean {
  if (capability === 'manage') {
    return allow(SKILL_REGISTRY_SNIPPETS.manage);
  }

  return allow(SKILL_REGISTRY_SNIPPETS[capability]) || allow(SKILL_REGISTRY_SNIPPETS.manage);
}

export function useSkillRegistryPermissions() {
  const { allow } = useAclSnippets();

  return {
    canRead: canUseSkillRegistryCapability(allow, 'read'),
    canSync: canUseSkillRegistryCapability(allow, 'sync'),
    canPublish: canUseSkillRegistryCapability(allow, 'publish'),
    canInstall: canUseSkillRegistryCapability(allow, 'install'),
    canManage: canUseSkillRegistryCapability(allow, 'manage'),
  };
}
