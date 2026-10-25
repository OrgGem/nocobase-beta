/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  FlowEngineProvider,
  FlowModelRenderer,
  useFlowEngine,
  type CollectionOptions,
  type FlowEngine,
} from '@nocobase/flow-engine';
import { Alert, Spin } from 'antd';
import React, { useEffect, useState } from 'react';
import type { SharedFormConfig } from '../shared/v2Config';
import { createFormEngine, loadFormModel } from './formEngine';
import type { SharedFormModel } from './models';
import { useT } from './locale';

export interface FormMetadata {
  key: string;
  collections: CollectionOptions[];
}
export function NativeForm({
  config,
  metadata,
  formKey,
  editable = false,
  onModel,
  onSubmitted,
}: {
  config: SharedFormConfig;
  metadata: FormMetadata;
  formKey: string;
  editable?: boolean;
  onModel?: (model: SharedFormModel | undefined) => void;
  onSubmitted?: () => void;
}) {
  const parent = useFlowEngine();
  const t = useT();
  const [value, setValue] = useState<{ engine: FlowEngine; model: SharedFormModel }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let engine: FlowEngine;
    let model: SharedFormModel;
    setValue(undefined);
    setFailed(false);
    onModel?.(undefined);
    async function load() {
      try {
        engine = await createFormEngine(parent, editable, formKey, () => {
          if (active) onSubmitted?.();
        });
        const manager = engine.context.dataSourceManager;
        if (!manager.getDataSource(metadata.key)) manager.addDataSource({ key: metadata.key });
        const source = manager.getDataSource(metadata.key);
        metadata.collections.forEach((collection) => source.upsertCollection(collection));
        model = await loadFormModel(engine, config);
        if (!active) {
          engine.removeModelWithSubModels(model.uid);
          return;
        }
        setValue({ engine, model });
        onModel?.(model);
      } catch {
        if (active) setFailed(true);
      }
    }
    load();
    return () => {
      active = false;
      onModel?.(undefined);
      if (model) engine.removeModelWithSubModels(model.uid);
    };
  }, [parent, config, metadata, formKey, editable, onModel, onSubmitted]);
  if (failed) return <Alert type="error" showIcon message={t('Unable to load the native form')} />;
  if (!value) return <Spin />;
  return (
    <FlowEngineProvider engine={value.engine}>
      <FlowModelRenderer model={value.model} hideRemoveInSettings showFlowSettings={editable} />
    </FlowEngineProvider>
  );
}
