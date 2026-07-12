import { Plugin } from '@nocobase/server';

export class PluginRouterConfigurationServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.acl.registerSnippet({
      name: 'pm.router-configuration',
      actions: ['desktopRoutes:renamePath'],
    });

    this.app.acl.allow('desktopRoutes', 'renamePath', 'loggedIn');

    this.registerRenameAction();
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}

  private registerRenameAction() {
    this.app.resourceManager.registerActionHandler('desktopRoutes:renamePath', async (ctx, next) => {
      const { id, schemaUid: newSchemaUid } = ctx.action.params;
      const repo = ctx.db.getRepository('desktopRoutes');

      if (!id) {
        ctx.throw(400, 'Missing required parameter: id');
      }
      if (!newSchemaUid || typeof newSchemaUid !== 'string') {
        ctx.throw(400, 'Missing required parameter: schemaUid (new path)');
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
}

export default PluginRouterConfigurationServer;
