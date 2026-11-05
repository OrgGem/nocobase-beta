/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useAclSnippets } from '@nocobase/client-v2';

export const DOCKER_REGISTRY_SNIPPETS = {
  access: 'pm.plugin-docker-registry-ui.access',
  read: 'pm.plugin-docker-registry-ui.read',
  delete: 'pm.plugin-docker-registry-ui.delete',
  download: 'pm.plugin-docker-registry-ui.download',
  upload: 'pm.plugin-docker-registry-ui.upload',
  settings: 'pm.plugin-docker-registry-ui.settings',
  manage: 'pm.plugin-docker-registry-ui.manage',
  legacyManage: 'pm.plugin-docker-registry-ui',
} as const;

export const DOCKER_REGISTRY_PERMISSION_ITEMS = [
  {
    key: 'permission-upload',
    title: 'Upload images',
    aclSnippet: DOCKER_REGISTRY_SNIPPETS.upload,
  },
  {
    key: 'permission-download',
    title: 'Download images',
    aclSnippet: DOCKER_REGISTRY_SNIPPETS.download,
  },
  {
    key: 'permission-delete',
    title: 'Delete images',
    aclSnippet: DOCKER_REGISTRY_SNIPPETS.delete,
  },
] as const;

type AclSnippetAllow = (snippet?: string) => boolean;

export interface DockerRegistryPermissions {
  canRead: boolean;
  canDelete: boolean;
  canDownload: boolean;
  canUpload: boolean;
  canConfigure: boolean;
  canManage: boolean;
}

export interface DockerRegistryPageProps {
  permissions?: DockerRegistryPermissions;
  embedded?: boolean;
  search?: string;
  onNavigate?: (path: string) => void;
}

export function resolveDockerRegistryPermissions(allow: AclSnippetAllow): DockerRegistryPermissions {
  const canManage =
    allow(DOCKER_REGISTRY_SNIPPETS.manage) ||
    allow(DOCKER_REGISTRY_SNIPPETS.legacyManage) ||
    allow('pm.*') ||
    allow('pm');
  return {
    canRead: allow(DOCKER_REGISTRY_SNIPPETS.read) || canManage,
    canDelete: allow(DOCKER_REGISTRY_SNIPPETS.delete) || canManage,
    canDownload: allow(DOCKER_REGISTRY_SNIPPETS.download) || canManage,
    canUpload: allow(DOCKER_REGISTRY_SNIPPETS.upload) || canManage,
    canConfigure: allow(DOCKER_REGISTRY_SNIPPETS.settings) || canManage,
    canManage,
  };
}

export function useDockerRegistryPermissions(): DockerRegistryPermissions {
  const { allow } = useAclSnippets();
  return resolveDockerRegistryPermissions(allow);
}
