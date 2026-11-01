/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/** Retain the import used by the preserved V1 entry. NocoBase 2.2.30 handles registered charts, preview and events natively. */
export async function patchDataVisualizationChartBlock(flowEngine: {
  getModelClassAsync(name: string): Promise<unknown>;
}) {
  await flowEngine.getModelClassAsync('ChartBlockModel');
}
