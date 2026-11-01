/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';

const PATH_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const RESERVED_PATH_ALIASES = new Set([
  'admin',
  'api',
  'apps',
  'login',
  'logout',
  'register',
  'settings',
  'signin',
  'static',
  'v2',
]);
const DEFAULT_DESKTOP_LAYOUT_UID = 'admin-layout-model';

const getRecordValue = (record: unknown, key: string) => {
  if (!record || typeof record !== 'object') {
    return undefined;
  }

  const candidate = record as { get?: (field: string) => unknown } & Record<string, unknown>;
  return typeof candidate.get === 'function' ? candidate.get(key) : candidate[key];
};

const setRecordPathAlias = (record: unknown, pathAlias?: string) => {
  if (!record || typeof record !== 'object') {
    return;
  }

  const candidate = record as {
    get?: (field: string) => unknown;
    set?: (field: string, value: unknown) => void;
  } & Record<string, unknown>;
  const options = getRecordValue(record, 'options');
  const nextOptions = options && typeof options === 'object' && !Array.isArray(options) ? { ...options } : {};
  if (pathAlias) {
    (nextOptions as Record<string, unknown>).pathAlias = pathAlias;
  } else {
    if (!Object.prototype.hasOwnProperty.call(nextOptions, 'pathAlias')) {
      return;
    }
    delete (nextOptions as Record<string, unknown>).pathAlias;
  }

  if (typeof candidate.set === 'function') {
    candidate.set('options', nextOptions);
  } else {
    candidate.options = nextOptions;
  }
};

const collectRouteIds = (routes: unknown, ids = new Set<string>()) => {
  if (!Array.isArray(routes)) {
    return ids;
  }

  for (const route of routes) {
    const id = getRecordValue(route, 'id');
    if (id !== undefined && id !== null && String(id)) {
      ids.add(String(id));
    }
    collectRouteIds(getRecordValue(route, 'children'), ids);
  }

  return ids;
};

const collectSchemaUids = (values: unknown, schemaUids = new Set<string>()) => {
  if (Array.isArray(values)) {
    for (const value of values) {
      collectSchemaUids(value, schemaUids);
    }
    return schemaUids;
  }

  if (!values || typeof values !== 'object') {
    return schemaUids;
  }

  const record = values as Record<string, unknown>;
  if (typeof record.schemaUid === 'string' && record.schemaUid) {
    schemaUids.add(record.schemaUid);
  }
  collectSchemaUids(record.values, schemaUids);
  collectSchemaUids(record.children, schemaUids);
  return schemaUids;
};

const applyAccessiblePathAliases = (routes: unknown, aliasesByRouteId: Map<string, string>) => {
  if (!Array.isArray(routes)) {
    return;
  }

  for (const route of routes) {
    const id = getRecordValue(route, 'id');
    const alias = id === undefined || id === null ? undefined : aliasesByRouteId.get(String(id));
    if (getRecordValue(route, 'type') === 'flowPage') {
      setRecordPathAlias(route, alias);
    }
    applyAccessiblePathAliases(getRecordValue(route, 'children'), aliasesByRouteId);
  }
};

const isUniqueConstraintError = (error: unknown) => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { name?: unknown; code?: unknown; original?: { code?: unknown } };
  return (
    candidate.name === 'SequelizeUniqueConstraintError' ||
    candidate.code === '23505' ||
    candidate.code === 'ER_DUP_ENTRY' ||
    candidate.original?.code === '23505' ||
    candidate.original?.code === 'ER_DUP_ENTRY'
  );
};

export const canMatchDesktopRouteId = (pathAlias: string) => {
  if (!/^\d+$/.test(pathAlias)) {
    return false;
  }

  const normalized = pathAlias.replace(/^0+(?=\d)/, '');
  return normalized.length < 19 || (normalized.length === 19 && normalized <= '9223372036854775807');
};

export class PluginRouterConfigurationServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.acl.registerSnippet({
      name: 'pm.router-configuration',
      actions: [
        'desktopRoutes:list',
        'desktopRoutes:renamePath',
        'desktopRoutes:listPathAliases',
        'desktopRoutes:setPathAlias',
      ],
    });

    this.registerRenameAction();
    this.registerPathAliasActions();
    this.registerAccessiblePathAliasMiddleware();
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}

  private registerRenameAction() {
    this.app.resourceManager.registerActionHandler('desktopRoutes:renamePath', async (ctx, next) => {
      const actionParams = ctx.action.params as Record<string, unknown>;
      const requestBody =
        ctx.request.body && typeof ctx.request.body === 'object' ? (ctx.request.body as Record<string, unknown>) : {};
      const candidate = actionParams.values || requestBody.values || requestBody;
      const wrappedValues = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : {};
      const values =
        wrappedValues.values && typeof wrappedValues.values === 'object'
          ? (wrappedValues.values as Record<string, unknown>)
          : wrappedValues;
      const id = values.id;
      const newSchemaUid = values.schemaUid;
      const repo = ctx.db.getRepository('desktopRoutes');

      if (!id) {
        ctx.throw(400, 'Missing required parameter: id');
      }
      if (!newSchemaUid || typeof newSchemaUid !== 'string') {
        return ctx.throw(400, 'Missing required parameter: schemaUid (new path)');
      }

      // Validate path format: lowercase letters, numbers, hyphens
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(newSchemaUid)) {
        ctx.throw(
          400,
          'Invalid path format. Use lowercase letters, numbers, and hyphens. Must start and end with a letter or number.',
        );
      }

      // Validate path length
      if (newSchemaUid.length > 100) {
        ctx.throw(400, 'Path too long. Maximum 100 characters.');
      }

      // Reserved paths
      const reservedPaths = ['admin', 'v2', 'api', 'static', 'login', 'logout', 'register'];
      if (reservedPaths.includes(newSchemaUid.toLowerCase())) {
        ctx.throw(400, `The path "${newSchemaUid}" is reserved and cannot be used.`);
      }

      // Find the route to rename
      const route = await repo.findOne({ filterByTk: id });
      if (!route) {
        ctx.throw(404, `Route with id ${id} not found.`);
      }

      if (route.get('type') === 'tabs') {
        ctx.throw(400, 'Tab route paths cannot be renamed.');
      }
      if (route.get('type') === 'flowPage') {
        ctx.throw(409, 'V2 page paths cannot be renamed.');
      }

      const oldSchemaUid = route.get('schemaUid');
      if (!oldSchemaUid || typeof oldSchemaUid !== 'string') {
        ctx.throw(400, 'This route does not have a schemaUid to rename.');
      }

      if (oldSchemaUid === newSchemaUid) {
        ctx.body = { success: true, message: 'Path unchanged' };
        return next();
      }

      // Check if newSchemaUid is already in use by another route
      const existing = await repo.findOne({
        filter: {
          schemaUid: newSchemaUid,
          id: { $ne: id },
        },
      });
      if (existing) {
        ctx.throw(409, `The path "${newSchemaUid}" is already in use by another route.`);
      }

      const aliasConflict = await ctx.db.getRepository('desktopRoutePathAliases').findOne({
        filter: { pathAlias: newSchemaUid },
      });
      if (aliasConflict) {
        ctx.throw(409, `The path "${newSchemaUid}" is already used as a V2 route alias.`);
      }

      const transaction = await ctx.db.sequelize.transaction();

      try {
        // Update the desktopRoutes record
        await repo.update({
          filterByTk: id,
          values: { schemaUid: newSchemaUid },
          transaction,
        });

        // Try to update the corresponding UI schema record (best-effort)
        // x-uid is the primary key of uiSchemas — requires insert+delete
        try {
          const uiSchemaRepo = ctx.db.getRepository('uiSchemas');
          const uiSchemas = await uiSchemaRepo.find({
            filter: {
              'x-uid': oldSchemaUid,
            },
            transaction,
          });

          if (uiSchemas && uiSchemas.length > 0) {
            for (const schemaRecord of uiSchemas) {
              const schemaJson = schemaRecord.get('schema');
              if (
                schemaJson &&
                typeof schemaJson === 'object' &&
                (schemaJson as Record<string, unknown>)['x-uid'] === oldSchemaUid
              ) {
                const newSchema = {
                  ...(schemaJson as Record<string, unknown>),
                  'x-uid': newSchemaUid,
                };
                const recordUid = schemaRecord.get('x-uid');
                if (typeof recordUid === 'string') {
                  await uiSchemaRepo.create({
                    values: {
                      'x-uid': newSchemaUid,
                      name: schemaRecord.get('name'),
                      schema: newSchema,
                    },
                    transaction,
                  });
                  await uiSchemaRepo.destroy({
                    filterByTk: recordUid,
                    transaction,
                  });
                }
              }
            }
          }
        } catch (err) {
          ctx.app.log.warn(
            `[plugin-router-configuration] Failed to update UI schema for schemaUid ${oldSchemaUid}: ${
              (err as Error).message
            }`,
          );
        }

        await transaction.commit();

        ctx.body = {
          success: true,
          oldSchemaUid,
          newSchemaUid,
          message: 'Path renamed successfully',
        };
      } catch (err) {
        await transaction.rollback();
        throw err;
      }

      return next();
    });
  }

  private registerPathAliasActions() {
    this.app.resourceManager.registerActionHandler('desktopRoutes:listPathAliases', async (ctx, next) => {
      const aliases = await ctx.db.getRepository('desktopRoutePathAliases').find({
        sort: 'pathAlias',
      });
      ctx.body = aliases;
      return next();
    });

    this.app.resourceManager.registerActionHandler('desktopRoutes:setPathAlias', async (ctx, next) => {
      const actionParams = ctx.action.params as Record<string, unknown>;
      const requestBody =
        ctx.request.body && typeof ctx.request.body === 'object' ? (ctx.request.body as Record<string, unknown>) : {};
      const candidate = actionParams.values || requestBody.values || requestBody;
      const wrappedValues = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : {};
      const values =
        wrappedValues.values && typeof wrappedValues.values === 'object'
          ? (wrappedValues.values as Record<string, unknown>)
          : wrappedValues;
      const id = values.id;
      const pathAliasValue = values.pathAlias;
      const repo = ctx.db.getRepository('desktopRoutes');
      const aliasRepo = ctx.db.getRepository('desktopRoutePathAliases');

      if (id === undefined || id === null || String(id) === '') {
        ctx.throw(400, 'Missing required parameter: id');
      }

      const pathAlias = pathAliasValue == null ? '' : typeof pathAliasValue === 'string' ? pathAliasValue.trim() : null;
      if (pathAlias === null) {
        ctx.throw(400, 'Path alias must be a string.');
      }

      const route = await repo.findOne({ filterByTk: id, appends: ['uiLayouts'] });
      if (!route) {
        ctx.throw(404, `Route with id ${id} not found.`);
      }

      if (!pathAlias) {
        const currentAlias = await aliasRepo.findOne({ filter: { desktopRouteId: id } });
        if (currentAlias) {
          await aliasRepo.destroy({ filterByTk: getRecordValue(currentAlias, 'id') });
        }
        ctx.body = { success: true, pathAlias: null, message: 'Path alias removed' };
        return next();
      }

      if (getRecordValue(route, 'type') !== 'flowPage') {
        ctx.throw(400, 'Only V2 pages can have a friendly URL alias.');
      }
      const layouts = getRecordValue(route, 'uiLayouts');
      if (!Array.isArray(layouts) || !layouts.some((layout) => getRecordValue(layout, 'layoutType') === 'desktop')) {
        ctx.throw(400, 'Friendly URL aliases are supported only for routes assigned to a desktop layout.');
      }

      const currentAlias = await aliasRepo.findOne({ filter: { desktopRouteId: id } });
      if (!PATH_ALIAS_PATTERN.test(pathAlias)) {
        ctx.throw(400, 'Invalid path alias. Use lowercase letters, numbers, and hyphens only.');
      }
      if (pathAlias.length > 100) {
        ctx.throw(400, 'Path alias too long. Maximum 100 characters.');
      }
      if (RESERVED_PATH_ALIASES.has(pathAlias)) {
        ctx.throw(400, `The path alias "${pathAlias}" is reserved and cannot be used.`);
      }

      const existingSchemaUid = await repo.findOne({ filter: { schemaUid: pathAlias } });
      if (existingSchemaUid) {
        ctx.throw(409, `The path alias "${pathAlias}" conflicts with an existing route path.`);
      }
      if (canMatchDesktopRouteId(pathAlias)) {
        const existingRouteId = await repo.findOne({ filter: { id: pathAlias } });
        if (existingRouteId) {
          ctx.throw(409, `The path alias "${pathAlias}" conflicts with an existing route id.`);
        }
      }

      const existingAlias = await aliasRepo.findOne({ filter: { pathAlias } });
      if (existingAlias && String(getRecordValue(existingAlias, 'desktopRouteId')) !== String(id)) {
        ctx.throw(409, `The path alias "${pathAlias}" is already in use by another route.`);
      }

      const transaction = await ctx.db.sequelize.transaction();
      try {
        if (currentAlias) {
          await aliasRepo.update({
            filterByTk: getRecordValue(currentAlias, 'id'),
            values: { pathAlias },
            transaction,
          });
        } else {
          await aliasRepo.create({
            values: { desktopRouteId: id, pathAlias },
            transaction,
          });
        }
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        if (isUniqueConstraintError(error)) {
          ctx.throw(409, `The path alias "${pathAlias}" is already in use by another route.`);
        }
        throw error;
      }

      ctx.body = { success: true, pathAlias, message: 'Path alias saved successfully' };
      return next();
    });

    const preventSchemaUidAliasCollisions = async (ctx, next) => {
      const actionParams = ctx.action.params as Record<string, unknown>;
      const requestBody =
        ctx.request.body && typeof ctx.request.body === 'object' ? (ctx.request.body as Record<string, unknown>) : {};
      const candidate = actionParams.values || requestBody.values || requestBody;
      for (const schemaUid of collectSchemaUids(candidate)) {
        const aliasConflict = await ctx.db.getRepository('desktopRoutePathAliases').findOne({
          filter: { pathAlias: schemaUid },
        });
        if (aliasConflict) {
          ctx.throw(409, `The route path "${schemaUid}" is already used as a V2 route alias.`);
        }
      }

      return next();
    };

    for (const action of ['desktopRoutes:create', 'desktopRoutes:update', 'desktopRoutes:updateOrCreate']) {
      this.app.resourceManager.registerPreActionHandler(action, preventSchemaUidAliasCollisions, {
        tag: 'plugin-router-configuration:schema-uid-alias-collision',
      });
    }
  }

  private registerAccessiblePathAliasMiddleware() {
    this.app.resourceManager.use(
      async (ctx, next) => {
        await next();

        const action = ctx.action as
          | {
              actionName?: string;
              resourceName?: string;
              params?: unknown;
              getName?: () => string;
              getResource?: () => { getName?: () => string } | undefined;
            }
          | undefined;
        const resourceName = action?.resourceName || action?.getResource?.()?.getName?.();
        const actionName = action?.actionName || action?.getName?.();
        if (resourceName !== 'desktopRoutes' || actionName !== 'listAccessible') {
          return;
        }

        applyAccessiblePathAliases(ctx.body, new Map());

        const params =
          action.params && typeof action.params === 'object' ? (action.params as Record<string, unknown>) : {};
        const requestedLayout = params.layout;
        const layoutUid = Array.isArray(requestedLayout)
          ? requestedLayout[0]
          : requestedLayout === undefined || requestedLayout === null || requestedLayout === ''
            ? DEFAULT_DESKTOP_LAYOUT_UID
            : requestedLayout;
        if (typeof layoutUid !== 'string' || !layoutUid) {
          return;
        }

        const layout = await ctx.db.getRepository('uiLayouts').findOne({
          filter: { uid: layoutUid, enabled: true },
        });
        if (getRecordValue(layout, 'layoutType') !== 'desktop') {
          return;
        }

        const routeIds = collectRouteIds(ctx.body);
        if (!routeIds.size) {
          return;
        }

        const aliases = await ctx.db.getRepository('desktopRoutePathAliases').find({
          filter: { desktopRouteId: Array.from(routeIds) },
        });
        const aliasesByRouteId = new Map<string, string>();
        for (const alias of aliases) {
          const routeId = getRecordValue(alias, 'desktopRouteId');
          const pathAlias = getRecordValue(alias, 'pathAlias');
          if (routeId !== undefined && routeId !== null && typeof pathAlias === 'string') {
            aliasesByRouteId.set(String(routeId), pathAlias);
          }
        }
        applyAccessiblePathAliases(ctx.body, aliasesByRouteId);
      },
      {
        tag: 'plugin-router-configuration:accessible-path-aliases',
        before: 'auth',
      },
    );
  }
}

export default PluginRouterConfigurationServer;
