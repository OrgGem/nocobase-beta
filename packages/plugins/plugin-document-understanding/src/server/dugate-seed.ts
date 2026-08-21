/**
 * DUGate-compatible seed data: pre-configured endpoints and pipelines for all
 * 6 core profiles + 3 workflow profiles.
 *
 * Endpoint subpaths are RELATIVE to the configured Service Config `baseUrl`
 * (e.g. `http://localhost:2023/api/v1/docs`). Workflows route to
 * `/api/v1/docs/workflows` automatically. To point at a different gateway,
 * change the base URL in the admin UI — the seeded paths stay untouched.
 */

import type { Database } from '@nocobase/database';

interface EndpointSeed {
  name: string;
  subpath: string;
  method: 'POST';
  description: string;
  fileInputMode: 'none' | 'multipart' | 'base64';
  fileFieldName?: string;
  maxFiles: number;
  executionMode: 'sync' | 'polling' | 'webhook';
  discriminatorField?: string;
  discriminatorValue?: string;
  /** Added for every sync-capable endpoint so DUGate returns immediately. */
  syncQueryParam?: string;
  /** DUGate 202 response: `{name: "operations/{id}", done: false}` → extract `id` from `name`. */
  taskIdExtractPath?: string;
  taskIdExtractRegex?: string;
  /** Polling: GET /api/v1/operations/{taskId} */
  pollResultSubpath?: string;
  pollTaskIdField?: string;
  pollResultField?: string;
  pollStatusField?: string;
  pollCompletedValue?: string;
  pollInterval?: number;
  pollTimeout?: number;
  enabled?: boolean;
}

interface PipelineSeed {
  name: string;
  description: string;
  inputSchema?: any;
  outputMapping?: any;
  enabled?: boolean;
  steps: Array<{
    stepOrder: number;
    name: string;
    endpointName: string;
    outputAlias?: string;
    inputMapping?: any;
    onError?: 'fail' | 'skip' | 'retry';
    retryCount?: number;
  }>;
}

const DEFAULT_POLL_INTERVAL = 3000;
const DEFAULT_POLL_TIMEOUT = 300_000;

/** Shared async config for DUGate endpoints that support async mode. */
const asyncConfig = {
  taskIdExtractPath: 'name',
  taskIdExtractRegex: 'operations/([^/]+)',
  pollResultSubpath: '/api/v1/operations/{taskId}',
  pollTaskIdField: 'id',
  pollResultField: 'result',
  pollStatusField: 'metadata.state',
  pollCompletedValue: 'SUCCEEDED',
  pollInterval: DEFAULT_POLL_INTERVAL,
  pollTimeout: DEFAULT_POLL_TIMEOUT,
};

function coreEndpoint(
  service: string,
  discriminatorValue: string,
  overrides: Partial<EndpointSeed> & { name: string },
): EndpointSeed {
  const { name, ...rest } = overrides;
  return {
    name,
    subpath: `/api/v1/docs/${service}`,
    method: 'POST',
    fileInputMode: 'multipart',
    fileFieldName: 'files[]',
    maxFiles: 10,
    executionMode: 'sync',
    discriminatorField:
      discriminatorValue === 'diff' || discriminatorValue === 'semantic' || discriminatorValue === 'version'
        ? 'mode'
        : ['parse', 'ocr', 'digitize', 'split'].includes(discriminatorValue)
          ? 'mode'
          : ['invoice', 'contract', 'id-card', 'receipt', 'table', 'custom'].includes(discriminatorValue)
            ? 'type'
            : ['classify', 'sentiment', 'compliance', 'fact-check', 'quality', 'risk', 'summarize-eval'].includes(
                  discriminatorValue,
                )
              ? 'task'
              : ['convert', 'translate', 'rewrite', 'redact', 'template'].includes(discriminatorValue)
                ? 'action'
                : 'mode',
    discriminatorValue,
    syncQueryParam: 'sync',
    ...asyncConfig,
    ...rest,
  } as EndpointSeed;
}

function workflowEndpoint(process: string, overrides: Partial<EndpointSeed> & { name: string }): EndpointSeed {
  const { name, ...rest } = overrides;
  return {
    name,
    subpath: '/api/v1/docs/workflows',
    method: 'POST',
    fileInputMode: 'multipart',
    fileFieldName: 'files[]',
    maxFiles: 10,
    executionMode: 'sync', // Will detect 202 and switch to polling automatically
    discriminatorField: 'process',
    discriminatorValue: process,
    syncQueryParam: 'sync',
    ...asyncConfig,
    ...rest,
  } as EndpointSeed;
}

/**
 * ──── CORE PROFILE ENDPOINTS ──────────────────────────────────
 * 6 profiles: ingest, extract, analyze, transform, generate, compare
 */
const CORE_ENDPOINTS: EndpointSeed[] = [
  // ── ingest ──
  coreEndpoint('ingest', 'parse', {
    name: 'dugate-ingest-parse',
    description:
      'Parse digital documents (PDF/DOCX native), preserve headers, footers, tables. Supports output_format (md/json/html/csv) and language.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('ingest', 'ocr', {
    name: 'dugate-ingest-ocr',
    description: 'OCR scanned documents and images. Supports language parameter.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('ingest', 'digitize', {
    name: 'dugate-ingest-digitize',
    description: 'Digitize handwritten forms, checkboxes.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('ingest', 'split', {
    name: 'dugate-ingest-split',
    description: 'Split/merge PDF pages. Use pages parameter (e.g. "1-5").',
    fileFieldName: 'file',
    maxFiles: 1,
  }),

  // ── extract ──
  coreEndpoint('extract', 'invoice', {
    name: 'dugate-extract-invoice',
    description: 'Extract structured data from Vietnamese VAT invoices / general invoices.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('extract', 'contract', {
    name: 'dugate-extract-contract',
    description: 'Extract parties, terms, obligations, penalties, signatures from contracts.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('extract', 'id-card', {
    name: 'dugate-extract-id-card',
    description: 'Extract identity information from CCCD/Passport.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('extract', 'receipt', {
    name: 'dugate-extract-receipt',
    description: 'Extract merchant, items, totals from receipts.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('extract', 'table', {
    name: 'dugate-extract-table',
    description: 'Extract all tables from documents as structured data.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('extract', 'custom', {
    name: 'dugate-extract-custom',
    description:
      'Extract custom fields using dynamic schema. Use fields (comma-separated) or schema (JSON Schema string).',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),

  // ── analyze ──
  coreEndpoint('analyze', 'classify', {
    name: 'dugate-analyze-classify',
    description: 'Classify documents by taxonomy. Provide categories parameter.',
    maxFiles: 5,
  }),
  coreEndpoint('analyze', 'sentiment', {
    name: 'dugate-analyze-sentiment',
    description: 'Analyze document sentiment: positive, negative, neutral.',
    maxFiles: 5,
  }),
  coreEndpoint('analyze', 'compliance', {
    name: 'dugate-analyze-compliance',
    description: 'Check document compliance against criteria. Provide criteria parameter (semicolon-separated rules).',
    maxFiles: 5,
  }),
  coreEndpoint('analyze', 'fact-check', {
    name: 'dugate-analyze-fact-check',
    description: 'Cross-reference document claims against reference data. Provide reference_data and extract_fields.',
    maxFiles: 5,
  }),
  coreEndpoint('analyze', 'quality', {
    name: 'dugate-analyze-quality',
    description: 'Score document writing quality against criteria.',
    maxFiles: 5,
  }),
  coreEndpoint('analyze', 'risk', {
    name: 'dugate-analyze-risk',
    description: 'Assess document risk level.',
    maxFiles: 5,
  }),
  coreEndpoint('analyze', 'summarize-eval', {
    name: 'dugate-analyze-summarize-eval',
    description: 'Generate expert summary and evaluation of document.',
    maxFiles: 5,
  }),

  // ── transform ──
  coreEndpoint('transform', 'convert', {
    name: 'dugate-transform-convert',
    description: 'Convert document format (DOCX -> MD/HTML). Use output_format parameter.',
    fileFieldName: 'file',
    maxFiles: 1,
  }),
  coreEndpoint('transform', 'translate', {
    name: 'dugate-transform-translate',
    description: 'Translate document to target language. Use target_language and tone parameters.',
    fileFieldName: 'file',
    maxFiles: 1,
  }),
  coreEndpoint('transform', 'rewrite', {
    name: 'dugate-transform-rewrite',
    description:
      'Rewrite/paraphrase document. Use style (academic/executive/simplified/bullet_points) and tone parameters.',
    fileFieldName: 'file',
    maxFiles: 1,
  }),
  coreEndpoint('transform', 'redact', {
    name: 'dugate-transform-redact',
    description: 'Redact PII from document. Use redact_patterns parameter.',
    fileFieldName: 'file',
    maxFiles: 1,
  }),
  coreEndpoint('transform', 'template', {
    name: 'dugate-transform-template',
    description: 'Mail merge using template. Use template parameter (JSON).',
    fileFieldName: 'file',
    maxFiles: 1,
  }),

  // ── generate ──
  coreEndpoint('generate', 'summary', {
    name: 'dugate-generate-summary',
    description:
      'Generate condensed summary. Parameters: format (paragraph/bullets/numbered/table/mind_map), max_words, audience.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('generate', 'outline', {
    name: 'dugate-generate-outline',
    description: 'Extract H1/H2/H3 table of contents.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('generate', 'report', {
    name: 'dugate-generate-report',
    description: 'Generate expert analysis report.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('generate', 'email', {
    name: 'dugate-generate-email',
    description: 'Draft email response based on document. Use tone parameter.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('generate', 'minutes', {
    name: 'dugate-generate-minutes',
    description: 'Generate meeting minutes with action items. Use format parameter.',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),
  coreEndpoint('generate', 'qa', {
    name: 'dugate-generate-qa',
    description: 'Ask questions about document content (RAG-like). Use questions parameter (JSON array).',
    fileFieldName: 'files[]',
    maxFiles: 5,
  }),

  // ── compare ──
  coreEndpoint('compare', 'diff', {
    name: 'dugate-compare-diff',
    description: 'Line-by-line text diff (git-diff style). Requires 2 files via files[]. Use output_format parameter.',
    fileFieldName: 'files[]',
    maxFiles: 2,
  }),
  coreEndpoint('compare', 'semantic', {
    name: 'dugate-compare-semantic',
    description: 'Semantic/legal comparison. Requires 2 files. Use focus parameter for specific concerns.',
    fileFieldName: 'files[]',
    maxFiles: 2,
  }),
  coreEndpoint('compare', 'version', {
    name: 'dugate-compare-version',
    description: 'Summarized changelog between versions. Requires 2 files. Use output_format parameter.',
    fileFieldName: 'files[]',
    maxFiles: 2,
  }),
];

/**
 * ──── WORKFLOW PROFILE ENDPOINTS ──────────────────────────────
 * 3 workflow profiles: disbursement, lc-checker, doc-compare
 */
const WORKFLOW_ENDPOINTS: EndpointSeed[] = [
  workflowEndpoint('disbursement', {
    name: 'dugate-workflow-disbursement',
    description:
      'Disbursement reconciliation: classify files, extract data, cross-check resolution, generate disbursement memo.',
    maxFiles: 10,
  }),
  workflowEndpoint('lc-checker', {
    name: 'dugate-workflow-lc-checker',
    description:
      'Letter of Credit document checking: validate documents against LC terms, detect discrepancies per UCP 600.',
    maxFiles: 10,
  }),
  workflowEndpoint('doc-compare', {
    name: 'dugate-workflow-doc-compare',
    description:
      'Advanced document comparison: OCR, extract TOC, compare sections, generate comparison report. Requires exactly 2 files.',
    maxFiles: 2,
  }),
];

/**
 * ──── CONVENIENCE PIPELINES ──────────────────────────────────
 * Each pipeline wraps a single endpoint so users can run them via the
 * admin UI playground or invoke them as AI tools.
 *
 * Multi-step pipelines can be added manually from the UI later.
 */
function buildPipelines(epNames: string[]): PipelineSeed[] {
  return epNames.map((epName) => ({
    name: epName
      .replace(/^dugate-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    description: `Execute the DUGate ${epName.replace(/^dugate-/, '')} profile.`,
    enabled: true,
    steps: [
      {
        stepOrder: 1,
        name: 'Call DUGate API',
        endpointName: epName,
        outputAlias: 'result',
        inputMapping: {
          file_urls: '$input.file_urls',
          output_format: '$input.output_format',
          language: '$input.language',
          categories: '$input.categories',
          criteria: '$input.criteria',
          reference_data: '$input.reference_data',
          fields: '$input.fields',
          schema: '$input.schema',
          questions: '$input.questions',
          target_language: '$input.target_language',
          tone: '$input.tone',
          style: '$input.style',
          redact_patterns: '$input.redact_patterns',
          template: '$input.template',
          format: '$input.format',
          max_words: '$input.max_words',
          audience: '$input.audience',
          focus: '$input.focus',
          pages: '$input.pages',
          resolution_data: '$input.resolution_data',
          extract_fields: '$input.extract_fields',
        },
      },
    ],
    outputMapping: {
      content: '$step[result].response.content',
      extracted_data: '$step[result].response.extracted_data',
      usage: '$step[result].response.usage',
    },
  }));
}

export async function seedDugateEndpoints(db: Database): Promise<void> {
  const endpointsRepo = db.getRepository<any>('doc_understanding_endpoints');
  const pipelinesRepo = db.getRepository<any>('doc_understanding_pipelines');
  const stepsRepo = db.getRepository<any>('doc_understanding_pipeline_steps');

  const allEndpoints: EndpointSeed[] = [...CORE_ENDPOINTS, ...WORKFLOW_ENDPOINTS];

  // Upsert each endpoint by name
  const endpointNameToId = new Map<string, number>();
  for (const ep of allEndpoints) {
    const existing = await endpointsRepo.findOne({ filter: { name: ep.name } });
    let record;
    if (existing) {
      await endpointsRepo.update({ filterByTk: existing.id, values: ep });
      record = await endpointsRepo.findOne({ filter: { name: ep.name } });
    } else {
      record = await endpointsRepo.create({ values: ep });
    }
    endpointNameToId.set(ep.name, record.id);
  }

  // Build pipelines for all single-step convenience profiles
  const pipelineNames = allEndpoints.map((e) => e.name);
  const pipelines = buildPipelines(pipelineNames);

  for (const pipeline of pipelines) {
    const existingPipeline = await pipelinesRepo.findOne({ filter: { name: pipeline.name } });
    if (existingPipeline) {
      // Update existing pipeline steps
      await stepsRepo.destroy({ filter: { pipelineId: existingPipeline.id } });
      await pipelinesRepo.update({
        filterByTk: existingPipeline.id,
        values: {
          description: pipeline.description,
          enabled: pipeline.enabled,
          inputSchema: pipeline.inputSchema,
          outputMapping: pipeline.outputMapping,
        },
      });
      for (const step of pipeline.steps) {
        const endpointId = endpointNameToId.get(step.endpointName);
        if (endpointId) {
          await stepsRepo.create({
            values: {
              pipelineId: existingPipeline.id,
              stepOrder: step.stepOrder,
              name: step.name,
              endpointId,
              inputMapping: step.inputMapping || null,
              outputAlias: step.outputAlias || null,
              onError: step.onError || 'fail',
              retryCount: step.retryCount ?? 0,
            },
          });
        }
      }
    } else {
      const created = await pipelinesRepo.create({
        values: {
          name: pipeline.name,
          description: pipeline.description,
          enabled: pipeline.enabled,
          inputSchema: pipeline.inputSchema || null,
          outputMapping: pipeline.outputMapping || null,
        },
      });
      for (const step of pipeline.steps) {
        const endpointId = endpointNameToId.get(step.endpointName);
        if (endpointId) {
          await stepsRepo.create({
            values: {
              pipelineId: created.id,
              stepOrder: step.stepOrder,
              name: step.name,
              endpointId,
              inputMapping: step.inputMapping || null,
              outputAlias: step.outputAlias || null,
              onError: step.onError || 'fail',
              retryCount: step.retryCount ?? 0,
            },
          });
        }
      }
    }
  }
}
