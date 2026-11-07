/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import type { Repository } from '@nocobase/database';
import type { IdpOauthService } from '@nocobase/plugin-idp-oauth';
import type { createLocalJWKSet } from 'jose';
import inject from 'light-my-request';

type ManagedClient = { enabled: boolean; scopes: string[] };
const namespace = 'plugin-idp-oidc-client-manager';

// This middleware protects only this manager's clients; the upstream provider remains unchanged.
export function createManagedResourceGuard(service: IdpOauthService, repository: Repository) {
  const keySets = new WeakMap<object, ReturnType<typeof createLocalJWKSet>>();
  return async (ctx: Context, next: Next) => {
    const token = ctx.getBearerToken();
    if (!token || token.split('.').length !== 3) return next();
    const { decodeJwt, createLocalJWKSet, jwtVerify } = await import('jose');
    let decoded: ReturnType<typeof decodeJwt>;
    try {
      decoded = decodeJwt(token);
    } catch {
      return next();
    }
    const context = service.getProviderContext(ctx);
    if (decoded.iss !== context.issuer || typeof decoded.client_id !== 'string') return next();
    const client = (await repository.findOne({
      filter: { clientId: decoded.client_id, clientType: 'public' },
    })) as ManagedClient | null;
    if (!client) return next();

    const provider = await service.ensureProviderForContext(ctx);
    let keys = keySets.get(provider);
    if (!keys) {
      // Read the provider's public JWKS endpoint in-process, without private methods or outbound requests.
      const response = await inject(provider.callback(), {
        method: 'GET',
        url: '/idpOAuth/jwks',
        headers: { host: new URL(context.issuer).host },
      });
      if (response.statusCode !== 200) ctx.throw(503, ctx.t('OIDC signing keys are unavailable.', { ns: namespace }));
      keys = createLocalJWKSet(response.json());
      keySets.set(provider, keys);
    }
    let payload: ReturnType<typeof decodeJwt>;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: context.issuer,
        audience: `${context.issuer.replace(/\/+$/, '')}/`,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'sub', 'client_id'],
      }));
    } catch {
      ctx.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      ctx.throw(401, ctx.t('Invalid OAuth access token.', { ns: namespace }));
    }
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
    if (!client.enabled || !client.scopes?.includes('api') || !scopes.includes('api')) {
      ctx.set('WWW-Authenticate', 'Bearer error="insufficient_scope", scope="api"');
      ctx.throw(403, ctx.t('OAuth access token has insufficient scope.', { ns: namespace }));
    }
    await next();
  };
}
