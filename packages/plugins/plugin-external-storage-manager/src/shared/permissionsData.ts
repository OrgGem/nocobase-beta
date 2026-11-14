// SPDX-License-Identifier: Apache-2.0

export type DirectoryId = string | number;
export type PermissionAction = 'view' | 'update' | 'destroy';
export type DirectoryPermissions = Record<PermissionAction, DirectoryId[]>;
export type Directory = { id: DirectoryId; name: string; rootPath?: string | null; storageType?: string | null };

export const permissionActions: PermissionAction[] = ['view', 'update', 'destroy'];

function unwrapResponse(response: unknown): unknown {
  let value = response;
  for (let depth = 0; depth < 3 && value && typeof value === 'object' && 'data' in value; depth++) {
    value = (value as { data: unknown }).data;
  }
  return value;
}

function isDirectoryId(value: unknown): value is DirectoryId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

export function readDirectoryPermissions(response: unknown): DirectoryPermissions {
  const value = unwrapResponse(response);
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const ids = (key: PermissionAction): DirectoryId[] => {
    const entries = source[key];
    return Array.isArray(entries) ? entries.filter(isDirectoryId) : [];
  };
  return { view: ids('view'), update: ids('update'), destroy: ids('destroy') };
}

/** The metadata is required: older servers cannot safely handle a partial update. */
export function readPermissionState(response: unknown): {
  permissions: DirectoryPermissions;
  readOnlyActions: PermissionAction[];
  supported: boolean;
} {
  const value = unwrapResponse(response);
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const metadata = source.readOnlyActions;
  const supported =
    Array.isArray(metadata) &&
    metadata.every((action): action is PermissionAction => permissionActions.includes(action)) &&
    permissionActions.every((action) => {
      const entries = source[action];
      return Array.isArray(entries) && entries.every(isDirectoryId);
    });

  return {
    permissions: readDirectoryPermissions(response),
    readOnlyActions: supported ? metadata : permissionActions,
    supported,
  };
}

export function readDirectories(response: unknown): Directory[] {
  const rows = unwrapResponse(response);
  if (!Array.isArray(rows)) throw new Error('Invalid directory response');
  return rows.filter((row): row is Directory => {
    if (!row || typeof row !== 'object') return false;
    return (
      isDirectoryId(row.id) &&
      typeof row.name === 'string' &&
      (row.rootPath == null || typeof row.rootPath === 'string') &&
      (row.storageType == null || typeof row.storageType === 'string')
    );
  });
}
