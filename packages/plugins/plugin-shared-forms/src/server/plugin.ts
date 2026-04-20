/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { UiSchemaRepository } from '@nocobase/plugin-ui-schema-storage';
import { Plugin } from '@nocobase/server';
import { parseAssociationNames } from './hook';

class AccessDeniedError extends Error {}

export class PluginSharedFormsServer extends Plugin {
  async parseCollectionData(dataSourceKey: string, formCollection: string, appends: string[]) {
    const dataSource = this.app.dataSourceManager.dataSources.get(dataSourceKey);
    const collection = dataSource.collectionManager.getCollection(formCollection);
    const collections = [
      {
        name: collection.name,
        fields: collection.getFields().map((v) => ({
          ...v.options,
        })),
        template: collection.options.template,
      },
    ];
    return collections.concat(
      appends.map((v) => {
        const targetCollection = this.db.getCollection(v);
        return {
          ...targetCollection.options,
          fields: targetCollection.getFields().map((f) => ({
            ...f.options,
          })),
        };
      }),
    );
  }

  async getMetaByTk(filterByTk: string, currentUser: any) {
    const sharedForms = this.db.getRepository('sharedForms');
    const uiSchema = this.db.getRepository<UiSchemaRepository>('uiSchemas');
    const instance = await sharedForms.findOne({
      filter: {
        key: filterByTk,
      },
    });
    if (!instance) {
      throw new Error('The form is not found');
    }
    if (!instance.get('enabled')) {
      return null;
    }

    // Check role-based access — query through table directly to avoid association join issues
    const sharedFormsRoles = this.db.getRepository('sharedFormsRoles');
    const allowedRoleRecords = await sharedFormsRoles.find({
      filter: { sharedFormKey: filterByTk },
    });
    const allowedRoles = allowedRoleRecords.map((r: any) => r.get('roleName'));

    if (allowedRoles.length > 0) {
      const userRoles = await this.getUserRoles(currentUser.id);
      const isRootUser = userRoles.includes('root');
      if (!isRootUser) {
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));
        if (!hasAccess) {
          throw new AccessDeniedError('You do not have permission to access this form');
        }
      }
    }

    const keys = instance.get('collection').split(':');
    const collectionName = keys.pop();
    const dataSourceKey = keys.pop() || 'main';
    const title = instance.get('title');
    const schema = await uiSchema.getJsonSchema(filterByTk);
    const { getAssociationAppends } = parseAssociationNames(dataSourceKey, collectionName, this.app, schema);
    const { appends } = getAssociationAppends();
    const collections = await this.parseCollectionData(dataSourceKey, collectionName, appends);
    return {
      dataSource: {
        key: dataSourceKey,
        displayName: dataSourceKey,
        collections,
      },
      collectionName,
      appends,
      schema,
      title,
    };
  }

  async getUserRoles(userId: number): Promise<string[]> {
    const rolesUsers = this.db.getRepository('rolesUsers');
    const records = await rolesUsers.find({
      filter: { userId },
    });
    return records.map((r: any) => r.get('roleName'));
  }

  /**
   * API handler: sharedForms:getMeta
   * Requires loggedIn ACL — currentUser is guaranteed by the auth middleware.
   */
  getSharedFormsMeta = async (ctx, next) => {
    const { filterByTk, resourceIndex } = ctx.action.params;
    const key = filterByTk || resourceIndex;
    const currentUser = ctx.state.currentUser;
    try {
      ctx.body = await this.getMetaByTk(key, currentUser);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        ctx.throw(403, error.message);
      } else {
        throw error;
      }
    }
    await next();
  };

  /**
   * Middleware for sharedSubmit action.
   * Placed AFTER 'auth' so ctx.state.currentUser is populated.
   * Verifies the user is authenticated and has role-based access
   * before converting sharedSubmit → create.
   */
  sharedFormMiddleware = async (ctx, next) => {
    if (!ctx.action) {
      return next();
    }

    const { actionName } = ctx.action;

    if (actionName !== 'sharedSubmit') {
      return next();
    }

    // Require authentication
    if (!ctx.state.currentUser) {
      ctx.throw(401, 'Authentication required');
      return;
    }

    // Get form key from the request header
    const formKey = ctx.get('X-Shared-Form-Key');
    if (!formKey) {
      ctx.throw(400, 'Missing form key');
      return;
    }

    // Verify the user has access to this form
    const sharedForms = this.db.getRepository('sharedForms');
    const instance = await sharedForms.findOne({
      filter: { key: formKey },
    });

    if (!instance) {
      ctx.throw(404, 'The form is not found');
      return;
    }
    if (!instance.get('enabled')) {
      ctx.throw(403, 'The form is not enabled');
      return;
    }

    // Query through table directly to avoid association join issues
    const sharedFormsRoles = this.db.getRepository('sharedFormsRoles');
    const allowedRoleRecords = await sharedFormsRoles.find({
      filter: { sharedFormKey: formKey },
    });
    const allowedRoles = allowedRoleRecords.map((r: any) => r.get('roleName'));

    if (allowedRoles.length > 0) {
      const userRoles = await this.getUserRoles(ctx.state.currentUser.id);
      const isRootUser = userRoles.includes('root');
      if (!isRootUser) {
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));
        if (!hasAccess) {
          ctx.throw(403, 'You do not have permission to submit this form');
          return;
        }
      }
    }

    // Parse target collections from schema for ACL
    let targetCollections: string[] = [];
    const collectionKeys = instance.get('collection').split(':');
    const collectionName = collectionKeys[collectionKeys.length - 1];
    try {
      const uiSchema = this.db.getRepository<UiSchemaRepository>('uiSchemas');
      const schema = await uiSchema.getJsonSchema(formKey);
      const keys = instance.get('collection').split(':');
      const dataSourceKey = keys.length > 1 ? keys[keys.length - 2] : 'main';
      const { getAssociationAppends } = parseAssociationNames(dataSourceKey, collectionName, this.app, schema);
      const { appends } = getAssociationAppends();
      targetCollections = appends;
    } catch (e) {
      // ignore parse errors
    }

    // Store form context for ACL middleware
    ctx.SharedForm = {
      collectionName,
      formKey,
      targetCollections,
    };

    // Convert sharedSubmit to create (also triggers workflow Action events)
    ctx.action.actionName = 'create';

    await next();
  };

  /**
   * ACL middleware: grants permission for shared form operations.
   * Only activates when ctx.SharedForm is set by sharedFormMiddleware.
   */
  sharedFormACL = async (ctx, next) => {
    if (!ctx.SharedForm) {
      return next();
    }

    const { resourceName, actionName } = ctx.action;
    const collection = this.db.getCollection(resourceName);

    if (actionName === 'create' && ctx.SharedForm.collectionName === resourceName) {
      ctx.permission = { skip: true };
    } else if (
      (['list', 'get'].includes(actionName) && ctx.SharedForm.targetCollections.includes(resourceName)) ||
      (collection?.options.template === 'file' && actionName === 'create') ||
      (resourceName === 'storages' && ['getBasicInfo', 'createPresignedUrl'].includes(actionName)) ||
      (resourceName === 'vditor' && ['check'].includes(actionName)) ||
      (resourceName === 'map-configuration' && actionName === 'get')
    ) {
      ctx.permission = { skip: true };
    }
    await next();
  };

  async load() {
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['sharedForms:*', 'roles:list', 'rolesResources:*', 'rolesResourcesActions:*'],
    });

    // Ensure admin role has the pm snippet (runs on every startup to cover existing installs).
    this.app.on('afterStart', async () => {
      try {
        const Role = this.db.getModel('roles');
        const adminRole = await Role.findOne({ where: { name: 'admin' } });
        if (adminRole) {
          const snippets: string[] = adminRole.get('snippets') || [];
          const snippetName = `pm.${this.name}`;
          if (!snippets.includes(snippetName)) {
            snippets.push(snippetName);
            await adminRole.update({ snippets });
          }
        }
      } catch (e) {
        this.app.logger?.warn(`[shared-forms] Failed to grant admin snippet: ${e.message}`);
      }
    });

    // Alias getMeta → view so role "Action permissions" for sharedForms controls getMeta.
    // Admins can grant/revoke access per role via Settings → Roles → Action permissions.
    (this.app.acl as any).actionAlias.set('getMeta', 'view');

    // Pre-ACL middleware: return 401 for unauthenticated getMeta requests.
    // Without this, ACL would return 403 for the anonymous role, preventing
    // the client from distinguishing "not logged in" from "access denied".
    this.app.resourceManager.use(
      async (ctx, next) => {
        const { resourceName, actionName } = ctx.action || {};
        if (resourceName === 'sharedForms' && actionName === 'getMeta' && !ctx.state.currentUser) {
          ctx.throw(401, 'Authentication required');
          return;
        }
        await next();
      },
      { tag: 'sharedFormsGetMetaAuth', after: 'auth', before: 'acl' },
    );

    this.app.resourceManager.registerActionHandlers({
      'sharedForms:getMeta': this.getSharedFormsMeta,
    });

    this.app.dataSourceManager.afterAddDataSource((dataSource) => {
      // Place AFTER 'auth' so ctx.state.currentUser is available
      // Place BEFORE 'acl' so ctx.SharedForm is populated for the ACL check
      dataSource.resourceManager.use(this.sharedFormMiddleware, {
        after: 'auth',
        before: 'acl',
      });
      dataSource.acl.use(this.sharedFormACL, {
        before: 'core',
      });
      dataSource.resourceManager.registerActionHandlers({
        sharedSubmit: dataSource.resourceManager.getRegisteredHandler('create'),
      });
    });
  }

  async install() {
    await this.db.sync({ force: false, alter: { drop: false } });

    // Grant admin role access to configure shared forms (pm.* snippets are root-only by default).
    const Role = this.db.getModel('roles');
    const adminRole = await Role.findOne({ where: { name: 'admin' } });
    if (adminRole) {
      const snippets: string[] = adminRole.get('snippets') || [];
      const snippetName = `pm.${this.name}`;
      if (!snippets.includes(snippetName)) {
        snippets.push(snippetName);
        await adminRole.update({ snippets });
      }
    }

    // Seed default role permissions: admin and member can view (getMeta) sharedForms.
    // This mirrors what the admin would set in Settings → Roles → Action permissions.
    const rolesResources = this.db.getRepository('rolesResources');
    for (const roleName of ['admin', 'member']) {
      const exists = await rolesResources.findOne({ filter: { roleName, name: 'sharedForms' } });
      if (!exists) {
        await rolesResources.create({
          values: {
            roleName,
            name: 'sharedForms',
            usingActionsConfig: true,
            actions: [{ name: 'view' }],
          },
        });
      }
    }
  }

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginSharedFormsServer;
