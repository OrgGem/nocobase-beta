import { unwrapSettingsResponse } from '../pages/SettingsPage';

const settings = {
  overrides: { publicEnabled: true },
  effective: { publicEnabled: { value: true, source: 'ui' as const } },
};

describe('unwrapSettingsResponse', () => {
  it.each([
    ['direct action body', settings],
    ['NocoBase envelope', { data: settings }],
    ['Axios and NocoBase envelopes', { data: { data: settings } }],
  ])('supports %s', (_name, response) => {
    expect(unwrapSettingsResponse(response)).toEqual(settings);
  });

  it('returns undefined for incomplete responses', () => {
    expect(unwrapSettingsResponse({ data: {} })).toBeUndefined();
  });
});
