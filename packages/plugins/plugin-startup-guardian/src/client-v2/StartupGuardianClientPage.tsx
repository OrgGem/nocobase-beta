// SPDX-License-Identifier: Apache-2.0

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
