/**
 * Server action: proxyServices:fetchPage
 *
 * Fetches HTML from a proxy target and returns it as JSON.
 * Used by the "embed" render mode (Shadow DOM) on the client.
 *
 * Query params:
 *   - slug: proxy service slug
 *   - path: subpath to fetch (default: '/')
 *
 * Response:
 *   { html: string, contentType: string, status: number }
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { createGunzip, createInflate } from 'zlib';
import type { Context } from '@nocobase/actions';

/**
 * Read a response stream fully into a string, handling gzip/deflate.
 */
function bufferResponse(
  res: http.IncomingMessage,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const encoding = res.headers['content-encoding'];

    let source: NodeJS.ReadableStream = res;
    if (encoding === 'gzip') {
      source = res.pipe(createGunzip());
    } else if (encoding === 'deflate') {
      source = res.pipe(createInflate());
    }

    source.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    source.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    source.on('error', reject);
  });
}

/**
 * Rewrite HTML for embed mode.
 * Simpler than iframe rewrite — we only need to:
 *   1. Rewrite absolute paths in src/href/action attributes
 *   2. Rewrite CSS url()
 *   3. Remove <script> tags (JS runs in parent page scope — dangerous)
 *      OR keep them but prefix API calls
 *   4. Rewrite inline style url()
 *
 * For embed mode, we STRIP scripts by default (static content).
 * If the service is a dashboard (Grafana, etc.), scripts are needed — controlled by keepScripts option.
 */
function rewriteForEmbed(html: string, slug: string, keepScripts: boolean): string {
  const prefix = `/proxy/${slug}`;

  // Rewrite absolute paths in attributes
  html = html.replace(
    /((?:src|href|action|poster|data-src|data-href)=["'])\/(?!\/|proxy\/|data:|blob:)/gi,
    `$1${prefix}/`,
  );

  // Rewrite CSS url()
  html = html.replace(
    /url\(\s*(['"]?)\/(?!\/|proxy\/|data:|blob:)/gi,
    `url($1${prefix}/`,
  );

  // Extract <body> content only — we don't want <html>, <head>, etc.
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let bodyContent = bodyMatch ? bodyMatch[1] : html;

  // Extract stylesheets from <head>
  const styleLinks: string[] = [];
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if (headMatch) {
    const headContent = headMatch[1];
    // Collect <link rel="stylesheet"> and <style> tags
    const linkRegex = /<link[^>]*rel=["']stylesheet["'][^>]*>/gi;
    let m;
    while ((m = linkRegex.exec(headContent)) !== null) {
      styleLinks.push(m[0]);
    }
    const styleRegex = /<style[^>]*>[\s\S]*?<\/style>/gi;
    while ((m = styleRegex.exec(headContent)) !== null) {
      styleLinks.push(m[0]);
    }
  }

  // Also collect <style> tags from body
  const bodyStyleRegex = /<style[^>]*>[\s\S]*?<\/style>/gi;
  let bm;
  while ((bm = bodyStyleRegex.exec(bodyContent)) !== null) {
    if (!styleLinks.includes(bm[0])) {
      styleLinks.push(bm[0]);
    }
  }

  if (!keepScripts) {
    // Strip all <script> tags from body
    bodyContent = bodyContent.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  } else {
    // Keep scripts but rewrite fetch/XHR patterns
    bodyContent = bodyContent.replace(
      /((?:fetch|get|post|put|patch|delete|request|ajax)\s*\(\s*["'])\/(?!\/|proxy\/)/gi,
      `$1${prefix}/`,
    );
  }

  return JSON.stringify({
    styles: styleLinks.join('\n'),
    body: bodyContent,
  });
}

export function createFetchPageAction(db: any) {
  return async (ctx: Context) => {
    const { slug, path: subPath = '/', keepScripts } = ctx.action.params.values || ctx.action.params;

    if (!slug) {
      ctx.status = 400;
      ctx.body = { error: 'slug is required' };
      return;
    }

    // Lookup service
    const repo = db.getRepository('proxyServices');
    const service = await repo.findOne({ filter: { slug, enabled: true } });
    if (!service) {
      ctx.status = 404;
      ctx.body = { error: `Service "${slug}" not found or disabled` };
      return;
    }

    const targetUrl = (service.get('targetUrl') as string).replace(/\/+$/, '');
    const normalizedPath = subPath.startsWith('/') ? subPath : `/${subPath}`;
    const fullUrl = `${targetUrl}${normalizedPath}`;

    try {
      const parsed = new URL(fullUrl);
      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;

      const htmlContent = await new Promise<{ html: string; status: number; contentType: string }>((resolve, reject) => {
        const options: http.RequestOptions = {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search || ''}`,
          method: 'GET',
          headers: {
            'Accept': 'text/html,application/xhtml+xml,*/*',
            'Accept-Encoding': 'gzip, deflate, identity',
            'User-Agent': 'NocoBase-ProxyBlock/1.0',
          },
        };

        if (isHttps) {
          (options as any).rejectUnauthorized = false;
        }

        const req = transport.request(options as any, async (res) => {
          try {
            const body = await bufferResponse(res);
            resolve({
              html: body,
              status: res.statusCode || 200,
              contentType: res.headers['content-type'] || 'text/html',
            });
          } catch (err: any) {
            reject(err);
          }
        });

        req.on('error', reject);
        req.setTimeout(15000, () => {
          req.destroy(new Error('Request timeout (15s)'));
        });
        req.end();
      });

      // Parse and rewrite
      const parsed2 = JSON.parse(rewriteForEmbed(
        htmlContent.html,
        slug,
        keepScripts === 'true' || keepScripts === true,
      ));

      ctx.body = {
        data: {
          styles: parsed2.styles,
          body: parsed2.body,
          status: htmlContent.status,
          contentType: htmlContent.contentType,
          slug,
          path: normalizedPath,
        },
      };
    } catch (err: any) {
      ctx.status = 502;
      ctx.body = {
        error: `Failed to fetch from "${slug}": ${err.message}`,
      };
    }
  };
}
