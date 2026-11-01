/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  createBlockScopedEngine,
  FlowModelRenderer,
  type FlowModel,
  type FlowModelContext,
} from '@nocobase/flow-engine';
import { Alert, ConfigProvider, Spin } from 'antd';
import React, { useEffect, useState } from 'react';
import type { BlockSpec } from '../../shared/blockSpec';
import { useT } from '../locale';
import { buildNativeOptions } from '../nativeBlock';

export function NativePreview({ ctx, spec }: { ctx: FlowModelContext; spec: BlockSpec }) {
  const t = useT();
  const [model, setModel] = useState<FlowModel>();
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const engine = createBlockScopedEngine(ctx.engine);
    let root: FlowModel | undefined;
    setModel(undefined);
    setError('');
    async function prepare() {
      try {
        const options = buildNativeOptions(ctx, spec, false);
        root = await engine.createModelAsync(options);
        if (cancelled) {
          root.remove();
          return;
        }
        root.context.addDelegate(ctx);
        setModel(root);
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : t('Preview is unavailable'));
      }
    }
    prepare();
    return () => {
      cancelled = true;
      root?.remove();
      engine.unlinkFromStack();
    };
  }, [ctx, spec, t]);
  if (error) return <Alert type="error" showIcon message={t(error)} />;
  if (!model) return <Spin />;
  return (
    <ConfigProvider componentDisabled>
      <FlowModelRenderer model={model} showFlowSettings={false} />
    </ConfigProvider>
  );
}
