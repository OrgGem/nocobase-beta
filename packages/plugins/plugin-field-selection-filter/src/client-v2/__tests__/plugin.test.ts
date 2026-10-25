/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient, SelectFieldModel } from '@nocobase/client-v2';
import { describe, expect, it, vi } from 'vitest';
import Plugin from '../plugin';

describe('Selection filter native V2 flow', () => {
  it('filters enum choices by the row record and restores all choices when the scope is removed', async () => {
    const app = createMockClient();
    await new Plugin({}, app).load();
    app.flowEngine.registerModels({ SelectFieldModel });
    const model = app.flowEngine.createModel<SelectFieldModel>({ use: 'SelectFieldModel' });
    const choices = [
      { value: 'a', label: 'A', city: 1 },
      { value: 'b', label: 'B', city: 2 },
    ];
    model.context.defineProperty('collectionField', { value: { interface: 'select', uiSchema: { enum: choices } } });
    const onChange = vi.fn();
    model.setProps({ value: 'b', onChange });
    const step = model.getFlow('fieldSelectionOptionFilterSettings').steps.optionScope;
    const handler = step.handler;
    await handler({ model, record: { city: 1 } } as unknown as Parameters<typeof handler>[0], {
      sourceFieldPath: 'city',
      optionPath: 'city',
    });
    expect(model.props.options).toEqual([choices[0]]);
    expect(onChange).toHaveBeenCalledWith(undefined);
    await handler({ model } as unknown as Parameters<typeof handler>[0], {});
    expect(model.props.options).toEqual(choices);
  });
});
