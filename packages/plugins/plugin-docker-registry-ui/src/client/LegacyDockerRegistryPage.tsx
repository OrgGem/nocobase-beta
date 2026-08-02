import { useAclSnippets } from '@nocobase/client';
import React, { type ComponentType } from 'react';

import { resolveDockerRegistryPermissions, type DockerRegistryPageProps } from '../client-v2/permissions';

export function withLegacyDockerRegistryPermissions(Page: ComponentType<DockerRegistryPageProps>) {
  function LegacyDockerRegistryPage() {
    const { allow } = useAclSnippets();
    const permissions = resolveDockerRegistryPermissions(allow);

    return <Page permissions={permissions} />;
  }

  LegacyDockerRegistryPage.displayName = `LegacyDockerRegistryPage(${Page.displayName || Page.name || 'Page'})`;
  return LegacyDockerRegistryPage;
}
