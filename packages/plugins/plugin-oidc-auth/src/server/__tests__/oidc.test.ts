/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { OIDCAuth, validateEmailClaims } from '../oidc-auth';

describe('OIDC client authentication configuration', () => {
  it.each([undefined, 'client_secret_basic', 'client_secret_post'])(
    'preserves the confidential-client secret requirement for method %s',
    async (method) => {
      const auth = Object.create(OIDCAuth.prototype) as OIDCAuth;
      Object.defineProperties(auth, {
        options: {
          value: { oidc: { issuer: 'https://idp.example.com', clientId: 'client', tokenEndpointAuthMethod: method } },
        },
        ctx: { value: { t: (key: string) => key } },
      });
      await expect(auth.createAuthorizationUrl('/admin')).rejects.toThrow('A client secret is required');
    },
  );
});

describe('OIDC email policy', () => {
  it('trusts the configured identity provider when email_verified is absent', () => {
    expect(() => validateEmailClaims({ email: 'user@example.com' }, {})).not.toThrow();
  });

  it('allows an unverified email for new-user provisioning when explicitly configured', () => {
    expect(() =>
      validateEmailClaims({ email: 'user@example.com', email_verified: false }, { requireVerifiedEmail: false }),
    ).not.toThrow();
  });

  it('accepts a verified email', () => {
    expect(() => validateEmailClaims({ email: 'user@example.com', email_verified: true }, {})).not.toThrow();
  });

  it.each([false, undefined, 'true'])('requires a boolean verified claim when configured: %s', (verified) => {
    expect(() =>
      validateEmailClaims({ email: 'user@example.com', email_verified: verified }, { requireVerifiedEmail: true }),
    ).toThrow('The identity provider did not verify this email address');
  });

  it('enforces the trusted email-domain allowlist independently of verification', () => {
    expect(() =>
      validateEmailClaims(
        { email: 'user@outside.example', email_verified: true },
        { trustedEmailDomains: 'example.com, subsidiary.example' },
      ),
    ).toThrow('The email domain is not allowed');
  });
});

describe('OIDC account linking', () => {
  function fixture(options: { verified?: unknown; linked?: boolean; existing?: boolean } = {}) {
    const user = { get: (key: string) => (key === 'id' ? 99 : undefined) };
    const authenticator = {
      findUser: vi.fn().mockResolvedValue(options.linked ? user : null),
      addUser: vi.fn(),
      newUser: vi.fn().mockResolvedValue(user),
    };
    const repository = {
      findOne: vi.fn().mockResolvedValue(options.existing === false ? null : user),
      update: vi.fn(),
    };
    const auth = Object.create(OIDCAuth.prototype) as OIDCAuth;
    Object.defineProperties(auth, {
      options: { value: { oidc: { requireVerifiedEmail: false }, public: { autoSignup: true } } },
      authenticator: { value: authenticator },
      userRepository: { value: repository },
      ctx: { value: { t: (message: string) => message } },
    });
    const claims = {
      iss: 'https://idp.example.com',
      sub: 'new-subject',
      email: 'existing@example.com',
      email_verified: options.verified,
    };
    const run = () =>
      (auth as unknown as { provisionUser: (claims: Record<string, unknown>) => Promise<unknown> }).provisionUser(
        claims,
      );
    return { run, user, authenticator, repository };
  }

  it.each([false, undefined, 'true'])(
    'never links an unverified email even when signup permits it: %s',
    async (verified) => {
      const { run, authenticator, repository } = fixture({ verified });
      await expect(run()).rejects.toThrow('The identity provider did not verify this email address.');
      expect(authenticator.addUser).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    },
  );

  it('links an existing account only after email verification', async () => {
    const { run, user, authenticator } = fixture({ verified: true });
    await expect(run()).resolves.toBe(user);
    expect(authenticator.addUser).toHaveBeenCalledWith(99, {
      through: { uuid: 'https://idp.example.com|new-subject' },
    });
  });

  it('keeps an already-linked issuer/subject usable without a new email claim', async () => {
    const { run, user, authenticator } = fixture({ linked: true });
    await expect(run()).resolves.toBe(user);
    expect(authenticator.addUser).not.toHaveBeenCalled();
  });

  it('keeps explicit unverified-email signup separate from existing-account linking', async () => {
    const { run, authenticator } = fixture({ existing: false, verified: false });
    await run();
    expect(authenticator.newUser).toHaveBeenCalled();
    expect(authenticator.addUser).not.toHaveBeenCalled();
  });
});
