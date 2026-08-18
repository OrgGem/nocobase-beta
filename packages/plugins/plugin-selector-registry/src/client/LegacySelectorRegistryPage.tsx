import React, { type ComponentType } from 'react';
import { useAclSnippets } from '@nocobase/client';

import {
  resolveSelectorRegistryPermissions,
  SelectorRegistryPermissionOverrideContext,
} from '../client-v2/permissions';

export function withLegacySelectorRegistryPermissions(Page: ComponentType) {
  function LegacySelectorRegistryPage() {
    const { allow } = useAclSnippets();
    const permissions = resolveSelectorRegistryPermissions(allow);

    return (
      <SelectorRegistryPermissionOverrideContext.Provider value={permissions}>
        <Page />
      </SelectorRegistryPermissionOverrideContext.Provider>
    );
  }

  LegacySelectorRegistryPage.displayName = `LegacySelectorRegistryPage(${Page.displayName || Page.name || 'Page'})`;
  return LegacySelectorRegistryPage;
}
