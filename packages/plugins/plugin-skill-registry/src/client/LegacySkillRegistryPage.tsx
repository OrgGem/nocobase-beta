import React, { type ComponentType } from 'react';
import { useAclSnippets } from '@nocobase/client';

import { resolveSkillRegistryPermissions, SkillRegistryPermissionOverrideContext } from '../client-v2/permissions';

export function withLegacySkillRegistryPermissions(Page: ComponentType) {
  function LegacySkillRegistryPage() {
    const { allow } = useAclSnippets();
    const permissions = resolveSkillRegistryPermissions(allow);

    return (
      <SkillRegistryPermissionOverrideContext.Provider value={permissions}>
        <Page />
      </SkillRegistryPermissionOverrideContext.Provider>
    );
  }

  LegacySkillRegistryPage.displayName = `LegacySkillRegistryPage(${Page.displayName || Page.name || 'Page'})`;
  return LegacySkillRegistryPage;
}
