// SPDX-License-Identifier: Apache-2.0

import React, { type ComponentType } from 'react';
import { useACLRoleContext } from '@nocobase/client';

import { permissionsForRole, SkillRegistryPermissionOverrideContext } from '../client-v2/permissions';

export function withLegacySkillRegistryPermissions(Page: ComponentType) {
  function LegacySkillRegistryPage() {
    const permissions = permissionsForRole(useACLRoleContext());

    return (
      <SkillRegistryPermissionOverrideContext.Provider value={permissions}>
        <Page />
      </SkillRegistryPermissionOverrideContext.Provider>
    );
  }

  LegacySkillRegistryPage.displayName = `LegacySkillRegistryPage(${Page.displayName || Page.name || 'Page'})`;
  return LegacySkillRegistryPage;
}
