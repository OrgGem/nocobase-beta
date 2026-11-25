// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { useFlowEngine } from '@nocobase/flow-engine';
import { PLUGIN_NAME } from '../shared/constants';

export const NAMESPACE = PLUGIN_NAME;

export const tExpr = (key: string) => `{{t("${key}", { ns: "${PLUGIN_NAME}" })}}`;

export function useT() {
  const engine = useFlowEngine();
  return useCallback(
    (str: string, options?: Record<string, unknown>) => {
      const mergedOptions = { ...options, ns: [PLUGIN_NAME, 'client'] };
      const ctx = engine?.context as
        | {
            t?: (key: string, opts?: Record<string, unknown>) => unknown;
            i18n?: { t?: (key: string, opts?: Record<string, unknown>) => unknown };
          }
        | undefined;
      if (typeof ctx?.t === 'function') {
        return String(ctx.t(str, mergedOptions));
      }
      if (typeof ctx?.i18n?.t === 'function') {
        return String(ctx.i18n.t(str, mergedOptions));
      }
      if (options) {
        return str.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) =>
          options[k] !== undefined ? String(options[k]) : '',
        );
      }
      return str;
    },
    [engine],
  );
}
