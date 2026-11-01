/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient } from '@nocobase/client-v2';
import NativeVisualization from '@nocobase/plugin-data-visualization/client-v2';
import { ChartBlockModel } from '../../../../@nocobase/plugin-data-visualization/src/client-v2/flow/models/ChartBlockModel';
import { describe, expect, it, vi } from 'vitest';
import Plugin from '../plugin';

describe('advanced chart integration with the 2.2.30 native chart model', () => {
  it('registers the chart group once and keeps native preview, rendering and event flows intact', async () => {
    const app = createMockClient();
    const native = new NativeVisualization({}, app);
    vi.spyOn(app.pm, 'get').mockReturnValue(native);
    const methods = {
      preview: ChartBlockModel.prototype.onPreview,
      render: ChartBlockModel.prototype.renderComponent,
      events: ChartBlockModel.prototype.applyEvents,
    };
    const plugin = new Plugin({}, app);
    await plugin.load();
    await plugin.load();
    expect(native.charts.getChart('advanced-charts.radar')).toBeDefined();
    expect(ChartBlockModel.prototype.onPreview).toBe(methods.preview);
    expect(ChartBlockModel.prototype.renderComponent).toBe(methods.render);
    expect(ChartBlockModel.prototype.applyEvents).toBe(methods.events);
    app.flowEngine.registerModels({ ChartBlockModel });
    const model = app.flowEngine.createModel<ChartBlockModel>({ use: 'ChartBlockModel' });
    model.context.defineProperty('resource', { value: { getData: () => [{ count: 7 }] } });
    await model.applyChartOptions({
      mode: 'basic',
      query: {},
      builder: { type: 'advanced-charts.advanced-statistic', field: 'count' },
    });
    expect(model.props.chart.option.value).toBe(7);
    expect(model.props.chart.Component).toBeDefined();
    vi.restoreAllMocks();
  });
});
