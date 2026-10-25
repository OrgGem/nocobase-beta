/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
