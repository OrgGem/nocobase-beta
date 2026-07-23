import { describe, expect, it } from 'vitest';
import { validateEmailClaims } from '../oidc-auth';

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

  it('enforces the trusted email-domain allowlist independently of verification', () => {
    expect(() =>
      validateEmailClaims(
        { email: 'user@outside.example', email_verified: true },
        { trustedEmailDomains: 'example.com, subsidiary.example' },
      ),
    ).toThrow('The email domain is not allowed');
  });

});
