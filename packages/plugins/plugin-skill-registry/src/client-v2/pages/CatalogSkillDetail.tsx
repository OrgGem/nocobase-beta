import React from 'react';
import { Empty, Spin } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { unwrapData } from './api';
import { SkillDetailContent, type SkillDetailBody } from './MarkdownSkillDetail';

export function CatalogSkillDetail({ packageId }: { packageId?: string }) {
  const ctx = useFlowContext();
  const t = useT();

  const request = useRequest(
    () =>
      ctx.api.request({
        url: 'skillRegistryAdmin:getCatalogSkillDetail',
        method: 'post',
        data: { packageId },
      }),
    { ready: Boolean(packageId), refreshDeps: [packageId] },
  );

  const detail = unwrapData<SkillDetailBody>(request.data);

  return (
    <Spin spinning={request.loading}>
      {detail?.skill ? (
        <SkillDetailContent detail={detail} />
      ) : (
        <Empty description={t('No skill information is available for this package.')} />
      )}
    </Spin>
  );
}

export default CatalogSkillDetail;
