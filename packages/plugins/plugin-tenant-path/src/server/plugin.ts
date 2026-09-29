import { AppSupervisor, Gateway, Plugin } from '@nocobase/server';
import path from 'path';
import { TenantResolver } from './tenant-resolver';

// Mirrors the client validator in src/client-v2/TenantsSettingsPage.tsx.
const PATH_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PATH_PREFIX_MAX_LENGTH = 32;

// URL segments the gateway owns for serving static/dist assets or the API. A tenant may not take any of
// these as its pathPrefix, otherwise serving /<tenant>/... would collide with the fixed routes below.
const RESERVED_SEGMENTS = new Set(['api', 'dist', 'static', 'storage', 'v', 'admin']);

export class PluginTenantPathServer extends Plugin {
  private resolver?: TenantResolver;

  async beforeLoad() {
    await this.db.import({
      directory: path.resolve(__dirname, 'collections'),
    });
  }

  async load() {
    const resolver = new TenantResolver(this.db);
    this.resolver = resolver;

    // Reload the in-memory prefix→tenant mapping whenever tenant rows change so edits take effect without a restart.
    for (const event of ['tenants.afterSave', 'tenants.afterCreate', 'tenants.afterUpdate', 'tenants.afterDestroy']) {
      this.db.on(event, () => resolver.invalidate());
    }

    this.db.on('tenants.beforeSave', (model: { get: (k: string) => unknown }) => {
      const prefix = String(model.get('pathPrefix') || '')
        .trim()
        .toLowerCase();
      if (prefix.length > PATH_PREFIX_MAX_LENGTH) {
        throw new Error(`Tenant path prefix "${prefix}" may not exceed ${PATH_PREFIX_MAX_LENGTH} characters.`);
      }
      if (!PATH_PREFIX_PATTERN.test(prefix)) {
        throw new Error(`Tenant path prefix "${prefix}" must match ${PATH_PREFIX_PATTERN.toString()}.`);
      }
      if (RESERVED_SEGMENTS.has(prefix)) {
        throw new Error(`Tenant path prefix "${prefix}" is reserved and cannot be used.`);
      }
    });

    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['tenants:*', 'tenantPath:listApps'],
    });

    // Inventory of registered apps for the settings UI. Used when plugin-multi-app-manager (which provides
    // applications:list) is absent, so the appName field can still suggest real apps.
    this.app.resource({
      name: 'tenantPath',
      actions: {
        async listApps(ctx, next) {
          const supervisor = AppSupervisor.getInstance();
          const models = await supervisor.listAppModels();
          const names = Array.isArray(models)
            ? models
                .map((m: { get?: (k: string) => unknown; name?: unknown }) =>
                  String(m?.get?.('name') ?? m?.name ?? '').trim(),
                )
                .filter(Boolean)
            : [];
          ctx.body = { data: names };
          await next();
        },
      },
    });

    const gateway = Gateway.getInstance();
    gateway.addModernClientPrefixResolver((req) => resolver.resolvePrefix(req));

    // Runs after the core selector (which already set resolvedAppName from x-app/__appName). Only map a tenant to its
    // own app when no explicit app was requested, so the header/query override keeps priority.
    gateway.addAppSelectorMiddleware(async (ctx, next) => {
      if (!ctx.resolvedAppName) {
        const appName = await resolver.resolveAppName(ctx.req);
        if (appName) {
          ctx.resolvedAppName = appName;
        }
      }
      await next();
    });
  }

  async install() {}
}

export default PluginTenantPathServer;
