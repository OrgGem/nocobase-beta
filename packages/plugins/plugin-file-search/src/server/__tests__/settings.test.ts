import { DEFAULT_SETTINGS } from '../constants';
import { normalizeSettings } from '../services/settings';

describe('plugin-file-search settings', () => {
  it('normalizes extension lists and numeric limits', () => {
    const settings = normalizeSettings({
      allowedExtnames: ['pdf', '.MD', '  docx  ', 'pdf'],
      maxFileSizeMb: '12',
      concurrency: '2',
      timeoutMs: '90000',
    });

    expect(settings.allowedExtnames).toEqual(['.pdf', '.md', '.docx']);
    expect(settings.maxFileSizeMb).toBe(12);
    expect(settings.concurrency).toBe(2);
    expect(settings.timeoutMs).toBe(90000);
  });

  it('falls back to safe defaults for unknown parser strategy', () => {
    const settings = normalizeSettings({
      parserStrategy: 'unknown',
      allowedExtnames: 'pdf',
    });

    expect(settings.parserStrategy).toBe(DEFAULT_SETTINGS.parserStrategy);
    expect(settings.allowedExtnames).toEqual(DEFAULT_SETTINGS.allowedExtnames);
  });
});
