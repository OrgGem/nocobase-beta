/**
 * IP allowlist matching supporting exact IPv4/IPv6 and IPv4 CIDR ranges.
 * An empty allowlist allows everything. IPv4-mapped IPv6 addresses
 * (::ffff:a.b.c.d) are normalized to their IPv4 form.
 */

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  // Strip an IPv6 zone id if present (e.g. fe80::1%eth0).
  const zoneIdx = trimmed.indexOf('%');
  const withoutZone = zoneIdx >= 0 ? trimmed.slice(0, zoneIdx) : trimmed;
  // Unwrap IPv4-mapped IPv6 addresses.
  if (withoutZone.toLowerCase().startsWith('::ffff:')) {
    const candidate = withoutZone.slice(7);
    if (isIpv4(candidate)) return candidate;
  }
  return withoutZone;
}

function isIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    // Reject leading zeros ("010") — they are not valid IPv4 octets and
    // silently parsing them would alias 10.0.0.1 to 010.0.0.1.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false;
    const num = Number(part);
    return num <= 255;
  });
}

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function matchesIpv4Cidr(ip: string, cidr: string): boolean {
  const parts = cidr.split('/');
  // Exactly one "/" — "1.2.3.4/24/evil" must not be interpreted.
  if (parts.length !== 2) return false;
  const [range, bitsRaw] = parts;
  const bits = Number(bitsRaw);
  if (!isIpv4(range) || !/^\d{1,2}$/.test(bitsRaw) || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(range) & mask);
}

export function isIpAllowed(ip: string | undefined, allowlist: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (!ip) return false;

  const normalized = normalizeIp(ip);
  const normalizedList = allowlist.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (normalizedList.length === 0) return true;

  for (const entry of normalizedList) {
    if (entry.includes('/')) {
      if (isIpv4(normalized) && matchesIpv4Cidr(normalized, entry)) return true;
      continue;
    }
    // Exact match. A dotted entry is IPv4-shaped: reject invalid ones (e.g.
    // leading zeros) so they can never match — and never let a malformed
    // entry silently drop the list down to "allow all".
    const entryNormalized = normalizeIp(entry);
    if (entryNormalized.includes('.') && !isIpv4(entryNormalized)) {
      continue;
    }
    if (entryNormalized.toLowerCase() === normalized.toLowerCase()) {
      return true;
    }
  }
  return false;
}
