import { categoriesSchema } from '../schemas/categoriesSchema';
import { tStr } from '../locale';

describe('OCR verify category schema', () => {
  it('exposes mapping profile fields to the category manager', () => {
    const schemaText = JSON.stringify(categoriesSchema);

    expect(schemaText).toContain('itemsPath');
    expect(schemaText).toContain('keyPath');
    expect(schemaText).toContain('valuePath');
    expect(schemaText).toContain('callbackTimeoutMs');
  });

  it('uses the plugin locale namespace for inline schema labels', () => {
    expect(tStr('Save')).toContain('plugin-ocr-verify-block');
  });
});
