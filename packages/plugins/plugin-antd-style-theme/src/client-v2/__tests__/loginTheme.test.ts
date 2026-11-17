// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { sanitizeCssValue, sanitizeSafeUrl } from '../../client/components/LoginThemeProvider';

vi.mock('@nocobase/client-v2', () => ({
  useGlobalTheme: () => ({ theme: {} }),
}));

vi.mock('react-router-dom', () => ({
  useInRouterContext: () => false,
  useLocation: () => ({ pathname: '/' }),
}));

describe('LoginThemeProvider sanitization', () => {
  it('accepts safe http/https/relative/raster-data URLs and rejects unsafe schemes', () => {
    expect(sanitizeSafeUrl('https://example.com/bg.png')).toBe('https://example.com/bg.png');
    expect(sanitizeSafeUrl('http://localhost:3000/logo.svg')).toBe('http://localhost:3000/logo.svg');
    expect(sanitizeSafeUrl('/assets/bg (1).png')).toBe('/assets/bg (1).png');
    expect(sanitizeSafeUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');

    expect(sanitizeSafeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeSafeUrl('//evil.com/x.png')).toBeNull();
    expect(sanitizeSafeUrl('data:image/svg+xml,<svg/>')).toBeNull();
    expect(sanitizeSafeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(sanitizeSafeUrl('https://example.com/a\nb.png')).toBeNull();
    expect(sanitizeSafeUrl('')).toBeNull();
    expect(sanitizeSafeUrl(123)).toBeNull();
  });

  it('accepts safe CSS color/gradient/shadow values and rejects CSS injection payloads', () => {
    expect(sanitizeCssValue('#00B74F')).toBe('#00B74F');
    expect(sanitizeCssValue('rgba(0, 0, 0, 0.5)')).toBe('rgba(0, 0, 0, 0.5)');
    expect(sanitizeCssValue('linear-gradient(135deg, #667eea 0%, #764ba2 100%)')).toBe(
      'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    );
    expect(sanitizeCssValue('0 4px 12px rgba(0, 0, 0, 0.15)')).toBe('0 4px 12px rgba(0, 0, 0, 0.15)');

    expect(sanitizeCssValue('; } body { display: none')).toBeNull();
    expect(sanitizeCssValue('url(https://evil.com/leak)')).toBeNull();
    expect(sanitizeCssValue('@import url(https://evil.com/x.css)')).toBeNull();
    expect(sanitizeCssValue('expression(alert(1))')).toBeNull();
    expect(sanitizeCssValue('/* comment */ red')).toBeNull();
    expect(sanitizeCssValue('a'.repeat(501))).toBeNull();
  });
});
