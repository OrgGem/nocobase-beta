import { isIP } from 'net';

type RequestContext = {
  req?: { socket?: { remoteAddress?: string } };
  get(name: string): string;
  state: Record<string, unknown>;
};

function normalizeIp(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

function parseIpv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => part > 255)) {
    return null;
  }
  return (((numbers[0] << 24) >>> 0) | (numbers[1] << 16) | (numbers[2] << 8) | numbers[3]) >>> 0;
}

function parseIpv6(value: string): bigint | null {
  const normalized = value.toLowerCase();
  if (normalized.includes('.')) {
    return null;
  }
  const pieces = normalized.split('::');
  if (pieces.length > 2) {
    return null;
  }
  const before = pieces[0] ? pieces[0].split(':') : [];
  const after = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  if (before.length + after.length > 8 || [...before, ...after].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  const sections = [...before, ...Array(Math.max(0, 8 - before.length - after.length)).fill('0'), ...after];
  if (sections.length !== 8) {
    return null;
  }
  return sections.reduce((result, section) => (result << 16n) | BigInt(`0x${section}`), 0n);
}

function matchesCidr(ip: string, rule: string): boolean {
  const [rawNetwork, rawPrefix] = rule.split('/');
  if (!rawPrefix) {
    return ip === normalizeIp(rawNetwork);
  }
  const prefix = Number(rawPrefix);
  const version = isIP(ip);
  if (version === 4 && isIP(rawNetwork) === 4 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
    const address = parseIpv4(ip);
    const network = parseIpv4(rawNetwork);
    if (address === null || network === null) {
      return false;
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) === (network & mask);
  }
  if (version === 6 && isIP(rawNetwork) === 6 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 128) {
    const address = parseIpv6(ip);
    const network = parseIpv6(rawNetwork);
    if (address === null || network === null) {
      return false;
    }
    const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
    return (address & mask) === (network & mask);
  }
  return false;
}

function trustedRules(): string[] {
  return String(process.env.SKILL_REGISTRY_TRUST_PROXY_CIDRS || '')
    .split(',')
    .map((rule) => rule.trim())
    .filter(Boolean);
}

function isTrusted(ip: string): boolean {
  return trustedRules().some((rule) => matchesCidr(ip, rule));
}

function validIp(value: string): string | null {
  const normalized = normalizeIp(value);
  return isIP(normalized) ? normalized : null;
}

export function resolveTrustedClientIp(ctx: RequestContext): string {
  const remoteAddress = validIp(ctx.req?.socket?.remoteAddress || '');
  if (!remoteAddress) {
    return 'unknown';
  }
  if (!isTrusted(remoteAddress)) {
    return remoteAddress;
  }
  const forwarded = ctx.get('x-forwarded-for');
  const candidates = forwarded
    .split(',')
    .map((value) => validIp(value))
    .filter((value): value is string => Boolean(value));
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (!isTrusted(candidates[index])) {
      return candidates[index];
    }
  }
  return candidates[0] || remoteAddress;
}

export function attachTrustedClientIp(ctx: RequestContext): string {
  const ip = resolveTrustedClientIp(ctx);
  ctx.state.skillRegistryClientIp = ip;
  return ip;
}
