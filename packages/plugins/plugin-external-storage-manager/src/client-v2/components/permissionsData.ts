export type DirectoryId = string | number;
export type PermissionAction = 'view' | 'update' | 'destroy';
export type DirectoryPermissions = Record<PermissionAction, DirectoryId[]>;

export function readDirectoryPermissions(response: unknown): DirectoryPermissions {
  let value = response;
  for (let depth = 0; depth < 3 && value && typeof value === 'object' && 'data' in value; depth++) {
    value = (value as { data: unknown }).data;
  }
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const ids = (key: PermissionAction): DirectoryId[] => {
    const value = source[key];
    return Array.isArray(value)
      ? value.filter((id): id is DirectoryId => typeof id === 'string' || typeof id === 'number')
      : [];
  };
  return { view: ids('view'), update: ids('update'), destroy: ids('destroy') };
}
