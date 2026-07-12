import React from 'react';
import { useFlowEngine } from '@nocobase/flow-engine';

// ──────────────────────────────────────────────
// Replaces deep imports from:
//   @nocobase/plugin-data-visualization/src/client-v2/locale
//   @nocobase/plugin-data-visualization/src/client-v2/flow/utils
//
// These are local copies of stable utility functions from the upstream
// data-visualization plugin. They exist here so the compat layer does not
// depend on internal source paths that could change without notice.
// ──────────────────────────────────────────────

const UPSTREAM_NS = '@nocobase/plugin-data-visualization';

/**
 * Equivalent to `useT()` from the upstream plugin's locale module.
 * Uses the upstream namespace so translation keys resolve against the
 * data-visualization locale files (with i18next fallback to other namespaces).
 */
export function useDataVisualizationT() {
  const engine = useFlowEngine();
  return (str: string) => engine.context.t(str, { ns: [UPSTREAM_NS, 'client'] });
}

/**
 * Compiles t-expr template strings like `{{t('key', { ns: [...] })}}`
 * by extracting the key and passing it through the translate function.
 */
export function translateExpr(source: unknown, t: (key: string) => string): unknown {
  if (typeof source === 'string') {
    return source.replace(/\{\{\s*t\((['"])(.*?)\1(?:\s*,\s*\{[^}]*\})?\)\s*\}\}/g, (_, __, key) => t(key));
  }
  return source;
}

/**
 * Returns a memoised compile function that resolves t-expr template strings
 * using the data-visualization namespace.
 */
export function useCompile() {
  const t = useDataVisualizationT();
  return React.useCallback((source: unknown) => translateExpr(source, t), [t]);
}

/**
 * Promise-based sleep.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Appends a locale-appropriate colon to a label.
 */
export function appendColon(label: string, lang?: string): string {
  if (typeof label !== 'string') {
    return '';
  }
  const trimmed = label.trim();
  if (!trimmed) {
    return '';
  }
  const noColon = trimmed.replace(/[：:]\s*$/u, '');
  const isZh = typeof lang === 'string' && /^zh([-_]|$)/i.test(lang);
  const colon = isZh ? '：' : ':';
  return `${noColon}${colon}`;
}
