/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createContext, useContext } from 'react';
import { createAclSnippetAllow, useACLRoleContext } from '@nocobase/client-v2';

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
  markdown: 'pm.plugin-skill-registry.markdown',
  manage: 'pm.plugin-skill-registry.manage',
} as const;

export type SkillRegistryCapability = keyof typeof SKILL_REGISTRY_SNIPPETS;

export type AclSnippetAllow = (snippet?: string) => boolean;

export interface SkillRegistryPermissions {
  canRead: boolean;
  canSync: boolean;
  canPublish: boolean;
  canInstall: boolean;
  canMarkdown: boolean;
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
    return allow(SKILL_REGISTRY_SNIPPETS.manage);
  }

  return allow(SKILL_REGISTRY_SNIPPETS[capability]) || allow(SKILL_REGISTRY_SNIPPETS.manage);
}

export function resolveSkillRegistryPermissions(allow: AclSnippetAllow): SkillRegistryPermissions {
  return {
    canRead: canUseSkillRegistryCapability(allow, 'read'),
    canSync: canUseSkillRegistryCapability(allow, 'sync'),
    canPublish: canUseSkillRegistryCapability(allow, 'publish'),
    canInstall: canUseSkillRegistryCapability(allow, 'install'),
    canMarkdown: canUseSkillRegistryCapability(allow, 'markdown'),
    canManage: canUseSkillRegistryCapability(allow, 'manage'),
  };
}

export function permissionsForRole({ snippets = [], allowAll = false }: { snippets?: string[]; allowAll?: boolean }) {
  // Core ACL subtracts rejected snippets regardless of their order in the role.
  const rules = [
    ...snippets.filter((rule) => !rule.startsWith('!')),
    ...snippets.filter((rule) => rule.startsWith('!')),
  ];
  return resolveSkillRegistryPermissions(createAclSnippetAllow(rules, allowAll));
}

export function useSkillRegistryPermissions(): SkillRegistryPermissions {
  const role = useACLRoleContext();
  const override = useContext(SkillRegistryPermissionOverrideContext);
  return override ?? permissionsForRole(role);
}
