/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
