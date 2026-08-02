import { describe, expect, it } from 'vitest';

import { isRegistryUrl } from '../validation';

describe('Docker Registry settings validation', () => {
  it('accepts Docker service hostnames and normal public registry origins', () => {
    expect(isRegistryUrl('http://docker-registry:5000')).toBe(true);
    expect(isRegistryUrl('https://registry.example.com')).toBe(true);
    expect(isRegistryUrl('https://127.0.0.1:5000/')).toBe(true);
  });

  it('rejects non-HTTP URLs and origins containing credentials, query, or hash', () => {
    expect(isRegistryUrl('docker-registry:5000')).toBe(false);
    expect(isRegistryUrl('ftp://registry.example.com')).toBe(false);
    expect(isRegistryUrl('https://user:secret@registry.example.com')).toBe(false);
    expect(isRegistryUrl('https://registry.example.com?debug=true')).toBe(false);
    expect(isRegistryUrl('https://registry.example.com#fragment')).toBe(false);
  });
});
