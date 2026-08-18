export interface StaticHeader {
  name: string;
  value: string;
}

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
]);

export interface BuildForwardHeadersOptions {
  incoming: Record<string, string | string[] | undefined>;
  forwardHeaders?: string[];
  staticHeaders?: StaticHeader[];
  contentType?: string;
}

export function buildForwardHeaders(options: BuildForwardHeadersOptions): Record<string, string> {
  const { incoming, forwardHeaders, staticHeaders, contentType } = options;
  const result: Record<string, string> = {};

  const allowlist =
    Array.isArray(forwardHeaders) && forwardHeaders.length > 0
      ? new Set(forwardHeaders.map((h) => h.trim().toLowerCase()).filter(Boolean))
      : null;

  for (const [rawName, rawValue] of Object.entries(incoming)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    if (allowlist && !allowlist.has(name)) continue;
    if (rawValue == null) continue;
    result[name] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }

  if (contentType) {
    result['content-type'] = contentType;
  }

  if (Array.isArray(staticHeaders)) {
    for (const header of staticHeaders) {
      if (!header || typeof header.name !== 'string' || !header.name.trim()) continue;
      result[header.name.trim().toLowerCase()] = String(header.value ?? '');
    }
  }

  return result;
}
