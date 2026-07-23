import { Gateway, Plugin } from '@nocobase/server';
import { getAuthUrl } from './actions/getAuthUrl';
import { redirect } from './actions/redirect';
import { authType } from '../constants';
import { OIDCAuth } from './oidc-auth';
import { readAppHint } from './security';

export class PluginOIDCServer extends Plugin {
  async load() {
    this.app.authManager.registerTypes(authType, {
      auth: OIDCAuth,
      getPublicOptions(options) {
        return {
          autoLoginRedirect: options?.oidc?.autoLoginRedirect,
          buttonStyle: options?.oidc?.buttonStyle,
        };
      },
    });

    this.app.resourceManager.define({
      name: 'oidc',
      actions: {
        getAuthUrl,
        redirect,
      },
    });

    this.app.acl.allow('oidc', '*', 'public');

    /* istanbul ignore next -- @preserve */
    Gateway.getInstance().addAppSelectorMiddleware(async (ctx, next) => {
      const { req } = ctx;
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = url.searchParams;
      const state = params.get('state');
      if (!state) {
        return next();
      }
      const appName = readAppHint(state);
      if (appName) {
        ctx.resolvedAppName = appName;
      }
      await next();
    });
  }
}

export default PluginOIDCServer;
