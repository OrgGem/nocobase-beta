import { categoryListFields, categoryValues, newCategory } from '../categories';

describe('V2 OCR category forms', () => {
  it('keeps mapping and callback defaults without reusing the default profile unique name', () => {
    expect(newCategory()).toMatchObject({
      enabled: true,
      itemsPath: 'pages[].items[]',
      keyPath: 'key',
      valuePath: 'value',
      callbackTimeoutMs: 15000,
      acceptStatus: 'accepted',
      rejectStatus: 'rejected',
    });
    expect(newCategory().name).toBeUndefined();
    expect(categoryListFields).not.toContain('callbackApiKey');
  });

  it('keeps existing credentials when the replacement field is blank and omits client-only fields', () => {
    expect(categoryValues({ name: 'invoice', callbackApiKey: '', clearCallbackApiKey: false })).toEqual({
      name: 'invoice',
      enabled: undefined,
      callbackTimeoutMs: undefined,
    });
    expect(categoryValues({ callbackApiKey: 'replacement', clearCallbackApiKey: false }).callbackApiKey).toBe(
      'replacement',
    );
    expect(categoryValues({ callbackApiKey: 'replacement', clearCallbackApiKey: true }).callbackApiKey).toBe('');
    expect(categoryValues({ clearCallbackApiKey: true })).not.toHaveProperty('clearCallbackApiKey');
  });
});
