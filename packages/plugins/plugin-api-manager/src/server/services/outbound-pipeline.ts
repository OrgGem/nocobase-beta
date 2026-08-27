import type { Application } from '@nocobase/server';
import { encryptPayload } from './crypto-adapter';
import { buildForwardHeaders, type StaticHeader } from './header-rules';
import { buildHmacHeaders } from './hmac-signer';
import { signJwt, type JwtAlgorithm } from './jwt';
import { resolveHmacSecret, resolveJwtSecret, resolveJwtSignPrivateKey } from './jwt-keys';

export interface OutboundForwardConfig {
  headers: Record<string, string>;
  body: Buffer;
  contentType: string | undefined;
}

interface RouteLike {
  get(name: string): unknown;
}

function routeNumber(route: RouteLike, name: string, fallback: number): number {
  const value = route.get(name);
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function routeString(route: RouteLike, name: string): string | undefined {
  const value = route.get(name);
  return value == null || value === '' ? undefined : String(value);
}

export interface BuildOutboundForwardRequestOptions {
  /** Plaintext body before any encryption. */
  body: Buffer;
  contentType?: string;
  /**
   * Full target URL (target + appended query string). Used both as the
   * forwarding destination and as the source of the HMAC canonical path.
   */
  forwardUrl: string;
  incomingHeaders?: Record<string, string | string[] | undefined>;
  forwardHeaders?: string[];
  staticHeaders?: StaticHeader[];
}

/**
 * Builds the outbound forwarding config (encrypted body + final headers with
 * HMAC/JWT signing) exactly as the gateway applies it. Shared by the gateway
 * router and the admin "test route" resource so the two cannot drift.
 */
export async function buildOutboundForwardRequest(
  app: Application,
  route: RouteLike,
  options: BuildOutboundForwardRequestOptions,
): Promise<OutboundForwardConfig> {
  const { body, contentType, forwardUrl } = options;

  let outgoingBody = body;
  let outgoingContentType = contentType;
  const mode = routeString(route, 'encryptionMode') ?? 'none';
  if (mode !== 'none') {
    const encrypted = await encryptPayload(app, route, body, contentType);
    outgoingBody = encrypted.body;
    outgoingContentType = encrypted.contentType ?? contentType;
  }

  const headers = buildForwardHeaders({
    incoming: options.incomingHeaders ?? {},
    forwardHeaders: options.forwardHeaders ?? [],
    staticHeaders: options.staticHeaders ?? [],
    contentType: outgoingContentType,
  });

  // NOTE: HMAC signing happens AFTER encryption, so the HMAC signature covers the
  // encrypted payload, not the plaintext. This is by design — the partner verifies
  // the HMAC on the ciphertext before decrypting, preventing tampering with the
  // encrypted blob in transit.
  if (route.get('hmacSignEnabled')) {
    const hmacSecret = await resolveHmacSecret(app, route);
    const targetUrl = new URL(forwardUrl);
    const hmacHeaders = buildHmacHeaders({
      secret: hmacSecret,
      method: routeString(route, 'method') ?? 'POST',
      path: targetUrl.pathname + targetUrl.search,
      body: outgoingBody,
    });
    Object.assign(headers, hmacHeaders);
  }

  if (route.get('jwtSignEnabled')) {
    const algorithm = (routeString(route, 'jwtSignAlgorithm') ?? 'RS256') as JwtAlgorithm;
    let secret: string | undefined;
    let privateKeyPem: string | undefined;
    if (algorithm === 'HS256') {
      secret = await resolveJwtSecret(app, route);
    } else {
      privateKeyPem = await resolveJwtSignPrivateKey(app, route);
    }
    const token = signJwt({
      algorithm,
      secret,
      privateKeyPem,
      issuer: routeString(route, 'jwtIssuer'),
      audience: routeString(route, 'jwtAudience'),
      expiresInSec: routeNumber(route, 'jwtExpiresInSec', 300),
    });
    headers.Authorization = `Bearer ${token}`;
  }

  return { headers, body: outgoingBody, contentType: outgoingContentType };
}


