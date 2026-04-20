/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Model, MultipleRelationRepository, Transaction } from '@nocobase/database';
import PluginLocalizationServer from '@nocobase/plugin-localization';
import { Plugin } from '@nocobase/server';
import { tval } from '@nocobase/utils';
import _ from 'lodash';
import { resolve } from 'path';

export class PluginNextAppServer extends Plugin {
  async beforeLoad() {}

  async load() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    this.registerActionHandlers();
    this.bindNewMenuToRoles();
    this.setACL();
    this.registerLocalizationSource();

    this.app.db.on('nextAppRoutes.afterUpdate', async (instance: Model, { transaction }) => {
      if (instance.changed('enableTabs')) {
        const repository = this.app.db.getRepository('nextAppRoutes');
        await repository.update({
          filter: {
            parentId: instance.id,
          },
          values: {
            hidden: !instance.enableTabs,
          },
          transaction,
        });
      }
    });
  }

  setACL() {
    this.app.acl.registerSnippet({
      name: `ui.nextApp`,
      actions: [
        'nextAppRoutes:create',
        'nextAppRoutes:update',
        'nextAppRoutes:move',
        'nextAppRoutes:destroy',
        'nextAppRoutes:updateOrCreate',
      ],
    });

    this.app.acl.registerSnippet({
      name: `pm.nextApp`,
      actions: [
        'nextAppRoutes:list',
        'roles.nextAppRoutes:*',
        'nextAppConfig:list',
        'nextAppConfig:create',
        'nextAppConfig:update',
        'nextAppConfig:destroy',
      ],
    });

    this.app.acl.allow('nextAppRoutes', ['listAccessible', 'getAccessible'], 'loggedIn');
    this.app.acl.allow('nextAppConfig', ['list'], 'loggedIn');
  }

  /**
   * Roles with permission (allowNewNextAppMenu is true) can directly access the newly created menu
   */
  bindNewMenuToRoles() {
    this.app.db.on('roles.beforeCreate', async (instance: Model) => {
      instance.set(
        'allowNewNextAppMenu',
        instance.allowNewNextAppMenu === undefined
          ? ['admin', 'member'].includes(instance.name)
          : !!instance.allowNewNextAppMenu,
      );
    });

    this.db.on('nextAppRoutes.afterDestroy', async (instance: Model, { transaction }) => {
      const schemaUid = instance.get('schemaUid');
      if (!schemaUid) return;

      // Clean up flowModels
      const r = this.db.getRepository('flowModels');
      if (r) {
        await r.destroy({
          filter: {
            uid: schemaUid,
          },
          transaction,
        });
      }

      // Clean up uiSchemas
      try {
        await this.db.getRepository('uiSchemas').destroy({
          filter: { 'x-uid': schemaUid },
          transaction,
        });
      } catch (e) {
        // uiSchemas may not exist or may already be cleaned up
      }
    });

    this.db.on('nextAppRoutes.afterCreate', async (instance: Model, { transaction }) => {
      const schemaUid = instance.get('schemaUid');

      // Only create flowModel for routes with a schema (page/flowPage/tabs)
      if (schemaUid) {
        const r = this.db.getRepository('flowModels');
        if (r) {
          await r.create({
            transaction,
            values: {
              uid: schemaUid,
              name: schemaUid,
              schema: {
                use: 'RouteModel',
              },
            },
          });
        }
      }

      const addNewMenuRoles = await this.app.db.getRepository('roles').find({
        filter: {
          allowNewNextAppMenu: true,
        },
        transaction,
      });

      // @ts-ignore
      await this.app.db.getRepository('nextAppRoutes.roles', instance.id).add({
        tk: addNewMenuRoles.map((role) => role.name),
        transaction,
      });
    });

    const processRoleNextAppRoutes = async (params: {
      models: Model[];
      action: 'create' | 'remove';
      transaction: Transaction;
    }) => {
      const { models, action, transaction } = params;
      if (!models.length) return;
      const parentIds = models.map((x) => x.nextAppRouteId);
      const tabs: Model[] = await this.app.db.getRepository('nextAppRoutes').find({
        where: { parentId: parentIds, hidden: true },
        transaction,
      });
      if (!tabs.length) return;
      const repository = this.app.db.getRepository('rolesNextAppRoutes');
      const roleName = models[0].get('roleName');
      const tabIds = tabs.map((x) => x.get('id'));
      const where = { nextAppRouteId: tabIds, roleName };
      if (action === 'create') {
        const exists = await repository.find({ where, transaction });
        const modelsByRouteId = _.keyBy(exists, (x) => x.get('nextAppRouteId'));
        const createModels = tabs
          .map((x) => !modelsByRouteId[x.get('id')] && { nextAppRouteId: x.get('id'), roleName })
          .filter(Boolean);
        for (const values of createModels) {
          await repository.firstOrCreate({
            values,
            filterKeys: ['nextAppRouteId', 'roleName'],
            transaction,
          });
        }
        return;
      }

      if (action === 'remove') {
        return await repository.destroy({ filter: where, transaction });
      }
    };

    this.app.db.on('rolesNextAppRoutes.afterBulkCreate', async (instances, options) => {
      await processRoleNextAppRoutes({ models: instances, action: 'create', transaction: options.transaction });
    });

    this.app.db.on('rolesNextAppRoutes.afterBulkDestroy', async (options) => {
      const models = await this.app.db.getRepository('rolesNextAppRoutes').find({
        where: options.where,
      });
      await processRoleNextAppRoutes({ models: models, action: 'remove', transaction: options.transaction });
    });
  }

  registerActionHandlers() {
    this.app.resourceManager.registerActionHandler('nextAppRoutes:listAccessible', async (ctx, next) => {
      const nextAppRoutesRepository = ctx.db.getRepository('nextAppRoutes');
      const rolesRepository = ctx.db.getRepository('roles');
      const { filter } = ctx.action.params;

      if (ctx.state.currentRoles.includes('root')) {
        const { appPath, ...otherFilter } = filter || {};
        const actualFilter: any = { ...otherFilter };
        if (appPath) {
          actualFilter['config.path'] = appPath;
        }

        ctx.body = await nextAppRoutesRepository.find({
          tree: true,
          sort: 'sort',
          filter: actualFilter,
        });
        return await next();
      }

      const roles = await rolesRepository.find({
        filterByTk: ctx.state.currentRoles,
        appends: ['nextAppRoutes'],
      });

      const nextAppRoutesId = roles.flatMap((x) => x.get('nextAppRoutes')).map((item) => item.id);

      const { appPath, ...otherFilter } = filter || {};
      const actualFilter: any = { ...otherFilter };

      if (appPath) {
        actualFilter['config.path'] = appPath;
      }

      if (nextAppRoutesId.length > 0) {
        const result = await nextAppRoutesRepository.find({
          tree: true,
          sort: 'sort',
          filter: {
            ...actualFilter,
            id: nextAppRoutesId,
          },
        });

        ctx.body = result;
      } else {
        ctx.body = [];
      }

      await next();
    });

    this.app.resourceManager.registerActionHandler('nextAppRoutes:getAccessible', async (ctx, next) => {
      const nextAppRoutesRepository = ctx.db.getRepository('nextAppRoutes');
      const rolesRepository = ctx.db.getRepository('roles');
      const { filter } = ctx.action.params;

      if (ctx.state.currentRoles.includes('root')) {
        ctx.body = await nextAppRoutesRepository.findOne({
          sort: 'sort',
          ...ctx.action.params,
        });
        return await next();
      }

      const roles = await rolesRepository.find({
        filterByTk: ctx.state.currentRoles,
        appends: ['nextAppRoutes'],
      });

      const { appPath, ...otherFilter } = filter || {};
      const actualFilter: any = { ...otherFilter };

      if (appPath) {
        actualFilter['config.path'] = appPath;
      }

      if (nextAppRoutesId.length > 0) {
        const result = await nextAppRoutesRepository.findOne({
          filter: {
            ...actualFilter,
            id: nextAppRoutesId,
          },
          ...ctx.action.params,
        });

        ctx.body = result;
      } else {
        ctx.body = null;
      }

      await next();
    });

    this.app.resourceManager.registerActionHandler('roles.nextAppRoutes:set', async (ctx, next) => {
      let { values } = ctx.action.params;
      if (values.length) {
        const instances = await this.app.db.getRepository('nextAppRoutes').find({
          filter: {
            $or: [{ id: { $in: values } }, { parentId: { $in: values } }],
          },
        });
        values = instances.map((instance) => instance.get('id'));
      }
      const { resourceName, sourceId } = ctx.action;
      const repository = this.app.db.getRepository<MultipleRelationRepository>(resourceName, sourceId);
      await repository['set'](values);

      ctx.status = 200;
      await next();
    });
  }

  registerLocalizationSource() {
    const localizationPlugin = this.app.pm.get('localization') as PluginLocalizationServer;
    if (!localizationPlugin) {
      return;
    }
    localizationPlugin.sourceManager.registerSource('next-app-routes', {
      title: tval('Next App routes'),
      sync: async (ctx) => {
        const nextAppRoutes = await ctx.db.getRepository('nextAppRoutes').find({
          raw: true,
        });
        const resources = {};
        nextAppRoutes.forEach((route: { title?: string }) => {
          if (route.title) {
            resources[route.title] = '';
          }
        });
        return {
          'lm-next-app-routes': resources,
        };
      },
      namespace: 'lm-next-app-routes',
      collections: [
        {
          collection: 'nextAppRoutes',
          fields: ['title'],
        },
      ],
    });
  }
}

export default PluginNextAppServer;
