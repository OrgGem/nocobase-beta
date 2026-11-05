/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { FlowEngine } from '@nocobase/flow-engine';
import { expect, it, vi } from 'vitest';
import { CrossJoinBlockModel } from '../CrossJoinBlockModel';

vi.mock('@nocobase/client-v2', async () => {
  const { FlowModel } = await import('@nocobase/flow-engine');
  return { BlockModel: class extends FlowModel {} };
});
vi.mock('../CrossJoinConfigurator', () => ({ CrossJoinConfigurator: () => null }));

it('keeps the mapping modal closed on render and opens it only from the settings menu', async () => {
  const engine = new FlowEngine();
  engine.registerModels({ CrossJoinBlockModel });
  const model = engine.createModel<CrossJoinBlockModel>({ use: 'CrossJoinBlockModel' });
  const open = vi.spyOn(model, 'openConfigurator');
  vi.spyOn(model, 'rerender').mockResolvedValue(undefined);
  await model.dispatchEvent('beforeRender');
  expect(open).not.toHaveBeenCalled();
  const items = await CrossJoinBlockModel.getExtraMenuItems(model, (key) => key);
  const edit = items.find((item) => item.key === 'cross-join-edit-mapping');
  expect(edit?.label).toBe('Edit mapping');
  edit.onClick();
  expect(open).toHaveBeenCalledOnce();
  model.closeConfigurator();
  await model.dispatchEvent('beforeRender');
  expect(open).toHaveBeenCalledOnce();
});
