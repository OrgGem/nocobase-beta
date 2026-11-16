// SPDX-License-Identifier: Apache-2.0

export interface FolderSelectionInstance {
  id?: string | number;
  defaultFolderId?: number | null;
  defaultFolderKey?: string | null;
}

export interface SelectableFolder {
  folderId: number;
  folderKey?: string | null;
}

export function selectInitialFolder<T extends SelectableFolder>(
  instance: FolderSelectionInstance | undefined,
  folders: T[],
): T | undefined {
  return (
    folders.find(
      (folder) =>
        (instance?.defaultFolderKey && folder.folderKey === instance.defaultFolderKey) ||
        (instance?.defaultFolderId != null && folder.folderId === instance.defaultFolderId),
    ) || folders[0]
  );
}
