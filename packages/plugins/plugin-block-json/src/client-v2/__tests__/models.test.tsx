/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient, DisplayTitleFieldModel } from '@nocobase/client-v2';
import { FlowEngineProvider, SingleRecordResource } from '@nocobase/flow-engine';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import Plugin from '../plugin';
import { DisplayJsonPreviewFieldModel, JsonBlockModel } from '../models';
import { JsonViewer } from '../models/JsonBlockModel';

afterEach(cleanup);
describe('JSON native V2 models', () => {
  it('instantiates the display model and binds a real single-record resource with persisted settings', async () => {
    const app = createMockClient();
    await new Plugin({}, app).load();
    app.flowEngine.context.dataSourceManager
      .getDataSource('main')
      .addCollection({ name: 'orders', fields: [{ name: 'payload', type: 'json', interface: 'json' }] });
    const block = app.flowEngine.createModel<JsonBlockModel>({
      use: 'JsonBlockModel',
      stepParams: {
        resourceSettings: { init: { dataSourceKey: 'main', collectionName: 'orders' } },
        jsonBlockSettings: { configure: { fieldPath: 'payload' } },
      },
    });
    expect(block.resource).toBeInstanceOf(SingleRecordResource);
    expect(block.resource.getResourceName()).toBe('orders');
    const field = app.flowEngine.createModel<DisplayJsonPreviewFieldModel>({ use: 'DisplayJsonPreviewFieldModel' });
    expect(field).toBeInstanceOf(DisplayTitleFieldModel);
    expect(field.renderComponent({ hello: 'world' })).toBeDefined();
    expect(block.serialize().stepParams.jsonBlockSettings.configure.fieldPath).toBe('payload');
  });
  it('renders valid JSON as a tree and shows parse errors for invalid JSON', () => {
    const app = createMockClient();
    const view = render(
      <FlowEngineProvider engine={app.flowEngine}>
        <JsonViewer value={{ hello: 'world' }} />
      </FlowEngineProvider>,
    );
    expect(screen.getByText('hello')).toBeDefined();
    view.rerender(
      <FlowEngineProvider engine={app.flowEngine}>
        <JsonViewer value="{invalid" />
      </FlowEngineProvider>,
    );
    expect(screen.queryByText('hello')).toBeNull();
    expect(view.container.querySelector('.ant-alert-error')).toBeTruthy();
  });
});
