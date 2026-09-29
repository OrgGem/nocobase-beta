import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MODERN_CLIENT_DIST_DIR,
  injectRuntimeScript,
  normalizeModernClientPrefix,
  resolveV2PublicPath,
  rewriteV2AssetPublicPath,
} from '../utils';

// Mirrors the asset-path remap branch in Gateway.requestHandler (gateway/index.ts): a request served under a runtime
// tenant prefix must resolve its assets from the fixed on-disk build dir. Kept here as a pure expression so the
// contract is covered without spinning up fs / AppSupervisor / serve-handler.
function rewriteAssetUrl(url: string, modernPrefix: string): string {
  if (modernPrefix !== MODERN_CLIENT_DIST_DIR && url.startsWith(`/${modernPrefix}/`)) {
    return `/${MODERN_CLIENT_DIST_DIR}/${url.slice(modernPrefix.length + 2)}`;
  }
  return url;
}

describe('gateway modern-client prefix utils', () => {
  const originalPrefix = process.env.APP_MODERN_CLIENT_PREFIX;

  beforeEach(() => {
    delete process.env.APP_MODERN_CLIENT_PREFIX;
  });

  afterEach(() => {
    if (originalPrefix === undefined) {
      delete process.env.APP_MODERN_CLIENT_PREFIX;
    } else {
      process.env.APP_MODERN_CLIENT_PREFIX = originalPrefix;
    }
  });

  describe('normalizeModernClientPrefix', () => {
    it('keeps a bare tenant segment and falls back to the dist dir when empty', () => {
      expect(normalizeModernClientPrefix('acme')).toBe('acme');
      expect(normalizeModernClientPrefix('/acme/')).toBe('acme');
      expect(normalizeModernClientPrefix('')).toBe(MODERN_CLIENT_DIST_DIR);
      expect(normalizeModernClientPrefix(undefined)).toBe(MODERN_CLIENT_DIST_DIR);
    });
  });

  describe('resolveV2PublicPath', () => {
    it('uses the tenant prefix override when provided', () => {
      expect(resolveV2PublicPath('/', 'acme')).toBe('/acme/');
      expect(resolveV2PublicPath('/nb', 'acme')).toBe('/nb/acme/');
    });

    it('falls back to APP_MODERN_CLIENT_PREFIX (backward compat) when no override', () => {
      process.env.APP_MODERN_CLIENT_PREFIX = 'v2';
      expect(resolveV2PublicPath('/')).toBe('/v2/');
      expect(resolveV2PublicPath('/nb')).toBe('/nb/v2/');
    });

    it('falls back to the fixed dist dir when neither override nor env is set', () => {
      expect(resolveV2PublicPath('/')).toBe(`/${MODERN_CLIENT_DIST_DIR}/`);
    });
  });

  describe('rewriteV2AssetPublicPath', () => {
    it('rewrites the baked /v/ sentinel to the tenant asset path', () => {
      const html = '<script src="/v/assets/app.js"></script><link href="/v/assets/app.css">';
      const rewritten = rewriteV2AssetPublicPath(html, '/acme/');
      expect(rewritten).toContain('src="/acme/assets/app.js"');
      expect(rewritten).toContain('href="/acme/assets/app.css"');
    });

    it('is a no-op when the asset path equals the baked sentinel', () => {
      const html = '<script src="/v/assets/app.js"></script>';
      expect(rewriteV2AssetPublicPath(html, `/${MODERN_CLIENT_DIST_DIR}/`)).toBe(html);
    });
  });

  describe('injectRuntimeScript', () => {
    it('injects the runtime config before the first module script', () => {
      const html = '<html><head><script type="module" src="/v/assets/app.js"></script></head><body></body></html>';
      const out = injectRuntimeScript(html, `<script>window['x'] = 1;</script>`);
      expect(out.indexOf(`window['x'] = 1;`)).toBeLessThan(out.indexOf('type="module"'));
    });
  });

  describe('requestHandler asset remap contract', () => {
    it('maps a tenant asset URL back to the fixed dist dir', () => {
      expect(rewriteAssetUrl('/acme/assets/app.js', 'acme')).toBe(`/${MODERN_CLIENT_DIST_DIR}/assets/app.js`);
    });

    it('is a no-op when the prefix already equals the dist dir (single-prefix default)', () => {
      expect(rewriteAssetUrl('/v/assets/app.js', normalizeModernClientPrefix(''))).toBe('/v/assets/app.js');
    });

    it('leaves non-asset requests untouched', () => {
      expect(rewriteAssetUrl('/acme/admin/list', 'acme')).toBe('/v/admin/list');
      expect(rewriteAssetUrl('/other/assets/x.js', 'acme')).toBe('/other/assets/x.js');
    });
  });
});
