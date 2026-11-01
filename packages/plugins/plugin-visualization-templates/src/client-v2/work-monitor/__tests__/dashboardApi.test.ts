/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadDashboardRecords } from '../dashboardApi';

describe('V2 dashboard datasource access', () => {
  it('scopes the request to the selected datasource and appends only the mapped association', async () => {
    const rows = [{ id: '9007199254740993' }];
    const request = vi.fn().mockResolvedValue({ data: { data: rows } });
    expect(
      await loadDashboardRecords(
        { request },
        { dataSource: 'warehouse', collection: 'tasks', assigneeField: 'owner', updatedAtField: 'modified' },
        [
          { name: 'owner', target: 'users' },
          { name: 'other', target: 'users' },
        ],
      ),
    ).toBe(rows);
    expect(request).toHaveBeenCalledWith({
      url: 'tasks:list',
      method: 'get',
      headers: { 'X-Data-Source': 'warehouse' },
      params: { pageSize: 200, appends: ['owner'], sort: ['-modified'] },
    });
  });

  it('does not request an undefined collection and propagates denied access rather than reusing another collection data', async () => {
    const request = vi.fn().mockRejectedValue(new Error('forbidden'));
    expect(await loadDashboardRecords({ request }, {}, [])).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    await expect(loadDashboardRecords({ request }, { collection: 'tasks' }, [])).rejects.toThrow('forbidden');
    expect(request.mock.calls[0][0].headers).toEqual({ 'X-Data-Source': 'main' });
  });
});
