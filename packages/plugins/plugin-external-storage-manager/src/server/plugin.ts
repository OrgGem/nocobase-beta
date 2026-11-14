/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { NAMESPACE } from '../constants';
import { IStorageAdapter } from './adapters/types';
import { createExtStorageActions } from './actions/ext-storage';
import type { Context } from '@nocobase/actions';

/** File-operation scopes must not authorize edits to the directory mappings themselves. */
export async function guardDirectoryManagement(ctx: Context, next: () => Promise<unknown>) {
  const resourceName = ctx.action?.resourceName || '';
  const segments = resourceName.split(/[.,]/);
  let resolvedCollection = '';
  try {
    const repository = ctx.getCurrentRepository?.();
    resolvedCollection = repository?.targetCollection?.name || repository?.collection?.name || '';
  } catch {
    // Non-collection resources do not have a current repository.
  }
  const params = ctx.action?.params;
  const isDirectoryResource =
    segments.includes('externalStorageDirectories') ||
    resolvedCollection === 'externalStorageDirectories' ||
    ctx.permission?.resourceName === 'externalStorageDirectories' ||
    params?.targetCollection === 'externalStorageDirectories' ||
    params?.values?.__collection === 'externalStorageDirectories';
  const isDirectRead =
    resourceName === 'externalStorageDirectories' &&
    !ctx.action?.sourceId &&
    ['list', 'get', 'query'].includes(ctx.action?.actionName);

  if (isDirectoryResource && !isDirectRead && !ctx.can({ resource: 'extStorage', action: 'manageDirectories' })) {
    return ctx.throw(403, ctx.t('Permission denied', { ns: NAMESPACE }));
  }
  return next();
}

export type StorageAdapterFactory = (directory: any) => Promise<IStorageAdapter>;

export class PluginExternalStorageManagerServer extends Plugin {
  private adapterFactories = new Map<string, StorageAdapterFactory>();

  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    const extStorageActions = createExtStorageActions(this.getAdapter.bind(this));

    this.app.resourceManager.use(guardDirectoryManagement, {
      tag: 'external-storage-directory-management',
      after: 'acl',
    });

    // Register handlers globally BEFORE defining the resource
    for (const [key, handler] of Object.entries(extStorageActions)) {
      this.app.resourceManager.registerActionHandler(`extStorage:${key}`, handler as any);
    }

    // Full management: directory CRUD plus every extStorage action.
    // `storageOptions`, `rolePermissions`, and `updateRolePermissions` are
    // intentionally covered here (admin-only), never by the browse snippet.
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.directories`,
      actions: ['externalStorageDirectories:*', 'extStorage:*'],
    });

    // Browse files UI: grants the extStorage API surface used by the file
    // browser. Actual per-directory permissions are still enforced in each
    // handler via `externalStorageDirectories` data scopes (view/update/destroy).
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.browse`,
      actions: [
        'extStorage:directories',
        'extStorage:list',
        'extStorage:stat',
        'extStorage:download',
        'extStorage:exists',
        'extStorage:upload',
        'extStorage:mkdir',
        'extStorage:rename',
        'extStorage:delete',
      ],
    });

    // Define the extStorage resource
    this.app.resourceManager.define({
      name: 'extStorage',
      actions: {
        directories: {},
        list: {},
        stat: {},
        download: {},
        upload: {},
        mkdir: {},
        rename: {},
        delete: {},
        exists: {},
        storageOptions: {},
        rolePermissions: {},
        updateRolePermissions: {},
      },
    });

    // Preview/download requests are performed by the browser carrying the
    // user's session token (`?token=` or Authorization header), the same
    // pattern as the S3/SFTP private-storage players. The auth middleware must
    // therefore accept this action for any logged-in user; per-directory
    // authorization is still enforced inside the handler via
    // `externalStorageDirectories` data scopes.
    this.app.acl.allow('extStorage', 'download', 'loggedIn');

    // Everything else stays deny-by-default: only roles granted the
    // `.browse` / `.directories` snippets can reach the other extStorage
    // actions, and per-directory permissions are still enforced in each
    // handler via `externalStorageDirectories` data scopes.
    this.log.info(`[ext-storage-manager] Plugin loaded successfully`);
  }

  /**
   * Registry for other plugins (S3, SFTP) to inject their storage adapters.
   */
  public registerBrowserAdapter(storageType: string, factory: StorageAdapterFactory) {
    this.adapterFactories.set(storageType, factory);
    this.log.info(`[ext-storage-manager] Registered adapter for type: ${storageType}`);
  }

  /**
   * Resolve the appropriate storage adapter for a directory record using the Registry.
   */
  private async getAdapter(directory: any): Promise<IStorageAdapter> {
    const storageType = directory.get('storageType');

    const factory = this.adapterFactories.get(storageType);
    if (!factory) {
      throw new Error(`[ext-storage-manager] Unsupported or unregistered storage type: ${storageType}`);
    }

    return await factory(directory);
  }

  async disable() {}
  async remove() {}
}

export default PluginExternalStorageManagerServer;
