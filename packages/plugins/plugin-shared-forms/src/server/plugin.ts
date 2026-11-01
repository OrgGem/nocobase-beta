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
import { collectionBinding, configuredFields, isObject, parseConfig, type FormModelSchema } from '../shared/v2Config';

class AccessDeniedError extends Error {}

export class PluginSharedFormsServer extends Plugin {
  async v2Collections(dataSourceKey: string, collectionName: string) {
    const manager = this.app.dataSourceManager.dataSources.get(dataSourceKey)?.collectionManager;
    const names = new Set<string>([collectionName]);
    for (let depth = 0; depth < 2; depth++) {
      for (const name of [...names]) {
        for (const field of manager.getCollection(name)?.getFields() || []) {
          const target = field.options.target;
          if (typeof target === 'string' && manager.getCollection(target)) names.add(target);
        }
      }
    }
    return [...names].map((name) => {
      const collection = manager.getCollection(name);
      return {
        ...collection.options,
        name: collection.name,
        filterTargetKey: collection.filterTargetKey,
        titleField: collection.titleField,
        fields: collection.getFields().map((field) => ({ ...field.options })),
      };
    });
  }

  v2Targets(model: FormModelSchema, dataSourceKey: string) {
    const manager = this.app.dataSourceManager.dataSources.get(dataSourceKey).collectionManager;
    const targets = new Set<string>();
    const types = ['hasOne', 'hasMany', 'belongsTo', 'belongsToMany', 'belongsToArray'];
    function visit(node: FormModelSchema) {
      const init = node.stepParams?.fieldSettings?.init;
      if (
        init?.dataSourceKey === dataSourceKey &&
        typeof init.collectionName === 'string' &&
        typeof init.fieldPath === 'string'
      ) {
        const field = manager.getCollection(init.collectionName)?.getField(init.fieldPath.split('.')[0]);
        if (types.includes(field?.options.type) && typeof field.options.target === 'string')
          targets.add(field.options.target);
      }
      for (const child of Object.values(node.subModels || {}))
        for (const item of Array.isArray(child) ? child : [child]) visit(item);
    }
    visit(model);
    return [...targets];
  }
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
        const targetCollection = dataSource.collectionManager.getCollection(v);
        return {
          ...targetCollection.options,
          fields: targetCollection.getFields().map((f) => ({
            ...f.options,
          })),
        };
      }),
    );
  }

  async getMetaByTk(filterByTk: string, currentUser: { id: string | number }) {
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
    const allowedRoles = allowedRoleRecords.map((record) => String(record.get('roleName')));

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

  async getUserRoles(userId: string | number): Promise<string[]> {
    const rolesUsers = this.db.getRepository('rolesUsers');
    const records = await rolesUsers.find({
      filter: { userId },
    });
    return records.map((record) => String(record.get('roleName')));
  }

  getV2Meta = async (ctx, next) => {
    const key = ctx.action.params.filterByTk || ctx.action.params.resourceIndex;
    const instance = await this.db
      .getRepository('sharedForms')
      .findOne({ filterByTk: key, filter: ctx.action.params.filter });
    if (!instance) ctx.throw(404, 'The form is not found');
    if (!instance.get('enabled')) {
      ctx.body = null;
      return next();
    }
    const allowed = await this.db.getRepository('sharedFormsRoles').find({ filter: { sharedFormKey: key } });
    const roles = await this.getUserRoles(ctx.state.currentUser.id);
    if (
      allowed.length &&
      !roles.includes('root') &&
      !allowed.some((role) => roles.includes(String(role.get('roleName'))))
    )
      ctx.throw(403, 'Access denied');
    const collection = String(instance.get('collection'));
    const binding = collectionBinding(collection);
    const config = instance.get('v2Config');
    ctx.body = {
      key,
      title: instance.get('title'),
      collection,
      config: config ? parseConfig(config, collection) : null,
      dataSource: {
        key: binding.dataSourceKey,
        collections: await this.v2Collections(binding.dataSourceKey, binding.collectionName),
      },
    };
    await next();
  };

  getV2Config = async (ctx, next) => {
    const key = ctx.action.params.filterByTk;
    const instance = await this.db.getRepository('sharedForms').findOne({ filterByTk: key });
    if (!instance) ctx.throw(404, 'The form is not found');
    const binding = collectionBinding(String(instance.get('collection')));
    let legacySchema: unknown = null;
    if (!instance.get('v2Config')) {
      try {
        legacySchema = await this.db.getRepository<UiSchemaRepository>('uiSchemas').getJsonSchema(key);
      } catch {
        /* A V2-only form has no V1 schema. */
      }
    }
    ctx.body = {
      dataSource: {
        key: binding.dataSourceKey,
        collections: await this.v2Collections(binding.dataSourceKey, binding.collectionName),
      },
      legacySchema,
    };
    await next();
  };

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
    const formKey = ctx.get('X-Shared-Form-Key');
    const isSubmission = actionName === 'sharedSubmit';
    if (!isSubmission && !(formKey && ctx.get('X-Shared-Form-Version') === '2')) {
      return next();
    }

    // Require authentication
    if (!ctx.state.currentUser) {
      ctx.throw(401, 'Authentication required');
      return;
    }

    // Get form key from the request header
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

    const binding = collectionBinding(String(instance.get('collection')));
    if (
      isSubmission &&
      (ctx.action.resourceName !== binding.collectionName ||
        (ctx.get('X-Data-Source') || 'main') !== binding.dataSourceKey)
    )
      ctx.throw(403, 'Form collection does not match');
    let hasLegacySchema = false;
    if (instance.get('v2Config') && ctx.get('X-Shared-Form-Version') !== '2') {
      try {
        const schema: unknown = await this.db.getRepository<UiSchemaRepository>('uiSchemas').getJsonSchema(formKey);
        hasLegacySchema = isObject(schema) && isObject(schema.properties) && isObject(schema.properties.form);
      } catch {
        /* V2-only forms have no legacy submission path. */
      }
    }
    let targetCollections: string[] = [];
    if (ctx.get('X-Shared-Form-Version') === '2' || (instance.get('v2Config') && !hasLegacySchema)) {
      const mainContext = Object.create(ctx);
      Object.defineProperty(mainContext, 'db', { value: this.db });
      Object.defineProperty(mainContext, 'database', { value: this.db });
      Object.defineProperty(mainContext, 'dataSource', { value: this.app.dataSourceManager.dataSources.get('main') });
      const permission = await this.app.acl.resolveActionParams(mainContext, {
        resourceName: 'sharedForms',
        actionName: 'view',
        params: { filterByTk: formKey },
      });
      if (!permission.can) ctx.throw(403, 'Access denied');
      const permitted = await this.db
        .getRepository('sharedForms')
        .findOne({ filterByTk: formKey, filter: permission.mergedParams?.filter });
      if (!permitted) ctx.throw(403, 'Access denied');
      let config;
      try {
        config = parseConfig(instance.get('v2Config'), String(instance.get('collection')));
      } catch {
        ctx.throw(400, 'Invalid V2 form configuration');
      }
      targetCollections = this.v2Targets(config.model, binding.dataSourceKey);
      if (isSubmission) {
        const fields = configuredFields(config.model);
        const values: unknown = ctx.action.params.values;
        if (!isObject(values) || Object.keys(values).some((key) => !fields.includes(key)))
          ctx.throw(400, 'Submitted fields do not match the form');
        ctx.action.params.whitelist = fields;
        ctx.action.params.updateAssociationValues = [];
      }
    }

    // Query through table directly to avoid association join issues
    const sharedFormsRoles = this.db.getRepository('sharedFormsRoles');
    const allowedRoleRecords = await sharedFormsRoles.find({
      filter: { sharedFormKey: formKey },
    });
    const allowedRoles = allowedRoleRecords.map((record) => String(record.get('roleName')));

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

    if (!isSubmission) {
      const sourceKey = ctx.get('X-Data-Source') || 'main';
      const target = this.app.dataSourceManager.dataSources
        .get(sourceKey)
        ?.collectionManager.getCollection(ctx.action.resourceName);
      const configuredTarget =
        sourceKey === binding.dataSourceKey && targetCollections.includes(ctx.action.resourceName);
      if (
        configuredTarget &&
        (['list', 'get'].includes(actionName) ||
          (target?.options.template === 'file' && ['create', 'upload'].includes(actionName)))
      )
        ctx.SharedForm = { collectionName: binding.collectionName, formKey, targetCollections };
      return next();
    }

    // Keep V1 association discovery; V2 targets come from native field bindings.
    const collectionKeys = instance.get('collection').split(':');
    const collectionName = collectionKeys[collectionKeys.length - 1];
    try {
      const uiSchema = this.db.getRepository<UiSchemaRepository>('uiSchemas');
      const schema = await uiSchema.getJsonSchema(formKey);
      const keys = instance.get('collection').split(':');
      const dataSourceKey = keys.length > 1 ? keys[keys.length - 2] : 'main';
      const { getAssociationAppends } = parseAssociationNames(dataSourceKey, collectionName, this.app, schema);
      const { appends } = getAssociationAppends();
      targetCollections = [...new Set([...targetCollections, ...appends])];
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
    const collection =
      ctx.dataSource?.collectionManager.getCollection(resourceName) || this.db.getCollection(resourceName);

    if (actionName === 'create' && ctx.SharedForm.collectionName === resourceName) {
      ctx.permission = { skip: true };
    } else if (
      (['list', 'get'].includes(actionName) && ctx.SharedForm.targetCollections.includes(resourceName)) ||
      (collection?.options.template === 'file' && ['create', 'upload'].includes(actionName)) ||
      (resourceName === 'storages' && ['getBasicInfo', 'createPresignedUrl'].includes(actionName)) ||
      (resourceName === 'vditor' && ['check'].includes(actionName)) ||
      (resourceName === 'map-configuration' && actionName === 'get')
    ) {
      ctx.permission = { skip: true };
    }
    await next();
  };

  async load() {
    const validateConfig = (instance) => {
      const config = instance.get('v2Config');
      if (config) parseConfig(config, String(instance.get('collection')));
    };
    this.db.on('sharedForms.beforeCreate', validateConfig);
    this.db.on('sharedForms.beforeUpdate', validateConfig);
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
    this.app.acl.actionAlias.set('getMeta', 'view');
    this.app.acl.actionAlias.set('getMetaV2', 'view');

    // Pre-ACL middleware: return 401 for unauthenticated getMeta requests.
    // Without this, ACL would return 403 for the anonymous role, preventing
    // the client from distinguishing "not logged in" from "access denied".
    this.app.resourceManager.use(
      async (ctx, next) => {
        const { resourceName, actionName } = ctx.action || {};
        if (resourceName === 'sharedForms' && ['getMeta', 'getMetaV2'].includes(actionName) && !ctx.state.currentUser) {
          ctx.throw(401, 'Authentication required');
          return;
        }
        await next();
      },
      { tag: 'sharedFormsGetMetaAuth', after: 'auth', before: 'acl' },
    );

    this.app.resourceManager.registerActionHandlers({
      'sharedForms:getMeta': this.getSharedFormsMeta,
      'sharedForms:getMetaV2': this.getV2Meta,
      'sharedForms:getV2Config': this.getV2Config,
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
