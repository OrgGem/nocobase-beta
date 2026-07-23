import { AuthConfig, BaseAuth } from '@nocobase/auth';
import type { Model } from '@nocobase/database';
import { AuthModel } from '@nocobase/plugin-auth';
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  buildEndSessionUrl,
  calculatePKCECodeChallenge,
  ClientSecretBasic,
  ClientSecretPost,
  discovery,
  fetchUserInfo,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import type { Configuration } from 'openid-client';
import { logoutCookieName } from '../constants';
import {
  createRoutedState,
  isSecureRequest,
  logoutIdTokenCookieName,
  normalizeInternalRedirect,
  storeTransaction,
} from './security';
import type { OidcTransaction } from './security';

type OidcOptions = {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
  postLogoutRedirectUri?: string;
  tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post';
  idTokenSignedResponseAlg?: string;
  fieldMap?: Array<{ source?: string; target?: string }>;
  userBindField?: 'email' | 'username' | 'none';
  bindExistingUserByEmail?: boolean;
  requireVerifiedEmail?: boolean;
  allowSignupWithUnverifiedEmail?: boolean;
  storeUnverifiedEmailInProfile?: boolean;
  trustedEmailDomains?: string[] | string;
  logout?: boolean;
  http?: boolean;
  port?: number;
};

type Claims = Record<string, unknown>;

const PROTECTED_USER_FIELDS = new Set([
  'id',
  'password',
  'roles',
  'createdAt',
  'updatedAt',
  'createdById',
  'updatedById',
]);

function stringClaim(claims: Claims, key: string) {
  return typeof claims[key] === 'string' ? claims[key] : undefined;
}

function scalarClaim(value: unknown): string | number | boolean | null | undefined {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? (value as string | number | boolean | null)
    : undefined;
}

function normalizeDomains(value: OidcOptions['trustedEmailDomains']) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  return items.map((item) => item.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}

export function validateEmailClaims(claims: Claims, options: OidcOptions) {
  const email = stringClaim(claims, 'email');
  if (!email) return;
  const trustedDomains = normalizeDomains(options.trustedEmailDomains);
  const domain = email.split('@').pop()?.toLowerCase();
  if (trustedDomains.length && (!domain || !trustedDomains.includes(domain))) {
    throw new Error('The email domain is not allowed');
  }
}

export class OIDCAuth extends BaseAuth {
  constructor(config: AuthConfig) {
    super({ ...config, userCollection: config.ctx.db.getCollection('users') });
  }

  getOptions(): OidcOptions {
    return this.options?.oidc || {};
  }

  getRedirectUri() {
    const configured = this.getOptions().redirectUri;
    if (configured) {
      const url = new URL(configured);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OIDC redirect URI must use HTTP or HTTPS');
      return url.toString();
    }
    const { http, port } = this.getOptions();
    const forwardedProto = this.ctx.headers?.['x-forwarded-proto'];
    const requestProtocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || this.ctx.protocol;
    const protocol = http ? 'http' : requestProtocol || 'https';
    const host = port ? `${this.ctx.hostname}:${port}` : this.ctx.host;
    const apiBasePath = process.env.API_BASE_PATH || '/api/';
    return `${protocol}://${host}${apiBasePath}oidc:redirect`;
  }

  private async createConfiguration(): Promise<Configuration> {
    const { issuer, clientId, clientSecret, tokenEndpointAuthMethod, idTokenSignedResponseAlg } = this.getOptions();
    if (!issuer || !clientId || !clientSecret) throw new Error('OIDC issuer, client ID and client secret are required');
    const clientAuth =
      tokenEndpointAuthMethod === 'client_secret_post'
        ? ClientSecretPost(clientSecret)
        : ClientSecretBasic(clientSecret);
    return discovery(
      new URL(issuer),
      clientId,
      {
        client_secret: clientSecret,
        redirect_uris: [this.getRedirectUri()],
        response_types: ['code'],
        id_token_signed_response_alg: idTokenSignedResponseAlg || 'RS256',
      },
      clientAuth,
    );
  }

  async createAuthorizationUrl(returnTo: unknown) {
    const config = await this.createConfiguration();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const nonce = randomNonce();
    const state = createRoutedState(this.ctx.app.name);
    const browserBinding = randomState();
    const redirectUri = this.getRedirectUri();
    const authenticator = String(this.ctx.headers['x-authenticator'] || '');
    if (!authenticator) throw new Error('Missing X-Authenticator header');
    const transaction: OidcTransaction = {
      app: this.ctx.app.name,
      authenticator,
      browserBinding,
      codeVerifier,
      createdAt: Date.now(),
      nonce,
      redirectUri,
      returnTo: normalizeInternalRedirect(returnTo),
      state,
    };
    await storeTransaction(this.ctx, transaction);
    return buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.getOptions().scope || 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
  }

  private transaction() {
    return this.ctx.state.oidcTransaction as OidcTransaction | undefined;
  }

  private callbackUrl(transaction: OidcTransaction) {
    const url = new URL(transaction.redirectUri);
    for (const key of ['code', 'state', 'iss', 'error', 'error_description']) {
      const value = this.ctx.action.params[key];
      if (typeof value === 'string') url.searchParams.set(key, value);
    }
    return url;
  }

  private assertEmailPolicy(claims: Claims) {
    try {
      validateEmailClaims(claims, this.getOptions());
    } catch (error) {
      if (error instanceof Error && error.message === 'The identity provider did not verify this email address') {
        throw this.translatedError('The identity provider did not verify this email address.');
      }
      if (error instanceof Error && error.message === 'The email domain is not allowed') {
        throw this.translatedError('The email domain is not allowed.');
      }
      throw error;
    }
  }

  private translatedError(message: string) {
    return new Error(this.ctx.t(message, { ns: 'plugin-oidc-plus' }));
  }

  private buildUserFields(claims: Claims) {
    const fields: Record<string, string | number | boolean | null> = {};
    const defaults: Array<[string, string]> = [
      ['username', 'preferred_username'],
      ['nickname', 'nickname'],
      ['email', 'email'],
      ['phone', 'phone_number'],
      ['appLang', 'locale'],
    ];
    for (const [target, source] of defaults) {
      const value = scalarClaim(claims[target] ?? claims[source]);
      if (value !== undefined) fields[target] = value;
    }
    if (!fields.nickname) {
      fields.nickname =
        stringClaim(claims, 'name') ||
        stringClaim(claims, 'preferred_username') ||
        stringClaim(claims, 'sub') ||
        'OIDC user';
    }
    for (const mapping of this.getOptions().fieldMap || []) {
      const source = mapping.source?.trim();
      const target = mapping.target?.trim();
      if (!source || !target || PROTECTED_USER_FIELDS.has(target) || !this.userCollection.getField(target)) continue;
      const value = scalarClaim(claims[source]);
      if (value !== undefined) fields[target] = value;
    }
    return fields;
  }

  private async updateUser(user: Model, userFields: Record<string, string | number | boolean | null>) {
    await this.userRepository.update({ filter: { id: user.get('id') }, values: userFields });
  }

  private async provisionUser(claims: Claims) {
    const issuer = stringClaim(claims, 'iss') || this.getOptions().issuer;
    const subject = stringClaim(claims, 'sub');
    if (!issuer || !subject) throw new Error('OIDC response is missing issuer or subject');
    const identityKey = `${issuer}|${subject}`;
    const authenticator = this.authenticator as AuthModel;
    const userFields = this.buildUserFields(claims);
    const user = await authenticator.findUser(identityKey);
    if (user) {
      // An existing issuer+sub link is already the authentication identity.
      // Email verification is required only when provisioning or linking it.
      await this.updateUser(user, userFields);
      return user;
    }

    this.assertEmailPolicy(claims);

    const email = stringClaim(claims, 'email');
    // Older versions exposed `username`. Treat that stored value as the safe
    // verified-email mode now that username-based account linking is removed.
    const userBindField = this.getOptions().userBindField === 'none' ? 'none' : 'email';
    if (email) {
      const emailUser = await this.userRepository.findOne({ filter: { email } });
      if (emailUser) {
        if (this.getOptions().bindExistingUserByEmail === false || userBindField !== 'email') {
          throw this.translatedError(
            'A NocoBase account already uses this email, but automatic verified-email linking is disabled.',
          );
        }
        await this.updateUser(emailUser, userFields);
        await authenticator.addUser(emailUser.get('id'), { through: { uuid: identityKey } });
        return emailUser;
      }
    }

    if (!this.options?.public?.autoSignup) {
      throw this.translatedError('Automatic OIDC user signup is disabled.');
    }
    const username = typeof userFields.username === 'string' ? userFields.username : undefined;
    if (username) {
      const existingUsername = await this.userRepository.findOne({ filter: { username } });
      if (!this.validateUsername(username) || existingUsername) delete userFields.username;
    }
    return authenticator.newUser(identityKey, userFields);
  }

  async validate() {
    const transaction = this.transaction();
    if (!transaction) throw new Error('OIDC login transaction is missing');
    const config = await this.createConfiguration();
    const tokens = await authorizationCodeGrant(config, this.callbackUrl(transaction), {
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      pkceCodeVerifier: transaction.codeVerifier,
      idTokenExpected: true,
    });
    const idTokenClaims = tokens.claims();
    if (!idTokenClaims?.sub) throw new Error('OIDC token response does not contain a subject');
    let claims: Claims = { ...idTokenClaims };
    if (config.serverMetadata().userinfo_endpoint && tokens.access_token) {
      const userInfo = await fetchUserInfo(config, tokens.access_token, idTokenClaims.sub);
      claims = { ...claims, ...userInfo };
    }
    if (tokens.id_token) {
      this.ctx.cookies.set(logoutIdTokenCookieName(transaction.authenticator), tokens.id_token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecureRequest(this.ctx),
        overwrite: true,
      });
    }
    return this.provisionUser(claims);
  }

  async signOut() {
    const { logout, clientId } = this.getOptions();
    const authenticator = String(this.ctx.headers['x-authenticator'] || '');
    const idTokenCookie = logoutIdTokenCookieName(authenticator);
    const idToken = this.ctx.cookies.get(idTokenCookie);
    this.ctx.cookies.set(idTokenCookie, null, { overwrite: true });
    if (logout) {
      const config = await this.createConfiguration();
      if (config.serverMetadata().end_session_endpoint) {
        const redirectUri = this.getRedirectUri();
        const origin = new URL(redirectUri).origin;
        const configuredPostLogout = this.getOptions().postLogoutRedirectUri;
        const postLogoutRedirectUri =
          configuredPostLogout || new URL(process.env.APP_PUBLIC_PATH || '/signin', origin).toString();
        const logoutUrl = buildEndSessionUrl(config, {
          client_id: clientId || '',
          ...(idToken ? { id_token_hint: idToken } : {}),
          post_logout_redirect_uri: postLogoutRedirectUri,
          state: randomState(),
        });
        this.ctx.cookies.set(logoutCookieName, logoutUrl.toString(), {
          httpOnly: false,
          sameSite: 'lax',
          secure: isSecureRequest(this.ctx),
          overwrite: true,
          maxAge: 5 * 60 * 1000,
        });
      }
    }
    return super.signOut();
  }
}
