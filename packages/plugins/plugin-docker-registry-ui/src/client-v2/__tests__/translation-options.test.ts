import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import { reactTranslationOptions } from '../../shared/translation-options';

describe('Docker Registry React translation options', () => {
  it('preserves repository separators in interpolated UI text', async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: 'en-US',
      resources: {
        'en-US': {
          translation: {
            detected: 'Detected archive references: {{references}}',
            confirmation: 'Type the repository name to confirm: {{repository}}',
          },
        },
      },
    });

    expect(i18n.t('detected', reactTranslationOptions({ references: 'demo/alpine:latest' }))).toBe(
      'Detected archive references: demo/alpine:latest',
    );
    expect(i18n.t('confirmation', reactTranslationOptions({ repository: 'demo/alpine' }))).toBe(
      'Type the repository name to confirm: demo/alpine',
    );
  });

  it('forces React-owned escaping even if a caller requests i18next escaping', () => {
    expect(reactTranslationOptions({ interpolation: { escapeValue: true } })).toMatchObject({
      interpolation: { escapeValue: false },
    });
  });
});
