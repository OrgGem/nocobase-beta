import type { DataSourceSettingsFormProps } from '@nocobase/plugin-data-source-manager/client-v2';
import { useFlowContext } from '@nocobase/flow-engine';
import React, { useCallback } from 'react';
import { ElasticsearchConfigForm } from '../client/components/ElasticsearchConfigForm';

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
