import { resolve } from 'node:path';
import { Plugin } from '@nocobase/server';
import type { IdpOauthService } from '@nocobase/plugin-idp-oauth';
import {
  type ClientInput,
  COLLECTION_NAME,
  DatabaseOidcClientResolver,
  normalizeClientInput,
  serializeClient,
} from './client-service';

type IdpOauthPlugin = { service: IdpOauthService };

function valuesFromContext(ctx: { action: { params: { values?: unknown } } }) {
  return ctx.action.params.values;
}

export class PluginIdpOidcClientManagerServer extends Plugin {
  private idpService?: IdpOauthService;

  requiredPlugins() {
    return ['@nocobase/plugin-idp-oauth'];
  }

  async load() {
    await this.importCollections(resolve(__dirname, 'collections'));
    const idpPlugin = (this.app.pm.get('@nocobase/plugin-idp-oauth') || this.app.pm.get('idp-oauth')) as
      | IdpOauthPlugin
      | undefined;
    if (!idpPlugin?.service) throw new Error('@nocobase/plugin-idp-oauth must be enabled');

    this.idpService = idpPlugin.service;
    this.idpService.registerClientResolver(
      'oidc-client-manager',
      new DatabaseOidcClientResolver(this.db.getRepository(COLLECTION_NAME)),
    );

    this.app.resourceManager.define({
      name: 'oidcClientManager',
      actions: {
        list: async (ctx, next) => {
          const records = await ctx.db.getRepository(COLLECTION_NAME).find({
            filter: { clientType: 'public' },
            sort: ['name'],
          });
          ctx.body = records.map(serializeClient).filter(Boolean);
          await next();
        },
        create: async (ctx, next) => {
          let input: ClientInput;
          try {
            input = normalizeClientInput(valuesFromContext(ctx));
          } catch (error) {
            const key = error instanceof Error ? error.message : String(error);
            ctx.throw(400, ctx.t(key, { ns: this.name }));
          }
          const record = await ctx.db
            .getRepository(COLLECTION_NAME)
            .create({ values: { ...input, clientSecret: null } });
          ctx.body = serializeClient(record);
          await next();
        },
        update: async (ctx, next) => {
          const id = ctx.action.params.filterByTk;
          let input: ClientInput;
          try {
            input = normalizeClientInput(valuesFromContext(ctx));
          } catch (error) {
            const key = error instanceof Error ? error.message : String(error);
            ctx.throw(400, ctx.t(key, { ns: this.name }));
          }
          const existing = await ctx.db.getRepository(COLLECTION_NAME).findOne({ filterByTk: id });
          if (!existing || existing.clientType !== 'public') ctx.throw(404);
          await ctx.db
            .getRepository(COLLECTION_NAME)
            .update({ filterByTk: id, values: { ...input, clientSecret: null } });
          const record = await ctx.db.getRepository(COLLECTION_NAME).findOne({ filterByTk: id });
          if (!record) ctx.throw(404);
          ctx.body = serializeClient(record);
          await next();
        },
        destroy: async (ctx, next) => {
          const id = ctx.action.params.filterByTk;
          const record = await ctx.db.getRepository(COLLECTION_NAME).findOne({ filterByTk: id });
          if (!record || record.clientType !== 'public') ctx.throw(404);
          await ctx.db.getRepository(COLLECTION_NAME).destroy({ filterByTk: id });
          ctx.body = { success: true };
          await next();
        },
        providerInfo: async (ctx, next) => {
          const paths = this.idpService?.getProviderContext(ctx);
          ctx.body = paths
            ? {
                issuer: paths.issuer,
                discoveryUrl: `${paths.issuer}/.well-known/openid-configuration`,
                supportedScopes: this.idpService?.getSupportedScopes() || [],
              }
            : {};
          await next();
        },
      },
    });

    this.app.acl.registerSnippet({
      name: `pm.${this.name}.admin`,
      actions: ['oidcClientManager:*'],
    });
  }

  async remove() {
    this.idpService?.unregisterClientResolver('oidc-client-manager');
  }
}

export default PluginIdpOidcClientManagerServer;
