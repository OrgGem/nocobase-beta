/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient } from '@nocobase/client-v2';
import { describe, expect, it } from 'vitest';
import { TimelineBlockModel } from '../models/TimelineBlockModel';

function fixture() {
  const app = createMockClient();
  app.flowEngine.registerModels({ TimelineBlockModel });
  app.flowEngine.context.dataSourceManager.getDataSource('main').addCollection({
    name: 'events',
    fields: [
      { name: 'occurredAt', type: 'date', interface: 'datetime' },
      { name: 'title', type: 'string', interface: 'input' },
    ],
  });
  const model = app.flowEngine.createModel<TimelineBlockModel>({
    use: 'TimelineBlockModel',
    stepParams: {
      resourceSettings: { init: { dataSourceKey: 'main', collectionName: 'events' } },
      timelineSettings: { fields: { date: 'occurredAt', title: 'title' }, order: { order: 'desc' } },
    },
  });
  app.apiMock.onGet('events:list').reply(200, { data: [], meta: { count: 0 } });
  return { app, model };
}
describe('Timeline native V2 query', () => {
  it('uses native field metadata and applies the persisted date/order before the first query', async () => {
    const { app, model } = fixture();
    expect(model.getFieldOptions(['date'])).toEqual([{ label: 'occurredAt', value: 'occurredAt' }]);
    await model.resource.refresh();
    expect(app.apiMock.history.get[0].params.sort).toEqual(['-occurredAt']);
  });
  it('changes the server sort and resets pagination when changing order', async () => {
    const { app, model } = fixture();
    model.resource.setPage(4);
    model.setProps({ order: 'asc' });
    await model.refreshQuery();
    expect(app.apiMock.history.get[0].params).toMatchObject({ sort: ['occurredAt'], page: 1 });
  });
});
