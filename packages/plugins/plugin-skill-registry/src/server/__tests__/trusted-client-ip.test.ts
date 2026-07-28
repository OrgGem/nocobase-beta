import { resolveTrustedClientIp } from '../services/trusted-client-ip';

function context(remoteAddress: string, forwarded: string) {
  return {
    req: { socket: { remoteAddress } },
    get(name: string) {
      return name.toLowerCase() === 'x-forwarded-for' ? forwarded : '';
    },
    state: {},
  };
}

describe('trusted client IP resolution', () => {
  const originalRules = process.env.SKILL_REGISTRY_TRUST_PROXY_CIDRS;

  afterEach(() => {
    if (originalRules === undefined) {
      delete process.env.SKILL_REGISTRY_TRUST_PROXY_CIDRS;
    } else {
      process.env.SKILL_REGISTRY_TRUST_PROXY_CIDRS = originalRules;
    }
  });

  it('ignores spoofed forwarded headers from an untrusted peer', () => {
    process.env.SKILL_REGISTRY_TRUST_PROXY_CIDRS = '10.0.0.0/8';

    expect(resolveTrustedClientIp(context('203.0.113.9', '198.51.100.20'))).toBe('203.0.113.9');
  });

  it('selects the first untrusted client hop behind a trusted proxy', () => {
    process.env.SKILL_REGISTRY_TRUST_PROXY_CIDRS = '10.0.0.0/8';

    expect(resolveTrustedClientIp(context('10.0.0.5', '198.51.100.20, 10.0.0.4'))).toBe('198.51.100.20');
  });
});
