// SPDX-License-Identifier: Apache-2.0

/** Retain the import used by the preserved V1 entry. NocoBase 2.2.30 handles registered charts, preview and events natively. */
export async function patchDataVisualizationChartBlock(flowEngine: {
  getModelClassAsync(name: string): Promise<unknown>;
}) {
  await flowEngine.getModelClassAsync('ChartBlockModel');
}
