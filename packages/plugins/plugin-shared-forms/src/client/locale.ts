// SPDX-License-Identifier: Apache-2.0

import { useApp } from '@nocobase/client';
import { useTranslation } from 'react-i18next';
// @ts-ignore
import pkg from './../../package.json';

export const NAMESPACE = 'shared-forms';

export function useT() {
  const app = useApp();
  return (str: string) => app.i18n.t(str, { ns: [pkg.name, 'client'] });
}

export function tStr(key: string) {
  return `{{t(${JSON.stringify(key)}, { ns: ['${pkg.name}', 'client'], nsMode: 'fallback' })}}`;
}

export function useSharedFormTranslation() {
  return useTranslation([NAMESPACE, 'client'], {
    nsMode: 'fallback',
  });
}
