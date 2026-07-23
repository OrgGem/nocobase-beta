import type { Context, Next } from '@nocobase/actions';
import { AppSupervisor } from '@nocobase/server';
import { OIDCAuth } from '../oidc-auth';
import { appendInternalQuery, consumeTransaction, normalizeInternalRedirect } from '../security';

function publicPrefix(appName: string) {
  let prefix = process.env.APP_PUBLIC_PATH || '';
  if (appName !== 'main' && AppSupervisor.getInstance()?.runningMode !== 'single') prefix += `apps/${appName}`;
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'OIDC authentication failed';
}

export const redirect = async (ctx: Context, next: Next) => {
  const state = typeof ctx.action.params.state === 'string' ? ctx.action.params.state : '';
  const transaction = state ? await consumeTransaction(ctx, state) : null;
  if (!transaction) {
    ctx.redirect(appendInternalQuery('/signin', { error: 'OIDC login transaction is invalid or expired' }));
    await next();
    return;
  }

  const prefix = publicPrefix(transaction.app);
  const returnTo = normalizeInternalRedirect(transaction.returnTo);
  ctx.state.oidcTransaction = transaction;
  try {
    const auth = (await ctx.app.authManager.get(transaction.authenticator, ctx)) as OIDCAuth;
    const { token } = await auth.signIn();
    ctx.redirect(
      `${prefix}${appendInternalQuery(returnTo, {
        authenticator: transaction.authenticator,
        token,
      })}`,
    );
  } catch (error) {
    ctx.logger.error('OIDC auth error', { error });
    ctx.redirect(
      `${prefix}${appendInternalQuery('/signin', {
        redirect: returnTo,
        authenticator: transaction.authenticator,
        error: errorMessage(error),
      })}`,
    );
  }
  await next();
};
