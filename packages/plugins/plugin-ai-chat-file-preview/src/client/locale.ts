// SPDX-License-Identifier: Apache-2.0

import { useApp } from '@nocobase/client';

export function useTranslation() {
  const app = useApp();
  return {
    t: (key: string) => app.i18n.t(key, { ns: 'plugin-ai-chat-file-preview' }),
  };
}
