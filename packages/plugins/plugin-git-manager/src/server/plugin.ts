import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import * as gitActions from './actions/git-actions';

export class PluginGitManagerServer extends Plugin {
  async load() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    this.app.resourceManager.define({
      name: 'gitManager',
      actions: {
        clone: gitActions.clone,
        pull: gitActions.pull,
        push: gitActions.push,
        fetch: gitActions.fetch,
        diff: gitActions.diff,
        status: gitActions.status,
        log: gitActions.log,
        branches: gitActions.branches,
        checkout: gitActions.checkout,
        fileTree: gitActions.fileTree,
        fileContent: gitActions.fileContent,
        commitDetail: gitActions.commitDetail,
      },
    });

    // Read-only operations available to all plugin users
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.read`,
      actions: [
        'gitRepositories:list',
        'gitRepositories:get',
        'gitManager:status',
        'gitManager:log',
        'gitManager:branches',
        'gitManager:diff',
        'gitManager:fileTree',
        'gitManager:fileContent',
        'gitManager:commitDetail',
      ],
    });

    // Write operations require separate permission
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.write`,
      actions: [
        'gitRepositories:create',
        'gitRepositories:update',
        'gitRepositories:destroy',
        'gitManager:clone',
        'gitManager:pull',
        'gitManager:push',
        'gitManager:fetch',
        'gitManager:checkout',
      ],
    });

    // Strip PAT from API responses — scoped to gitRepositories only
    this.app.resourceManager.use(async (ctx, next) => {
      if (ctx.action?.resourceName !== 'gitRepositories') {
        return next();
      }
      await next();
      if (ctx.body) {
        const items = Array.isArray(ctx.body) ? ctx.body : ctx.body?.data ? (Array.isArray(ctx.body.data) ? ctx.body.data : [ctx.body.data]) : [ctx.body];
        items.forEach((item) => {
          if (item && typeof item === 'object') {
            if (item.pat) item.pat = '••••••••';
            if (item.dataValues?.pat) item.dataValues.pat = '••••••••';
          }
        });
      }
    });
  }

  async install() {}
}

export default PluginGitManagerServer;
