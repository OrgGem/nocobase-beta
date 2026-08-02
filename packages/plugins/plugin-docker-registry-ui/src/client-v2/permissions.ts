import { useAclSnippets } from '@nocobase/client-v2';

export const DOCKER_REGISTRY_SNIPPETS = {
  access: 'pm.docker-registry-ui.access',
  read: 'pm.docker-registry-ui.read',
  delete: 'pm.docker-registry-ui.delete',
  download: 'pm.docker-registry-ui.download',
  upload: 'pm.docker-registry-ui.upload',
  settings: 'pm.docker-registry-ui.settings',
  manage: 'pm.docker-registry-ui.manage',
  legacyManage: 'pm.docker-registry-ui',
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
