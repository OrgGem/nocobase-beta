import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { createProxyMiddleware, invalidateProxyCache } from './middleware/proxy-pass';
import { createFetchPageAction } from './actions/fetch-page';

export class PluginBlockProxyServer extends Plugin {
  async load() {
    // Register collection
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    // Register reverse-proxy middleware (before resourcer so it can intercept /proxy/*)
    this.app.use(createProxyMiddleware(this.db), { before: 'resourcer' });

    // Invalidate proxy cache on any change to proxyServices
    this.db.on('proxyServices.afterCreate', () => invalidateProxyCache());
    this.db.on('proxyServices.afterUpdate', () => invalidateProxyCache());
    this.db.on('proxyServices.afterDestroy', () => invalidateProxyCache());

    // Register resource with custom fetchPage action
    this.app.resourceManager.define({
      name: 'proxyServices',
      actions: {
        fetchPage: createFetchPageAction(this.db),
      },
    });

    // ACL: admin-only full CRUD via snippet
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['proxyServices:*'],
    });

    // Read access for logged-in users (so they can see available services + fetch pages)
    this.app.acl.allow('proxyServices', ['list', 'get', 'fetchPage'], 'loggedIn');
  }

  async install() {
    // Optionally seed an example service
  }
}

export default PluginBlockProxyServer;
