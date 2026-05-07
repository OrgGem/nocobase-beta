/**
 * Koa middleware: reverse-proxy requests from /proxy/<slug>/... to the target service.
 *
 * Behaviour mirrors nginx proxy_pass + sub_filter for SPA support:
 *
 *   location /proxy/testA/ {
 *       proxy_pass http://testA:3000/;
 *       sub_filter_once off;
 *       sub_filter 'src="/'  'src="/proxy/testA/';
 *       sub_filter 'href="/' 'href="/proxy/testA/';
 *   }
 *
 * Key features:
 *   - Reads proxy target from DB on each request (with in-memory cache, 10 s TTL).
 *   - For HTML responses: buffers and rewrites absolute paths + injects <base> tag.
 *   - For non-HTML responses: streams directly (zero buffering).
 *   - Rewrites `Location` headers on redirects.
 *   - Forwards subpath, query string, and selected headers.
 *   - Full SPA support: client-side routing, static files, API calls all stay in proxy scope.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { createGunzip, createInflate } from 'zlib';
import type { Context, Next } from '@nocobase/actions';
import type { Database } from '@nocobase/database';

const PROXY_PREFIX = '/proxy/';

// ---------- In-memory cache ----------
interface CachedService {
  slug: string;
  targetUrl: string;
  stripPrefix: boolean;
  forwardAuth: boolean;
  rewriteHtml: boolean;
}

let serviceCache: Map<string, CachedService> = new Map();
let cacheTime = 0;
const CACHE_TTL = 10_000; // 10 s

async function loadServices(db: Database): Promise<Map<string, CachedService>> {
  const now = Date.now();
  if (now - cacheTime < CACHE_TTL && serviceCache.size > 0) {
    return serviceCache;
  }

  try {
    const repo = db.getRepository('proxyServices');
    const rows = await repo.find({ filter: { enabled: true } });
    const map = new Map<string, CachedService>();
    for (const row of rows) {
      map.set(row.get('slug') as string, {
        slug: row.get('slug') as string,
        targetUrl: row.get('targetUrl') as string,
        stripPrefix: row.get('stripPrefix') as boolean,
        forwardAuth: row.get('forwardAuth') as boolean,
        rewriteHtml: row.get('rewriteHtml') as boolean,
      });
    }
    serviceCache = map;
    cacheTime = now;
  } catch {
    // DB not ready — return last cache
  }

  return serviceCache;
}

// ---------- Headers to skip ----------
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function filterHeaders(
  headers: Record<string, string | string[] | undefined>,
  forwardAuth: boolean,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (!val) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (!forwardAuth && lower === 'authorization') continue;
    if (!forwardAuth && lower === 'cookie') continue;
    result[key] = val;
  }
  return result;
}

// ---------- HTML Rewriting for SPA support ----------

/**
 * Rewrite absolute paths in HTML so that SPA static assets, API calls,
 * and client-side routing all stay within the /proxy/<slug>/ scope.
 *
 * Transformations applied:
 *   1. Inject <base href="/proxy/<slug>/"> into <head> (fixes relative paths)
 *   2. Rewrite src="/ → src="/proxy/<slug>/  (scripts, images)
 *   3. Rewrite href="/ → href="/proxy/<slug>/ (CSS, links)
 *   4. Rewrite action="/ → action="/proxy/<slug>/ (forms)
 *   5. Rewrite url(/ → url(/proxy/<slug>/ in inline styles
 *   6. Rewrite fetch("/ and fetch('/ → prefixed (JS API calls)
 *   7. Rewrite window.location = "/ patterns
 *   8. Rewrite "/api/ patterns common in JSON-in-HTML configs
 *
 * Exclusions:
 *   - URLs starting with // (protocol-relative) are NOT rewritten
 *   - URLs starting with /proxy/ are NOT double-rewritten
 *   - data: and blob: URLs are NOT touched
 */
function rewriteHtml(html: string, slug: string): string {
  const prefix = `/proxy/${slug}`;

  // 1. Inject <base> tag right after <head> (or <head ...>)
  //    This catches all relative URLs automatically.
  if (!html.includes('<base ')) {
    html = html.replace(
      /(<head[^>]*>)/i,
      `$1\n<base href="${prefix}/">`,
    );
  }

  // 2-4. Rewrite absolute paths in HTML attributes:
  //    src="/...   href="/...   action="/...   content="/...
  //    But skip:  src="//"  src="/proxy/"   src="/"  (bare root is fine with <base>)
  //    Pattern: (attr=["'])/(?!\/|proxy\/|data:|blob:)
  html = html.replace(
    /((?:src|href|action|content|poster|data-src|data-href)=["'])\/(?!\/|proxy\/|data:|blob:)/gi,
    `$1${prefix}/`,
  );

  // 5. Rewrite url() in inline CSS:  url(/images/...) → url(/proxy/slug/images/...)
  html = html.replace(
    /url\(\s*(['"]?)\/(?!\/|proxy\/|data:|blob:)/gi,
    `url($1${prefix}/`,
  );

  // 6. Rewrite fetch/XMLHttpRequest/axios patterns in inline scripts:
  //    fetch("/api/...   fetch('/api/...
  //    axios.get("/...   $.get("/...
  html = html.replace(
    /((?:fetch|get|post|put|patch|delete|request|ajax)\s*\(\s*["'])\/(?!\/|proxy\/)/gi,
    `$1${prefix}/`,
  );

  // 7. Rewrite window.location / location.href = "/..." patterns
  html = html.replace(
    /((?:location\.href|location\.pathname|window\.location|location\.assign|location\.replace)\s*(?:=|\()\s*["'])\/(?!\/|proxy\/)/gi,
    `$1${prefix}/`,
  );

  // 8. Rewrite JSON config patterns often embedded in script tags:
  //    "apiBase":"/api"   "basePath":"/"   "publicPath":"/"
  html = html.replace(
    /(["'](?:apiBase|basePath|publicPath|baseUrl|baseURL|apiUrl|apiURL|prefix|root)["']\s*:\s*["'])\/(?!\/|proxy\/)/gi,
    `$1${prefix}/`,
  );

  // 9. Rewrite <meta http-equiv="refresh" content="0;url=/...">
  html = html.replace(
    /(content=["']\d+;\s*url=)\/(?!\/|proxy\/)/gi,
    `$1${prefix}/`,
  );

  // 10. Inject a small script that patches pushState/replaceState
  //     to keep SPA router navigation within the proxy prefix.
  const routerPatch = `
<script data-proxy-patch="true">
(function() {
  var PREFIX = ${JSON.stringify(prefix)};
  // Patch History API so SPA routers navigate within proxy scope
  var origPush = history.pushState;
  var origReplace = history.replaceState;
  function patchUrl(url) {
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith(PREFIX + '/') && !url.startsWith('//')) {
      return PREFIX + url;
    }
    return url;
  }
  history.pushState = function(state, title, url) {
    return origPush.call(this, state, title, patchUrl(url));
  };
  history.replaceState = function(state, title, url) {
    return origReplace.call(this, state, title, patchUrl(url));
  };

  // Patch fetch to rewrite absolute URLs
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = patchUrl(input);
    } else if (input instanceof Request && input.url) {
      try {
        var u = new URL(input.url);
        if (u.origin === location.origin) {
          var newPath = patchUrl(u.pathname);
          if (newPath !== u.pathname) {
            input = new Request(u.origin + newPath + u.search, input);
          }
        }
      } catch(e) {}
    }
    return origFetch.call(this, input, init);
  };

  // Patch XMLHttpRequest.open to rewrite absolute URLs
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    arguments[1] = patchUrl(url);
    return origOpen.apply(this, arguments);
  };
})();
</script>`;

  // Insert the router patch script right after <head> or after <base>
  if (html.includes('<base ')) {
    html = html.replace(/(<base[^>]*>)/i, `$1${routerPatch}`);
  } else {
    html = html.replace(/(<head[^>]*>)/i, `$1${routerPatch}`);
  }

  return html;
}

/**
 * Read a stream fully into a string, handling gzip/deflate encoding.
 */
function bufferStream(
  stream: http.IncomingMessage,
  encoding: string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    let source: NodeJS.ReadableStream = stream;
    if (encoding === 'gzip') {
      source = stream.pipe(createGunzip());
    } else if (encoding === 'deflate') {
      source = stream.pipe(createInflate());
    }

    source.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    source.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    source.on('error', reject);
  });
}

// ---------- Middleware factory ----------
export function createProxyMiddleware(db: Database) {
  return async (ctx: Context, next: Next) => {
    // Quick path check
    if (!ctx.path.startsWith(PROXY_PREFIX)) {
      return next();
    }

    // Extract slug  — /proxy/<slug>/rest/of/path
    const afterPrefix = ctx.path.slice(PROXY_PREFIX.length);
    const slashIdx = afterPrefix.indexOf('/');
    const slug = slashIdx === -1 ? afterPrefix : afterPrefix.slice(0, slashIdx);
    const subPath = slashIdx === -1 ? '/' : afterPrefix.slice(slashIdx);

    if (!slug) {
      return next();
    }

    // Lookup target
    const services = await loadServices(db);
    const svc = services.get(slug);
    if (!svc) {
      return next(); // Not our route — let NocoBase handle it
    }

    // Build target URL
    const targetBase = svc.targetUrl.replace(/\/+$/, '');
    const forwardPath = svc.stripPrefix ? subPath : `${PROXY_PREFIX}${slug}${subPath}`;
    const qs = ctx.querystring ? `?${ctx.querystring}` : '';
    const targetFullUrl = `${targetBase}${forwardPath}${qs}`;

    const parsed = new URL(targetFullUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    // Build proxy request headers
    const proxyHeaders = filterHeaders(
      ctx.req.headers as Record<string, string | string[] | undefined>,
      svc.forwardAuth,
    );
    proxyHeaders['host'] = parsed.host;
    proxyHeaders['x-forwarded-for'] = ctx.ip;
    proxyHeaders['x-forwarded-proto'] = ctx.protocol;
    proxyHeaders['x-forwarded-host'] = ctx.host;
    // Tell target we accept uncompressed if we may rewrite (so we can parse HTML easily)
    if (svc.rewriteHtml) {
      proxyHeaders['accept-encoding'] = 'gzip, deflate, identity';
    }

    // Perform the proxy request
    await new Promise<void>((resolve) => {
      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search || ''}`,
        method: ctx.method,
        headers: proxyHeaders,
      };

      // Don't validate self-signed certs for internal services
      if (isHttps) {
        (options as any).rejectUnauthorized = false;
      }

      const proxyReq = transport.request(options as any, async (proxyRes) => {
        // Status
        ctx.status = proxyRes.statusCode || 502;

        // Determine content type
        const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
        const isHtml = contentType.includes('text/html');
        const shouldRewrite = svc.rewriteHtml && isHtml;

        // Copy response headers (filter hop-by-hop)
        for (const [key, val] of Object.entries(proxyRes.headers)) {
          if (!val) continue;
          const lower = key.toLowerCase();
          if (HOP_BY_HOP.has(lower)) continue;

          // Skip content-length and content-encoding if we're rewriting
          // (because the body length/encoding will change)
          if (shouldRewrite && (lower === 'content-length' || lower === 'content-encoding')) {
            continue;
          }

          // Rewrite Location header (redirects) to go through our proxy
          if (lower === 'location' && typeof val === 'string') {
            try {
              const loc = new URL(val, targetFullUrl);
              if (loc.origin === new URL(targetBase).origin) {
                const rewritten = `${PROXY_PREFIX}${slug}${loc.pathname}${loc.search || ''}`;
                ctx.set(key, rewritten);
                continue;
              }
            } catch {
              // Not a parseable URL, forward as-is
            }
          }

          // Rewrite Set-Cookie path if needed
          if (lower === 'set-cookie') {
            const cookies = Array.isArray(val) ? val : [val];
            const rewritten = cookies.map((c: string) =>
              c.replace(/;\s*path=\//gi, `; Path=${PROXY_PREFIX}${slug}/`),
            );
            ctx.set(key, rewritten);
            continue;
          }

          ctx.set(key, val as string);
        }

        if (shouldRewrite) {
          // Buffer HTML response, rewrite, and send
          try {
            const contentEncoding = proxyRes.headers['content-encoding'];
            const rawHtml = await bufferStream(proxyRes, contentEncoding);
            const rewritten = rewriteHtml(rawHtml, slug);
            ctx.type = 'text/html; charset=utf-8';
            ctx.body = rewritten;
          } catch (err: any) {
            // If rewriting fails, try to stream raw
            ctx.status = 502;
            ctx.body = { error: `HTML rewrite error: ${err.message}` };
          }
        } else {
          // Stream the response body directly (non-HTML or rewrite disabled)
          ctx.body = proxyRes;
        }

        resolve();
      });

      proxyReq.on('error', (err) => {
        ctx.status = 502;
        ctx.body = { error: `Proxy error: ${err.message}` };
        resolve();
      });

      // Pipe request body for POST/PUT/PATCH
      if (ctx.req.readable && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method)) {
        ctx.req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    });
  };
}

/**
 * Force-clear the service cache. Called after CRUD on proxyServices.
 */
export function invalidateProxyCache() {
  serviceCache.clear();
  cacheTime = 0;
}
