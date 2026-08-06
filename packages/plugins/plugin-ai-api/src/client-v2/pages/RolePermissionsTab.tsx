import React from 'react';
import { AiApiRolePermissions } from '../components/AiApiRolePermissions';

/**
 * v2 ACL permission tab wrapper.
 *
 * The v2 `settingsUI.addPermissionsTab` loads a component via `componentLoader` and
 * passes it `PermissionTabProps` ({ activeRole, ... }), whereas AiApiRolePermissions
 * takes { role }. This wrapper bridges the prop shape so the shared component can be
 * reused unchanged across both client runtimes.
 */
export default function RolePermissionsTab({ activeRole }: { activeRole?: { name?: string } | null }) {
  return <AiApiRolePermissions role={activeRole} />;
}
