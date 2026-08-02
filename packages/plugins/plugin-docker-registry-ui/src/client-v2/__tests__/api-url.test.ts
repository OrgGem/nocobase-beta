import { describe, expect, it } from 'vitest';
import { buildApiActionUrl } from '../api';

describe('buildApiActionUrl', () => {
  it('keeps a NocoBase resource action with a colon in the HTTP pathname', () => {
    const url = buildApiActionUrl('/api/', 'http://localhost', 'dockerRegistry:downloadImage');

    expect(url.protocol).toBe('http:');
    expect(url.toString()).toBe('http://localhost/api/dockerRegistry:downloadImage');
  });

  it('supports an absolute API base URL without a trailing slash', () => {
    const url = buildApiActionUrl(
      'https://nocobase.example.com/custom-api',
      'http://localhost',
      'dockerRegistry:downloadImage',
    );

    expect(url.toString()).toBe('https://nocobase.example.com/custom-api/dockerRegistry:downloadImage');
  });

  it('drops query and fragment values inherited from the API base URL', () => {
    const url = buildApiActionUrl('/api/?tenant=old#section', 'http://localhost', 'dockerRegistry:downloadImage');

    expect(url.toString()).toBe('http://localhost/api/dockerRegistry:downloadImage');
  });
});
