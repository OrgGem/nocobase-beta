/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { DataSourceSettingsFormProps } from '@nocobase/plugin-data-source-manager/client-v2';
import { useFlowContext } from '@nocobase/flow-engine';
import React, { useCallback } from 'react';
import { ElasticsearchConfigForm } from './ElasticsearchConfigForm';

export function ElasticsearchSettingsForm(props: DataSourceSettingsFormProps) {
  const ctx = useFlowContext();

  const loadCollectionsFromValues = useCallback(
    async (values: Record<string, unknown>) => {
      const response = await ctx.api.resource('external-elasticsearch').readIndices({
        values,
      });

      return response?.data;
    },
    [ctx.api],
  );

  return <ElasticsearchConfigForm {...props} loadCollectionsFromValues={loadCollectionsFromValues} />;
}

export default ElasticsearchSettingsForm;
