/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback } from 'react';
import { useFlowContext } from '@nocobase/flow-engine';
import { StartupGuardianPage } from '../shared/StartupGuardianPage';
import { useT } from './locale';

export default function StartupGuardianClientPage() {
  const context = useFlowContext();
  const t = useT();
  const request = useCallback(
    (options: { url: string; method?: 'get' | 'post'; data?: Record<string, unknown> }) => context.api.request(options),
    [context.api],
  );
  return <StartupGuardianPage request={request} t={(key) => String(t(key))} />;
}
