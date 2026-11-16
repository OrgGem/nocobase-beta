// SPDX-License-Identifier: Apache-2.0

import type { APIClient } from '@nocobase/client-v2';
import type { DashboardConfig, WorkRecord } from './dashboardData';

export async function loadDashboardRecords(
  api: Pick<APIClient, 'request'>,
  config: DashboardConfig,
  fields: Array<{ name: string; target?: string }>,
): Promise<WorkRecord[]> {
  if (!config.collection) return [];
  const appends = fields
    .filter((field) => field.target && field.name === config.assigneeField)
    .map((field) => field.name);
  const sortField = config.updatedAtField || config.createdAtField;
  const response = await api.request<{ data: WorkRecord[] }>({
    url: `${config.collection}:list`,
    method: 'get',
    headers: { 'X-Data-Source': config.dataSource || 'main' },
    params: { pageSize: 200, appends, sort: sortField ? [`-${sortField}`] : undefined },
  });
  return Array.isArray(response.data.data) ? response.data.data : [];
}
