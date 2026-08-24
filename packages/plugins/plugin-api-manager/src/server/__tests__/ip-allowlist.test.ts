import { describe, expect, it } from 'vitest';
import { isIpAllowed } from '../services/ip-allowlist';

describe('isIpAllowed', () => {
  it('allows everything when the allowlist is empty', () => {
    expect(isIpAllowed('1.2.3.4', [])).toBe(true);
    expect(isIpAllowed(undefined, [])).toBe(true);
  });

  it('rejects when there is no client ip but the list is non-empty', () => {
    expect(isIpAllowed(undefined, ['10.0.0.1'])).toBe(false);
  });

  it('matches exact IPv4 addresses', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.1', '192.168.1.1'])).toBe(true);
    expect(isIpAllowed('10.0.0.2', ['10.0.0.1'])).toBe(false);
  });

  it('matches IPv4 CIDR ranges', () => {
    expect(isIpAllowed('10.0.0.5', ['10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('10.255.255.255', ['10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
    expect(isIpAllowed('192.168.1.50', ['192.168.1.0/24'])).toBe(true);
    expect(isIpAllowed('192.168.2.50', ['192.168.1.0/24'])).toBe(false);
  });

  it('handles a /32 CIDR as an exact match', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.1/32'])).toBe(true);
    expect(isIpAllowed('10.0.0.2', ['10.0.0.1/32'])).toBe(false);
  });

  it('matches exact IPv6 addresses case-insensitively', () => {
    expect(isIpAllowed('::1', ['::1'])).toBe(true);
    expect(isIpAllowed('2001:db8::1', ['2001:DB8::1'])).toBe(true);
    expect(isIpAllowed('2001:db8::2', ['2001:db8::1'])).toBe(false);
  });

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    expect(isIpAllowed('::ffff:10.0.0.1', ['10.0.0.1'])).toBe(true);
    expect(isIpAllowed('::ffff:10.0.0.1', ['10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('10.0.0.1', ['::ffff:10.0.0.1'])).toBe(true);
  });

  it('ignores whitespace and blank entries', () => {
    expect(isIpAllowed('10.0.0.1', ['  10.0.0.1  ', ''])).toBe(true);
    expect(isIpAllowed('10.0.0.2', ['  ', ''])).toBe(true);
  });

  it('rejects IPv4 octets with leading zeros (invalid addresses)', () => {
    // 010.0.0.1 is not a valid IPv4 address and must never alias 10.0.0.1.
    expect(isIpAllowed('010.0.0.1', ['010.0.0.1'])).toBe(false);
    expect(isIpAllowed('10.0.0.1', ['010.0.0.1'])).toBe(false);
    expect(isIpAllowed('10.0.0.1', ['10.0.0.1'])).toBe(true);
    expect(isIpAllowed('00.0.0.1', ['0.0.0.1'])).toBe(false);
  });

  it('rejects malformed CIDR entries safely (deny)', () => {
    expect(isIpAllowed('1.2.3.4', ['1.2.3.4/24/evil'])).toBe(false);
    expect(isIpAllowed('1.2.3.4', ['1.2.3.4/33'])).toBe(false);
    expect(isIpAllowed('1.2.3.4', ['1.2.3.4/-1'])).toBe(false);
    expect(isIpAllowed('1.2.3.4', ['/24'])).toBe(false);
    expect(isIpAllowed('1.2.3.4', ['1.2.3.4/'])).toBe(false);
  });

  it('handles a /0 CIDR as allowing the whole range', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.1/0'])).toBe(true);
    expect(isIpAllowed('192.168.1.1', ['10.0.0.1/0'])).toBe(true);
  });

  it('strips IPv6 zone ids', () => {
    expect(isIpAllowed('fe80::1%eth0', ['fe80::1'])).toBe(true);
  });
});
