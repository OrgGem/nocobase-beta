// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `du-rework` v1 catalog seed & automatic legacy `dugate-*` migration.
 *
 * Seeds all 36 canonical profiles across:
 * - `document-core@2.0.0` (6 core actions / 31 variants + 3 multi-step workflows)
 * - `lc-checker@1.2.0` (UCP 600 / ISBP 821 trade-finance examination)
 * - `example-review@1.0.0` (multi-document compliance review)
 *
 * Automatically upgrades pre-existing `dugate-*` endpoints and convenience pipelines
 * in-place on plugin startup so existing installations move seamlessly to `du-rework` v1.
 */

import type { Database } from '@nocobase/database';
import { DU_BUSINESS_CATALOG, type DuCatalogEntry } from './contracts/du-contracts';

const DEFAULT_POLL_INTERVAL = 3_000;
const DEFAULT_POLL_TIMEOUT = 300_000;

function toEndpointValues(entry: DuCatalogEntry, sortOrder: number) {
  return {
    name: entry.endpointName,
    subpath: `/api/v1/businesses/${entry.businessId}/actions/${entry.action}`,
    method: 'POST' as const,
    description: entry.description,
    requestBodySchema: entry.inputSchema,
    fileInputMode: 'multipart' as const,
    fileFieldName: 'files[]',
    maxFiles: entry.maxFiles,
    executionMode: 'sync' as const,
    protocolMode: 'builtin_du' as const,
    businessId: entry.businessId,
    actionName: entry.action,
    discriminatorField: entry.discriminatorField || null,
    discriminatorValue: entry.discriminatorValue || null,
    syncQueryParam: null,
    taskIdExtractPath: 'operationId',
    taskIdExtractRegex: null,
    pollResultSubpath: '/api/v1/operations/{taskId}',
    pollTaskIdField: 'operationId',
    pollResultField: 'data',
    pollStatusField: 'state',
    pollCompletedValue: 'SUCCEEDED',
    pollInterval: DEFAULT_POLL_INTERVAL,
    pollTimeout: DEFAULT_POLL_TIMEOUT,
    enabled: true,
    sortOrder,
  };
}

function buildInputMappingFromSchema(entry: DuCatalogEntry): Record<string, string> {
  const props =
    entry.inputSchema && typeof entry.inputSchema.properties === 'object' && entry.inputSchema.properties !== null
      ? (entry.inputSchema.properties as Record<string, unknown>)
      : {};
  const mapping: Record<string, string> = {};
  for (const key of Object.keys(props)) {
    if (key === entry.discriminatorField) continue;
    mapping[key] = `$input.${key}`;
  }
  if (entry.action !== 'ingest' || entry.discriminatorValue !== 'split') {
    mapping.pages = '$input.pages';
  }
  return mapping;
}

export async function seedDugateEndpoints(db: Database): Promise<{ endpoints: number; pipelines: number }> {
  const endpointsRepo = db.getRepository('doc_understanding_endpoints');
  const pipelinesRepo = db.getRepository('doc_understanding_pipelines');
  const stepsRepo = db.getRepository('doc_understanding_pipeline_steps');

  const endpointNameToId = new Map<string, number>();

  for (let index = 0; index < DU_BUSINESS_CATALOG.length; index += 1) {
    const entry = DU_BUSINESS_CATALOG[index];
    const values = toEndpointValues(entry, index + 1);

    let existing = await endpointsRepo.findOne({ filter: { name: entry.endpointName } });
    if (!existing && entry.legacyEndpointName) {
      existing = await endpointsRepo.findOne({ filter: { name: entry.legacyEndpointName } });
    }

    let recordId: number;
    if (existing) {
      await endpointsRepo.update({ filterByTk: existing.id, values });
      recordId = Number(existing.id);
    } else {
      const created = await endpointsRepo.create({ values });
      recordId = Number(created.id);
    }
    endpointNameToId.set(entry.endpointName, recordId);
  }

  for (const entry of DU_BUSINESS_CATALOG) {
    const endpointId = endpointNameToId.get(entry.endpointName);
    if (!endpointId) continue;

    const description = `[${entry.businessId}@${entry.businessVersion}] ${entry.description}`;
    const inputMapping = buildInputMappingFromSchema(entry);
    const outputMapping = {
      data: '$step[result].response.data',
      markdown: '$step[result].response.markdown',
      text: '$step[result].response.text',
      report: '$step[result].response.report',
      verdict: '$step[result].response.verdict',
      discrepancies: '$step[result].response.discrepancies',
      usage: '$step[result].response.usage',
    };

    const existingPipeline = await pipelinesRepo.findOne({ filter: { name: entry.pipelineName } });
    if (existingPipeline) {
      await stepsRepo.destroy({ filter: { pipelineId: existingPipeline.id } });
      await pipelinesRepo.update({
        filterByTk: existingPipeline.id,
        values: {
          description,
          enabled: existingPipeline.enabled ?? true,
          inputSchema: entry.inputSchema,
          outputMapping,
        },
      });
      await stepsRepo.create({
        values: {
          pipelineId: existingPipeline.id,
          stepOrder: 1,
          name: `${entry.businessId}/${entry.action}`,
          endpointId,
          inputMapping,
          outputAlias: 'result',
          onError: 'fail',
          retryCount: 0,
        },
      });
    } else {
      const created = await pipelinesRepo.create({
        values: {
          name: entry.pipelineName,
          description,
          enabled: true,
          inputSchema: entry.inputSchema,
          outputMapping,
        },
      });
      await stepsRepo.create({
        values: {
          pipelineId: created.id,
          stepOrder: 1,
          name: `${entry.businessId}/${entry.action}`,
          endpointId,
          inputMapping,
          outputAlias: 'result',
          onError: 'fail',
          retryCount: 0,
        },
      });
    }
  }

  return {
    endpoints: DU_BUSINESS_CATALOG.length,
    pipelines: DU_BUSINESS_CATALOG.length,
  };
}
