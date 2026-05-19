import { Context } from '@nocobase/actions';

const PROTECTED_PLUGIN_NAMES = new Set(['nocobase', 'plugin-cluster-manager']);
const PROTECTED_PACKAGE_NAMES = new Set(['nocobase', '@nocobase/preset-nocobase', 'plugin-cluster-manager']);

function getPayload(ctx: Context) {
  return (ctx.action.params.values || (ctx as any).request?.body?.values || (ctx as any).request?.body || {}) as any;
}

function pluginDisplayName(plugin: any) {
  return plugin.displayName || plugin.name || plugin.packageName;
}

function isProtectedPlugin(plugin: any) {
  return PROTECTED_PLUGIN_NAMES.has(plugin.name) || PROTECTED_PACKAGE_NAMES.has(plugin.packageName);
}

async function getApplicationPlugins(ctx: Context) {
  const repo = ctx.db.getRepository('applicationPlugins');
  const rows = await repo.find({ sort: ['name'] });
  return rows.map((row: any) => row.toJSON());
}

async function findPlugin(ctx: Context, requestedName?: string) {
  const name = String(requestedName || '').trim();
  if (!name) {
    ctx.throw(400, 'Plugin name is required.');
  }

  const plugins = await getApplicationPlugins(ctx);
  const plugin = plugins.find((item: any) => item.name === name || item.packageName === name);
  if (!plugin) {
    ctx.throw(404, `Plugin "${name}" was not found in applicationPlugins.`);
  }
  return plugin;
}

async function getLoadedPluginInfo(ctx: Context, plugin: any, locale: string): Promise<any> {
  const pm = (ctx.app as any).pm;
  const instance = pm?.get?.(plugin.name) || pm?.get?.(plugin.packageName);
  if (!instance) {
    return {};
  }

  try {
    return await instance.toJSON({ locale, withOutOpenFile: true });
  } catch {
    return {
      name: instance.name,
      packageName: instance.options?.packageName,
      displayName: instance.options?.packageJson?.displayName,
      description: instance.options?.packageJson?.description,
    };
  }
}

async function getPackageInfo(ctx: Context, plugin: any, locale: string): Promise<any> {
  const loadedInfo = await getLoadedPluginInfo(ctx, plugin, locale);
  if (loadedInfo.displayName || loadedInfo.description) {
    return loadedInfo;
  }

  try {
    const pmCtor = (ctx.app as any).pm?.constructor as any;
    const pkgJson = await pmCtor.getPackageJson(plugin.packageName);
    return {
      displayName: pkgJson?.[`displayName.${locale}`] || pkgJson?.displayName || plugin.name,
      description: pkgJson?.[`description.${locale}`] || pkgJson?.description,
      keywords: pkgJson?.keywords,
    };
  } catch {
    return {};
  }
}

export const pluginOperationsActions = {
  async list(ctx: Context, next: () => Promise<void>) {
    const locale = (ctx as any).getCurrentLocale?.() || 'en-US';
    const plugins = await getApplicationPlugins(ctx);
    const data = await Promise.all(
      plugins.map(async (plugin: any) => {
        const info = await getPackageInfo(ctx, plugin, locale);
        const loaded = Boolean((ctx.app as any).pm?.get?.(plugin.name) || (ctx.app as any).pm?.get?.(plugin.packageName));
        return {
          ...plugin,
          displayName: info.displayName || plugin.name,
          description: info.description || '',
          keywords: info.keywords || [],
          loaded,
          protected: isProtectedPlugin(plugin),
        };
      }),
    );

    ctx.body = {
      data,
      meta: { count: data.length },
    };
    await next();
  },

  async forceDisable(ctx: Context, next: () => Promise<void>) {
    const payload = getPayload(ctx);
    const plugin = await findPlugin(ctx, payload.name || payload.packageName || ctx.action.params.filterByTk);
    if (isProtectedPlugin(plugin)) {
      ctx.throw(400, `Plugin "${pluginDisplayName(plugin)}" is protected and cannot be disabled from Cluster Manager.`);
    }

    const repo = ctx.db.getRepository('applicationPlugins');
    await repo.update({
      filter: { name: plugin.name },
      values: { enabled: false },
    });

    const instance = (ctx.app as any).pm?.get?.(plugin.name) || (ctx.app as any).pm?.get?.(plugin.packageName);
    if (instance) {
      instance.enabled = false;
    }

    ctx.body = {
      success: true,
      name: plugin.name,
      packageName: plugin.packageName,
      restartRequired: true,
      message: `Plugin "${pluginDisplayName(plugin)}" was force disabled. Restart or reload the app to fully unload it.`,
    };
    await next();
  },

  async forceRemove(ctx: Context, next: () => Promise<void>) {
    const payload = getPayload(ctx);
    const plugin = await findPlugin(ctx, payload.name || payload.packageName || ctx.action.params.filterByTk);
    if (isProtectedPlugin(plugin)) {
      ctx.throw(400, `Plugin "${pluginDisplayName(plugin)}" is protected and cannot be removed from Cluster Manager.`);
    }

    const repo = ctx.db.getRepository('applicationPlugins');
    await repo.destroy({
      filter: { name: plugin.name },
    });

    ctx.body = {
      success: true,
      name: plugin.name,
      packageName: plugin.packageName,
      restartRequired: true,
      message: `Plugin "${pluginDisplayName(plugin)}" was force removed from the application registry. Package files were not deleted.`,
    };
    await next();
  },
};
