import { normalizeProviderConfig } from '../services/provider-config';

describe('normalizeProviderConfig', () => {
  it('preserves object-based provider configuration in normalized form', () => {
    expect(
      normalizeProviderConfig(
        { headerName: 'X-Api-Key', customHeaders: { 'X-Tenant': 'tenant-a' } },
        {
          fileFieldName: 'file',
          extraFields: { language: 'eng' },
          extraBody: { options: { mode: 'accurate' } },
        },
      ),
    ).toEqual({
      authConfig: { headerName: 'X-Api-Key', customHeaders: { 'X-Tenant': 'tenant-a' } },
      requestConfig: {
        fileFieldName: 'file',
        extraFields: { language: 'eng' },
        extraBody: { options: { mode: 'accurate' } },
      },
    });
  });

  it('parses JSON strings submitted by a provider form', () => {
    expect(
      normalizeProviderConfig(
        '{"customHeaders":"{\\"Authorization\\":\\"Bearer token\\"}"}',
        '{"extraFields":"{\\"language\\":\\"eng\\"}","extraBody":"{\\"pages\\":[1,2]}"}',
      ),
    ).toEqual({
      authConfig: { customHeaders: { Authorization: 'Bearer token' } },
      requestConfig: { extraFields: { language: 'eng' }, extraBody: { pages: [1, 2] } },
    });
  });

  it('omits optional empty configurations', () => {
    expect(normalizeProviderConfig(undefined, '')).toEqual({ authConfig: undefined, requestConfig: undefined });
  });

  it.each([
    ['authConfig', '{invalid JSON', undefined, 'authConfig must be valid JSON.'],
    [
      'custom headers',
      { customHeaders: { Authorization: 42 } },
      undefined,
      'authConfig.customHeaders must be a JSON object with string values.',
    ],
    [
      'extra fields',
      undefined,
      { extraFields: { pages: 2 } },
      'requestConfig.extraFields must be a JSON object with string values.',
    ],
    ['extra body', undefined, { extraBody: [] }, 'requestConfig.extraBody must be a JSON object.'],
  ])('rejects invalid %s', (_name, authConfig, requestConfig, message) => {
    expect(() => normalizeProviderConfig(authConfig, requestConfig)).toThrow(message);
  });
});
