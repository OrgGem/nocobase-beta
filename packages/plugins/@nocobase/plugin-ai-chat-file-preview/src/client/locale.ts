/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client';

export function useTranslation() {
  const app = useApp();
  return {
    t: (key: string) => app.i18n.t(key, { ns: '@nocobase/plugin-ai-chat-file-preview' }),
  };
}
