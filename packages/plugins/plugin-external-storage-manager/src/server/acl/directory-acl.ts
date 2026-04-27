/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Database } from '@nocobase/database';
import { DirectoryAction } from '../../constants';

/**
 * Per-directory ACL system for external storage.
 * Checks if a user's roles have specific actions allowed on a directory + sub-path.
 *
 * Design:
 * - Root role always has full access (bypass all checks)
 * - Each directory can have multiple permission records (one per role)
 * - Each permission record specifies allowed actions and optional sub-path restriction
 * - Sub-path matching uses prefix matching (empty sub-path = full access from rootPath)
 */
export class DirectoryACL {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Check if user's roles have the specified action on the given directory + subPath.
   *
   * @param params.directoryId - The virtual directory ID
   * @param params.roles - The user's current roles
   * @param params.action - The action to check (list, view, upload, download, delete, mkdir)
   * @param params.subPath - The sub-path within the directory being accessed
   * @returns true if access is granted, false otherwise
   */
  async checkAccess(params: {
    directoryId: number;
    roles: string[];
    action: DirectoryAction;
    subPath?: string;
  }): Promise<boolean> {
    // Enforce permissions strictly for all roles, including root,
    // so the permission configuration has a visible effect during testing and administration.

    try {
      const permissions = await this.db.getRepository('externalStorageDirectoryPermissions').find({
        filter: {
          directoryId: params.directoryId,
          roleName: { $in: params.roles },
        },
      });

      for (const perm of permissions) {
        const actions: string[] = perm.get('actions') || [];
        const permSubPath: string = perm.get('subPath') || '';

        // Check if the action is allowed
        if (!actions.includes(params.action)) {
          continue;
        }

        // Check sub-path match
        // Empty permSubPath = full access from rootPath
        if (!permSubPath) {
          return true;
        }

        // If permSubPath is set, check if the requested subPath starts with it
        const normalizedPermSubPath = permSubPath.replace(/\/$/, '');
        const normalizedRequestSubPath = (params.subPath || '').replace(/\/$/, '');

        if (
          normalizedRequestSubPath === normalizedPermSubPath ||
          normalizedRequestSubPath.startsWith(normalizedPermSubPath + '/')
        ) {
          return true;
        }
      }

      return false;
    } catch (error) {
      // If we can't check permissions, deny by default
      return false;
    }
  }

  /**
   * Get all directory IDs that the given roles have at least 'list' access to.
   * Used to show only accessible directories in the sidebar.
   */
  async getAccessibleDirectories(roles: string[]): Promise<number[]> {
    // Enforce permissions strictly for all roles

    const permissions = await this.db.getRepository('externalStorageDirectoryPermissions').find({
      filter: {
        roleName: { $in: roles },
      },
    });

    // Only include directories where the role has 'list' action
    const directoryIds = new Set<number>();
    for (const perm of permissions) {
      const actions: string[] = perm.get('actions') || [];
      if (actions.includes('list')) {
        directoryIds.add(perm.get('directoryId'));
      }
    }

    return [...directoryIds];
  }

  /**
   * Get the allowed actions for a specific directory + role combination.
   * Used by the client to know which UI elements to show.
   */
  async getAllowedActions(directoryId: number, roles: string[]): Promise<DirectoryAction[]> {
    // Enforce permissions strictly for all roles

    const permissions = await this.db.getRepository('externalStorageDirectoryPermissions').find({
      filter: {
        directoryId,
        roleName: { $in: roles },
      },
    });

    const allActions = new Set<DirectoryAction>();
    for (const perm of permissions) {
      const actions: DirectoryAction[] = perm.get('actions') || [];
      actions.forEach((a) => allActions.add(a));
    }

    return [...allActions];
  }

  /**
   * Get the allowed actions for multiple directories + roles in bulk to avoid N+1 queries.
   */
  async getAllowedActionsBulk(directoryIds: number[], roles: string[]): Promise<Record<number, DirectoryAction[]>> {
    const result: Record<number, DirectoryAction[]> = {};
    directoryIds.forEach(id => result[id] = []);

    // Enforce permissions strictly for all roles

    if (directoryIds.length === 0) return result;

    const permissions = await this.db.getRepository('externalStorageDirectoryPermissions').find({
      filter: {
        directoryId: { $in: directoryIds },
        roleName: { $in: roles },
      },
    });

    for (const perm of permissions) {
      const dirId = perm.get('directoryId');
      const actions: DirectoryAction[] = perm.get('actions') || [];
      actions.forEach((a) => {
        if (!result[dirId].includes(a)) {
          result[dirId].push(a);
        }
      });
    }

    return result;
  }
}

export default DirectoryACL;
