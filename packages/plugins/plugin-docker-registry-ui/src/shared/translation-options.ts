export interface ReactTranslationOptions extends Record<string, unknown> {
  interpolation?: Record<string, unknown>;
}

export function reactTranslationOptions(options: ReactTranslationOptions = {}): ReactTranslationOptions {
  return {
    ...options,
    interpolation: {
      ...options.interpolation,
      escapeValue: false,
    },
  };
}
