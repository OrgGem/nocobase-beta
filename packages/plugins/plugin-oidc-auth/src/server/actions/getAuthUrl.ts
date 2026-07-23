import type { Context, Next } from '@nocobase/actions';
import { OIDCAuth } from '../oidc-auth';

export const getAuthUrl = async (ctx: Context, next: Next) => {
  const auth = ctx.auth as OIDCAuth;
  ctx.body = await auth.createAuthorizationUrl(ctx.action.params.values?.redirect);
  await next();
};
