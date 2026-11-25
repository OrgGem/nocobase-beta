// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/server';
import { repairAllLegacyRouteContents, repairRouteContent, RouteContentRepairError } from './route-content-repair';

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
  private runStartupRouteRepair = async () => {
    if (!this.db) {
      return;
    }
    try {
      await repairAllLegacyRouteContents(this.db, this.app?.log);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.app?.log?.warn?.(`[plugin-router-configuration] Legacy route auto-repair skipped: ${message}`);
    }
  };

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
    this.app.off?.('afterStart', this.runStartupRouteRepair);
    this.app.on?.('afterStart', this.runStartupRouteRepair);
  }

  async install() {
    await this.runStartupRouteRepair();
  }

  async upgrade() {
    await this.runStartupRouteRepair();
  }

  async afterEnable() {
    await this.runStartupRouteRepair();
  }

  async afterDisable() {
    this.app.off?.('afterStart', this.runStartupRouteRepair);
  }

  async afterRemove() {
    this.app.off?.('afterStart', this.runStartupRouteRepair);
  }

  async remove() {
    this.app.off?.('afterStart', this.runStartupRouteRepair);
  }

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

      const requestedAlias =
        pathAliasValue == null ? '' : typeof pathAliasValue === 'string' ? pathAliasValue.trim() : null;
      if (requestedAlias === null) {
        ctx.throw(400, 'Path alias must be a string.');
      }

      const route = await repo.findOne({ filterByTk: id, appends: ['uiLayouts'] });
      if (!route) {
        ctx.throw(404, `Route with id ${id} not found.`);
      }

      const isFlowPage = getRecordValue(route, 'type') === 'flowPage';
      const schemaUid = getRecordValue(route, 'schemaUid');
      const layouts = getRecordValue(route, 'uiLayouts');
      const hasDesktopLayout =
        Array.isArray(layouts) && layouts.some((layout) => getRecordValue(layout, 'layoutType') === 'desktop');
      const canRepairPage =
        isFlowPage &&
        hasDesktopLayout &&
        typeof ctx.db.hasCollection === 'function' &&
        ctx.db.hasCollection('flowModels') &&
        ctx.db.hasCollection('flowModelTreePath');

      if (!requestedAlias && !canRepairPage) {
        const currentAlias = await aliasRepo.findOne({ filter: { desktopRouteId: id } });
        if (currentAlias) {
          await aliasRepo.destroy({ filterByTk: getRecordValue(currentAlias, 'id') });
        }
        ctx.body = { success: true, pathAlias: null, message: 'Path alias removed' };
        return next();
      }

      if (requestedAlias) {
        if (!isFlowPage) {
          ctx.throw(400, 'Only V2 pages can have a friendly URL alias.');
        }
        if (!hasDesktopLayout) {
          ctx.throw(400, 'Friendly URL aliases are supported only for routes assigned to a desktop layout.');
        }
        if (!PATH_ALIAS_PATTERN.test(requestedAlias)) {
          ctx.throw(400, 'Invalid path alias. Use lowercase letters, numbers, and hyphens only.');
        }
        if (requestedAlias.length > 100) {
          ctx.throw(400, 'Path alias too long. Maximum 100 characters.');
        }
        if (RESERVED_PATH_ALIASES.has(requestedAlias)) {
          ctx.throw(400, `The path alias "${requestedAlias}" is reserved and cannot be used.`);
        }

        const existingSchemaUid = await repo.findOne({
          filter: { schemaUid: requestedAlias, id: { $ne: id } },
        });
        if (existingSchemaUid) {
          ctx.throw(409, `The path alias "${requestedAlias}" conflicts with an existing route path.`);
        }
        if (canMatchDesktopRouteId(requestedAlias)) {
          const existingRouteId = await repo.findOne({ filter: { id: requestedAlias } });
          if (
            existingRouteId &&
            (requestedAlias !== schemaUid || String(getRecordValue(existingRouteId, 'id')) !== String(id))
          ) {
            ctx.throw(409, `The path alias "${requestedAlias}" conflicts with an existing route id.`);
          }
        }

        const existingAlias = await aliasRepo.findOne({ filter: { pathAlias: requestedAlias } });
        if (existingAlias && String(getRecordValue(existingAlias, 'desktopRouteId')) !== String(id)) {
          ctx.throw(409, `The path alias "${requestedAlias}" is already in use by another route.`);
        }
      }

      const pathAlias = requestedAlias === schemaUid ? '' : requestedAlias;
      const transaction = await ctx.db.sequelize.transaction();
      try {
        if (canRepairPage) {
          if (typeof schemaUid !== 'string' || !schemaUid) {
            throw new RouteContentRepairError('The route has no schema uid.');
          }
          await repairRouteContent(ctx.db, String(id), schemaUid, transaction);
        }

        const currentAlias = await aliasRepo.findOne({ filter: { desktopRouteId: id }, transaction });
        if (!pathAlias && currentAlias) {
          await aliasRepo.destroy({ filterByTk: getRecordValue(currentAlias, 'id'), transaction });
        } else if (pathAlias && currentAlias) {
          await aliasRepo.update({
            filterByTk: getRecordValue(currentAlias, 'id'),
            values: { pathAlias },
            transaction,
          });
        } else if (pathAlias) {
          await aliasRepo.create({
            values: { desktopRouteId: id, pathAlias },
            transaction,
          });
        }
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        if (error instanceof RouteContentRepairError) {
          ctx.app.log.warn(`[plugin-router-configuration] ${error.message}`);
          ctx.throw(
            409,
            ctx.t('The page content could not be recovered safely. Check the route and page models.', {
              ns: 'plugin-router-configuration',
            }),
          );
        }
        if (isUniqueConstraintError(error)) {
          ctx.throw(409, `The path alias "${pathAlias}" is already in use by another route.`);
        }
        throw error;
      }

      ctx.body = pathAlias
        ? { success: true, pathAlias, message: 'Path alias saved successfully' }
        : { success: true, pathAlias: null, message: 'Path alias removed' };
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
