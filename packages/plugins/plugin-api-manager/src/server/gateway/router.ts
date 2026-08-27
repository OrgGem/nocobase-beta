import { randomUUID } from 'crypto';
import type { Context, Middleware } from 'koa';
import type { Application } from '@nocobase/server';
import type { Model } from '@nocobase/database';
import {
  DEFAULT_MAX_BODY_MB,
  DEFAULT_TIMEOUT_MS,
  ERROR_CODES,
  INBOUND_PREFIX,
  OUTBOUND_PREFIX,
  type RouteDirection,
} from '../../constants';
import { authenticateApiKey, authenticateBearerToken, type AuthResult } from './auth';
import { getRawBodyBuffer } from './body';
import { sha256Hex as sha256 } from '../services/hash';
import { decryptPayload, encryptPayload } from '../services/crypto-adapter';
import { buildForwardHeaders, type StaticHeader } from '../services/header-rules';
import { buildOutboundForwardRequest } from '../services/outbound-pipeline';
import { ApimError } from '../services/errors';
import { NonceCache, verifyHmacHeaders } from '../services/hmac-signer';
import { isIpAllowed } from '../services/ip-allowlist';
import { verifyJwt, type JwtAlgorithm } from '../services/jwt';
import { resolveHmacSecret, resolveJwtSecret, resolveJwtVerifyPublicKey } from '../services/jwt-keys';
import { forwardRequest } from '../services/proxy-engine';
import { FixedWindowRateLimiter } from '../services/rate-limiter';
import { CapacityLimiter, type CapacityLease } from '../services/capacity-limiter';
import { CircuitBreaker, circuitOpenError } from '../services/circuit-breaker';
import { resolveGatewaySettings } from '../services/gateway-settings';
import { capPayload, writeRequestLog } from '../services/request-logger';
import { resolveGatewayRoute } from '../services/route-resolver';
import { canRoleCallRoute } from '../services/acl';
type GatewayContext = Context & { withoutDataWrapping?: boolean };
function sniffContentType(body: Buffer): string {
  for (const byte of body) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte === 0x7b || byte === 0x5b) return 'application/json';
    if (byte === 0x3c) return 'application/xml';
    return 'application/octet-stream';
  }
  return 'application/octet-stream';
}
function toNumber(value: unknown, fallback: number): number {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function toApimError(error: unknown): ApimError {
  if (error instanceof ApimError) return error;
  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === 'number') {
    const code = statusCode === 413 ? ERROR_CODES.BODY_TOO_LARGE : ERROR_CODES.UPSTREAM_ERROR;
    return new ApimError(code, (error as Error).message, statusCode);
  }
  return new ApimError(ERROR_CODES.UPSTREAM_ERROR, (error as Error)?.message ?? 'Internal gateway error', 502);
}
// Upstream error details (axios messages) can contain internal hostnames, DNS
// errors, or URLs, so the gateway response carries a generic message and the
// detail is only written to the server log and the request log.
const GENERIC_ERROR_MESSAGES: Partial<Record<string, string>> = {
  [ERROR_CODES.UPSTREAM_ERROR]: 'Upstream request failed',
  [ERROR_CODES.TIMEOUT]: 'Upstream request timed out',
};
export interface ApimRuntimeState {
  capacityLimiter: CapacityLimiter;
  circuitBreaker: CircuitBreaker;
}

export function createApimRouter(app: Application, state?: ApimRuntimeState): Middleware {
  const nonceCache = new NonceCache();
  const rateLimiter = new FixedWindowRateLimiter();
  const capacityLimiter =
    state?.capacityLimiter ??
    new CapacityLimiter({
      maxConcurrentRequests: 50,
      maxTotalBytes: 512 * 1024 * 1024,
      maxRequestBytes: 0,
      queueEnabled: true,
      queueSize: 1000,
      queueTimeoutMs: 30_000,
    });
  const circuitBreaker = state?.circuitBreaker ?? new CircuitBreaker();
  return async function apimRouter(ctx: GatewayContext, next) {
    const path = ctx.path;
    let direction: RouteDirection | null = null;
    let pathOrName = '';
    if (path.startsWith(INBOUND_PREFIX)) {
      direction = 'inbound';
      pathOrName = path.slice(INBOUND_PREFIX.length).replace(/\/+$/, '');
    } else if (path.startsWith(OUTBOUND_PREFIX)) {
      direction = 'outbound';
      pathOrName = path.slice(OUTBOUND_PREFIX.length);
    }
    if (!direction || !pathOrName) {
      return next();
    }
    ctx.withoutDataWrapping = true;
    const requestId = randomUUID();
    ctx.set('X-Request-Id', requestId);
    const startedAt = new Date();
    let route: Model | null = null;
    let auth: AuthResult | null = null;
    let capacityLease: CapacityLease | null = null;
    let requestBody = Buffer.alloc(0);
    let responseBody = Buffer.alloc(0);
    let httpStatus = 500;
    let upstreamStatus: number | null = null;
    let attempt = 0;
    let logStatus: 'ok' | 'rejected' | 'failed' = 'failed';
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let circuitKey = '';
    let circuitOptions: Awaited<ReturnType<typeof resolveGatewaySettings>>['circuitBreaker'] | null = null;
    try {
      route = await resolveGatewayRoute(app.db, direction, pathOrName, ctx.method);
      const routeName = String(route.get('name') ?? '');
      // IP allowlist — checked before authentication.
      const ipAllowlist = (route.get('ipAllowlist') as string[] | undefined) ?? [];
      if (!isIpAllowed(ctx.ip, ipAllowlist)) {
        throw new ApimError(ERROR_CODES.IP_FORBIDDEN, `Client IP "${ctx.ip}" is not allowed for this route`, 403);
      }
      const apiKeyHeader = ctx.get('x-api-key');
      const authModeRaw = String(route.get('authMode') ?? 'both');
      const authMode = authModeRaw === 'api-key' || authModeRaw === 'role' ? authModeRaw : 'both';
      // Early bail: no credential at all — the later branches would call
      // authenticateBearerToken purely to have it throw "Missing Bearer
      // token", wasting a JWT-decode-shaped call on the gateway hot path.
      if (!apiKeyHeader && !ctx.getBearerToken()) {
        throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'Missing credentials: provide X-API-Key or a Bearer token', 401);
      }
      if (apiKeyHeader && authMode !== 'role') {
        // Plugin API key: scope check only; route access is not role-bound.
        auth = await authenticateApiKey(app.db, apiKeyHeader, direction, routeName);
      } else if (!apiKeyHeader && authMode !== 'api-key') {
        // App Bearer token: no plugin key scope; access is purely role-based.
        auth = await authenticateBearerToken(app, app.db, ctx.getBearerToken());
      } else if (apiKeyHeader) {
        // authMode === 'role': plugin keys are rejected.
        throw new ApimError(ERROR_CODES.FORBIDDEN, 'This route only accepts app Bearer tokens (role-based)', 403);
      } else {
        // authMode === 'api-key': Bearer tokens are rejected.
        throw new ApimError(ERROR_CODES.FORBIDDEN, 'This route only accepts plugin API keys', 403);
      }
      // Partner-scoped access control. Both plugin API keys and app Bearer
      // tokens are bound to a partner; a route may only be called by a
      // principal whose partner matches the route's partner. Because partner
      // is now required on routes and keys, a missing/auth-failed partner is
      // always rejected.
      const routePartnerId = route.get('partnerId') == null ? null : Number(route.get('partnerId'));
      const principalPartnerId = auth.partnerId == null ? null : Number(auth.partnerId);
      if (routePartnerId == null || principalPartnerId == null || routePartnerId !== principalPartnerId) {
        throw new ApimError(
          ERROR_CODES.FORBIDDEN,
          'Not authorized for this route (partner mismatch)',
          403,
        );
      }
      // Role-based routes additionally require the ACL snippet grant on top of
      // the partner match. API keys rely only on the scope + partner check.
      if (auth.roleName) {
        ctx.state.currentRole = auth.roleName;
        ctx.state.currentRoles = [auth.roleName];
        if (!canRoleCallRoute(app, auth.roleName, routeName)) {
          throw new ApimError(
            ERROR_CODES.FORBIDDEN,
            `Role "${auth.roleName}" is not allowed to call route "${routeName}"`,
            403,
          );
        }
      }
      // Runtime settings: env > DB singleton row > built-in defaults. Cached for 5s.
      const gatewaySettings = await resolveGatewaySettings(app);
      capacityLimiter.updateOptions(gatewaySettings.capacity);
      circuitOptions = gatewaySettings.circuitBreaker;
      // Capacity guard — acquire before buffering the body so a burst of
      // large concurrent uploads cannot exhaust process memory.
      const estimatedRequestBytes = toNumber(ctx.get('content-length'), 0);
      capacityLease = await capacityLimiter.acquire(estimatedRequestBytes);
      const queuedMs = capacityLease.getWaitDecision().queuedMs ?? null;
      if (queuedMs != null) {
        ctx.set('X-APIM-Queued-Ms', String(queuedMs));
      }
      // Rate limiting — keyed by API key + route.
      if (route.get('rateLimitEnabled')) {
        const max = toNumber(route.get('rateLimitMax'), 60);
        const windowSec = toNumber(route.get('rateLimitWindowSec'), 60);
        const rateKey = auth.apiKeyId != null ? `k:${auth.apiKeyId}` : `u:${auth.userId}`;
        const result = rateLimiter.check(`${rateKey}:${route.get('id')}`, max, windowSec);
        if (!result.allowed) {
          ctx.set('Retry-After', String(result.retryAfterSec));
          throw new ApimError(ERROR_CODES.RATE_LIMITED, 'Rate limit exceeded', 429);
        }
      }
      const maxBodyMb = Math.min(100, Math.max(1, toNumber(route.get('maxBodyMb'), DEFAULT_MAX_BODY_MB)));
      requestBody = await getRawBodyBuffer(ctx, maxBodyMb * 1024 * 1024);
      // The caller's query string is forwarded to the target and covered by
      // the HMAC canonical string (path + "?" + query).
      const querySuffix = ctx.querystring ? `?${ctx.querystring}` : '';
      const targetUrlRaw = String(route.get('targetUrl') ?? '');
      const forwardUrl = ctx.querystring
        ? `${targetUrlRaw}${targetUrlRaw.includes('?') ? '&' : '?'}${ctx.querystring}`
        : targetUrlRaw;
      // Circuit key is the route's target URL without the caller's query
      // string: query variations must not spawn unbounded circuit entries.
      circuitKey = targetUrlRaw;
      // Inbound HMAC verification — before decryption.
      if (direction === 'inbound' && route.get('hmacVerifyEnabled')) {
        const hmacSecret = await resolveHmacSecret(app, route);
        try {
          verifyHmacHeaders({
            secret: hmacSecret,
            method: ctx.method,
            path: path + querySuffix,
            body: requestBody,
            headers: ctx.headers as Record<string, string | string[] | undefined>,
            toleranceSec: toNumber(route.get('hmacToleranceSec'), 300),
            nonceCache,
          });
        } catch (error) {
          throw new ApimError(ERROR_CODES.HMAC_INVALID, (error as Error).message, 401);
        }
      }
      // Inbound JWT verification — Bearer token in Authorization header.
      if (direction === 'inbound' && route.get('jwtVerifyEnabled')) {
        const authorization = ctx.get('authorization');
        // The auth-scheme is case-insensitive per RFC 6750/7235.
        const token = authorization && /^bearer /i.test(authorization) ? authorization.slice(7) : undefined;
        if (!token) {
          throw new ApimError(ERROR_CODES.JWT_INVALID, 'Missing Bearer token', 401);
        }
        try {
          // A configured verify key name means RS256; otherwise HS256 with the shared secret.
          const verifyKeyName = route.get('jwtVerifyKeyName');
          let secret: string | undefined;
          let publicKeyPem: string | undefined;
          let algorithms: JwtAlgorithm[];
          if (verifyKeyName) {
            publicKeyPem = await resolveJwtVerifyPublicKey(app, route);
            algorithms = ['RS256'];
          } else {
            secret = await resolveJwtSecret(app, route);
            algorithms = ['HS256'];
          }
          verifyJwt({
            token,
            algorithms,
            secret,
            publicKeyPem,
            issuer: (route.get('jwtIssuer') as string | undefined) || undefined,
            audience: (route.get('jwtAudience') as string | undefined) || undefined,
          });
        } catch (error) {
          if (error instanceof ApimError) throw error;
          throw new ApimError(ERROR_CODES.JWT_INVALID, (error as Error).message, 401);
        }
      }
      const mode = String(route.get('encryptionMode') ?? 'none');
      // responseEncrypted defaults to true; only an explicit false skips
      // outbound response decryption / inbound response encryption (the
      // partner may return a plaintext success/log body).
      const responseEncrypted = route.get('responseEncrypted') !== false;
      const requestContentType = ctx.get('content-type') || undefined;
      let outgoingBody = requestBody;
      let outgoingContentType = requestContentType;
      if (mode !== 'none' && direction === 'inbound') {
        const decrypted = await decryptPayload(app, route, requestBody, requestContentType);
        outgoingBody = decrypted.body;
        outgoingContentType = decrypted.contentType ?? sniffContentType(decrypted.body);
      }
      let headers: Record<string, string>;
      if (direction === 'outbound') {
        // Shared with the admin "test route" resource so both apply the
        // exact same outbound encryption + HMAC + JWT pipeline.
        const forward = await buildOutboundForwardRequest(app, route, {
          body: outgoingBody,
          contentType: requestContentType,
          forwardUrl,
          incomingHeaders: ctx.headers as Record<string, string | string[] | undefined>,
          forwardHeaders: (route.get('forwardHeaders') as string[] | undefined) ?? [],
          staticHeaders: (route.get('staticHeaders') as StaticHeader[] | undefined) ?? [],
        });
        outgoingBody = forward.body;
        outgoingContentType = forward.contentType;
        headers = forward.headers;
      } else {
        headers = buildForwardHeaders({
          incoming: ctx.headers as Record<string, string | string[] | undefined>,
          forwardHeaders: (route.get('forwardHeaders') as string[] | undefined) ?? [],
          staticHeaders: (route.get('staticHeaders') as StaticHeader[] | undefined) ?? [],
          contentType: outgoingContentType,
        });
      }
      // Circuit breaker: reject fast while the target circuit is open,
      // and record the outcome after the attempt.
      const circuitDecision = circuitBreaker.beforeRequest(circuitKey, circuitOptions);
      if (!circuitDecision.allowed) {
        const retryAfterSec = Math.max(1, Math.ceil((circuitDecision.openMs ?? circuitOptions.openDurationMs) / 1000));
        ctx.set('Retry-After', String(retryAfterSec));
        throw circuitOpenError(retryAfterSec);
      }

      const result = await forwardRequest({
        url: forwardUrl,
        method: String(route.get('method') ?? 'POST'),
        headers,
        body: outgoingBody,
        timeoutMs: toNumber(route.get('timeoutMs'), DEFAULT_TIMEOUT_MS),
        retryCount: toNumber(route.get('retryCount'), 0),
        retryDelayMs: toNumber(route.get('retryDelayMs'), 1000),
      });
      attempt = result.attempt;
      if (result.status >= 500 && circuitOptions.countServerErrors) {
        circuitBreaker.recordFailure(circuitKey, circuitOptions);
      } else {
        circuitBreaker.recordSuccess(circuitKey);
      }
      upstreamStatus = result.status;
      let responseContentType = result.headers['content-type'];
      let finalBody = result.body;
      if (mode !== 'none' && responseEncrypted) {
        if (direction === 'inbound') {
          const encrypted = await encryptPayload(app, route, result.body, result.headers['content-type']);
          finalBody = encrypted.body;
          responseContentType = encrypted.contentType ?? responseContentType;
        } else {
          try {
            const decrypted = await decryptPayload(app, route, result.body, result.headers['content-type']);
            finalBody = decrypted.body;
            responseContentType = decrypted.contentType ?? sniffContentType(finalBody);
          } catch (error) {
            if (error instanceof ApimError && error.code === ERROR_CODES.DECRYPT_FAILED) {
              throw new ApimError(ERROR_CODES.UPSTREAM_DECRYPT_FAILED, error.message, 502);
            }
            throw error;
          }
        }
      }
      responseBody = finalBody;
      httpStatus = result.status;
      logStatus = result.status < 400 ? 'ok' : 'failed';
      ctx.status = result.status;
      if (responseContentType) ctx.set('content-type', responseContentType);
      // Forward allow-listed upstream response headers (e.g. content-disposition
      // so downloaded files keep their name, content-length, etag, ranges).
      const forwardResponseHeaders = (route.get('forwardResponseHeaders') as string[] | undefined) ?? [];
      for (const rawName of forwardResponseHeaders) {
        const name = rawName.trim().toLowerCase();
        if (!name) continue;
        const value = result.headers[name];
        if (value == null || value === '') continue;
        ctx.set(name, value);
      }
      ctx.body = finalBody;
    } catch (error) {
      const apimError = toApimError(error);
      if (
        circuitKey &&
        circuitOptions &&
        (apimError.code === ERROR_CODES.UPSTREAM_ERROR || apimError.code === ERROR_CODES.TIMEOUT)
      ) {
        circuitBreaker.recordFailure(circuitKey, circuitOptions);
      }
      httpStatus = apimError.httpStatus;
      errorCode = apimError.code;
      errorMessage = apimError.message;
      logStatus = httpStatus >= 500 ? 'failed' : 'rejected';
      // The detailed message may leak upstream internals (hostnames, DNS
      // errors), so the response uses a generic message for the mapped codes
      // and the detail goes to the server log + request log only.
      const publicMessage = GENERIC_ERROR_MESSAGES[apimError.code] ?? apimError.message;
      if (publicMessage !== apimError.message) {
        app.logger?.warn?.(`[api-manager] ${apimError.code} (${requestId}): ${apimError.message}`);
      }
      ctx.status = apimError.httpStatus;
      ctx.set('content-type', 'application/json');
      ctx.body = JSON.stringify({ error: { code: apimError.code, message: publicMessage, requestId } });
    } finally {
      // Always release the capacity lease so queued requests can proceed.
      if (capacityLease) {
        capacityLease.release();
        capacityLease = null;
      }
      const finishedAt = new Date();
      const logPayloads = Boolean(route?.get('logPayloads'));
      try {
        await writeRequestLog(app.db, {
          requestId,
          routeId: route ? Number(route.get('id')) : null,
          routeName: route ? String(route.get('name') ?? '') : pathOrName,
          direction,
          method: ctx.method,
          path,
          partnerId: auth?.partnerId ?? (route?.get('partnerId') == null ? null : Number(route.get('partnerId'))),
          apiKeyId: auth?.apiKeyId ?? null,
          userId: auth?.userId ?? null,
          roleName: auth?.roleName ?? null,
          clientIp: ctx.ip,
          userAgent: ctx.get('user-agent') || null,
          status: logStatus,
          httpStatus,
          upstreamStatus,
          attempt,
          errorCode,
          error: errorMessage,
          requestBytes: requestBody.length,
          responseBytes: responseBody.length,
          requestSha256: requestBody.length > 0 ? sha256(requestBody) : null,
          responseSha256: responseBody.length > 0 ? sha256(responseBody) : null,
          requestPayload: logPayloads ? capPayload(requestBody) : null,
          responsePayload: logPayloads ? capPayload(responseBody) : null,
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        });
      } catch (logError) {
        app.logger?.warn?.(`[api-manager] failed to write request log: ${(logError as Error).message}`);
      }
    }
  };
}


