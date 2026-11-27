// SPDX-License-Identifier: Apache-2.0

import type { Application } from '@nocobase/server';
import {
  createProblem,
  LC_RULESET_ID,
  LC_RULESET_VERSION,
  parsePageRangeString,
  UCP600_ISBP821_RULES,
  VALID_LC_RULE_IDS,
  type CoverageOutcome,
  type DocumentInputPlanItem,
  type PageSelectionSpec,
  type UsageMetrics,
  type WaitState,
} from '../contracts/du-contracts';
import type { ServiceConfig } from '../types';
import {
  ArtifactStorageService,
  DuHttpError,
  type ArtifactRecord,
  type ParsedDocument,
} from './ArtifactStorageService';

interface LlmMessage {
  role: 'system' | 'user';
  content: unknown;
}

interface LlmResponseLike {
  content?: unknown;
  usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  response_metadata?: {
    tokenUsage?: {
      promptTokens?: number;
      completionTokens?: number;
    };
  };
}

interface AiManagerRuntime {
  resolveModel?: (model?: { llmService?: string; model?: string } | null) => Promise<{
    llmService: string;
    model: string;
  }>;
  getLLMService: (options: { llmService: string; model: string }) => Promise<{
    provider: {
      invoke: (context: { messages: LlmMessage[] }) => Promise<LlmResponseLike>;
    };
    model: string;
  }>;
  listAllEnabledModels?: () => Promise<
    Array<{
      llmService: string;
      llmServiceTitle: string;
      provider: string;
      enabledModels: Array<{ label: string; value: string }>;
    }>
  >;
}

export interface EngineExecutionContext {
  operationId: string;
  tenantId: string;
  businessId: string;
  action: string;
  input: Record<string, unknown>;
  artifacts: ArtifactRecord[];
  planItems: DocumentInputPlanItem[];
  config: ServiceConfig;
  resumedInput?: Record<string, unknown>;
  checkpointData?: Record<string, unknown>;
  userId?: number;
  onProgress?: (percent: number, message: string) => Promise<void>;
}

export type EngineExecutionOutcome =
  | {
      kind: 'completed';
      outputPayload: Record<string, unknown>;
      extraOutputArtifacts: ArtifactRecord[];
      coverageOutcomes: CoverageOutcome[];
      usage: UsageMetrics;
      warnings: string[];
    }
  | {
      kind: 'waiting_input';
      waitState: WaitState;
      checkpointData: Record<string, unknown>;
      usage: UsageMetrics;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isRecord(part) && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function parseJsonFromLlm(rawText: string): Record<string, unknown> {
  const trimmed = rawText.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const sliced = candidate.slice(firstBrace, lastBrace + 1);
      const parsed: unknown = JSON.parse(sliced);
      return isRecord(parsed) ? parsed : { value: parsed };
    }
    throw new Error('Model response did not contain valid JSON output');
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runWorker = async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

function computeLineDiff(sourceText: string, targetText: string) {
  const a = sourceText.split(/\r?\n/);
  const b = targetText.split(/\r?\n/);
  const diffLines: string[] = [];
  let additions = 0;
  let deletions = 0;
  let unchangedLines = 0;

  // Bounded LCS for reasonable document sizes; linear scan fallback for huge files.
  if (a.length * b.length <= 400_000) {
    const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        diffLines.push(`  ${a[i]}`);
        unchangedLines += 1;
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        diffLines.push(`- ${a[i]}`);
        deletions += 1;
        i += 1;
      } else {
        diffLines.push(`+ ${b[j]}`);
        additions += 1;
        j += 1;
      }
    }
    while (i < a.length) {
      diffLines.push(`- ${a[i]}`);
      deletions += 1;
      i += 1;
    }
    while (j < b.length) {
      diffLines.push(`+ ${b[j]}`);
      additions += 1;
      j += 1;
    }
  } else {
    const maxLen = Math.max(a.length, b.length);
    for (let k = 0; k < maxLen; k += 1) {
      if (k < a.length && k < b.length && a[k] === b[k]) {
        diffLines.push(`  ${a[k]}`);
        unchangedLines += 1;
      } else {
        if (k < a.length) {
          diffLines.push(`- ${a[k]}`);
          deletions += 1;
        }
        if (k < b.length) {
          diffLines.push(`+ ${b[k]}`);
          additions += 1;
        }
      }
    }
  }

  return {
    unifiedDiff: diffLines.join('\n'),
    additions,
    deletions,
    unchangedLines,
  };
}

function redactTextLocally(text: string, patterns: readonly string[]): string {
  let output = text;
  const normalized = patterns.length > 0 ? patterns : ['CCCD', 'PHONE_NUMBER', 'EMAIL'];

  for (const patternName of normalized) {
    const upper = patternName.toUpperCase();
    if (upper === 'CCCD' || upper === 'ID_CARD') {
      output = output.replace(/\b\d{12}\b/g, '[REDACTED]').replace(/\b\d{9}\b/g, '[REDACTED]');
    } else if (upper === 'PHONE' || upper === 'PHONE_NUMBER') {
      output = output.replace(/(?:\+?84|0)(?:3|5|7|8|9)\d{8}\b/g, '[REDACTED]');
    } else if (upper === 'EMAIL') {
      output = output.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED]');
    } else if (upper === 'BANK_ACCOUNT' || upper === 'CARD_NUMBER') {
      output = output.replace(/\b\d{10,19}\b/g, '[REDACTED]');
    } else if (upper === 'TAX_ID') {
      output = output.replace(/\b\d{10}(?:-\d{3})?\b/g, '[REDACTED]');
    } else {
      try {
        const customRe = new RegExp(patternName, 'gi');
        output = output.replace(customRe, '[REDACTED]');
      } catch {
        // Ignore invalid user regex pattern
      }
    }
  }
  return output;
}

function mergeTemplateLocally(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, rawPath: string) => {
    const val = rawPath.split('.').reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), variables);
    if (val === undefined || val === null) return '';
    return typeof val === 'object' ? JSON.stringify(val) : String(val);
  });
}

function markdownToSimpleHtml(md: string): string {
  const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/^/, '<p>')
    .concat('</p>');
}

class UsageAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private model = 'local-deterministic';
  private provider = 'builtin';
  private measured = false;

  add(params: { inputTokens: number; outputTokens: number; model: string; provider?: string; measured: boolean }) {
    this.inputTokens += params.inputTokens;
    this.outputTokens += params.outputTokens;
    this.model = params.model;
    if (params.provider) this.provider = params.provider;
    if (params.measured) this.measured = true;
  }

  toMetrics(): UsageMetrics {
    // Approximate $1.50 / 1M input + $6.00 / 1M output when provider does not emit USD billing
    const costMicrousd = Math.round(this.inputTokens * 1.5 + this.outputTokens * 6);
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costMicrousd,
      costStatus:
        this.inputTokens === 0 && this.outputTokens === 0 ? 'final' : this.measured ? 'measured' : 'estimated',
      model: this.model,
      provider: this.provider,
      measurement: this.measured || (this.inputTokens === 0 && this.outputTokens === 0) ? 'measured' : 'estimated',
    };
  }
}

export class BuiltinBusinessEngine {
  private readonly app: Application;
  private readonly artifactStorage: ArtifactStorageService;
  private readonly runSchemaPipeline?: (
    pipelineRef: { pipelineId?: number; pipelineName?: string },
    input: Record<string, unknown>,
    userId?: number,
  ) => Promise<Record<string, unknown>>;

  constructor(
    app: Application,
    artifactStorage: ArtifactStorageService,
    runSchemaPipeline?: (
      pipelineRef: { pipelineId?: number; pipelineName?: string },
      input: Record<string, unknown>,
      userId?: number,
    ) => Promise<Record<string, unknown>>,
  ) {
    this.app = app;
    this.artifactStorage = artifactStorage;
    this.runSchemaPipeline = runSchemaPipeline;
  }

  resolveAiManager(): AiManagerRuntime | null {
    const appWithAi = this.app as Application & { aiManager?: unknown };
    const candidates: unknown[] = [
      appWithAi.aiManager,
      this.app.pm?.get?.('@nocobase/plugin-ai')?.aiManager,
      this.app.pm?.get?.('ai')?.aiManager,
    ];
    for (const candidate of candidates) {
      if (candidate && typeof (candidate as AiManagerRuntime).getLLMService === 'function') {
        return candidate as AiManagerRuntime;
      }
    }
    return null;
  }

  async listAvailableLlmServices(): Promise<
    Array<{
      llmService: string;
      llmServiceTitle: string;
      provider: string;
      enabledModels: Array<{ label: string; value: string }>;
    }>
  > {
    const aiManager = this.resolveAiManager();
    if (!aiManager?.listAllEnabledModels) return [];
    try {
      return await aiManager.listAllEnabledModels();
    } catch {
      return [];
    }
  }

  private async invokeLlm(params: {
    config: ServiceConfig;
    systemPrompt: string;
    userContent: string | Array<Record<string, unknown>>;
    vision?: boolean;
    usage: UsageAccumulator;
  }): Promise<string> {
    const aiManager = this.resolveAiManager();
    if (!aiManager) {
      throw new DuHttpError(
        createProblem(
          503,
          'TEMPORARY_UNAVAILABLE',
          'NocoBase @nocobase/plugin-ai LLM service is not configured or enabled for built-in AI execution',
        ),
      );
    }

    const preferredService = params.vision
      ? params.config.visionLlmService || params.config.llmService
      : params.config.llmService;
    const preferredModel = params.vision
      ? params.config.visionLlmModel || params.config.llmModel
      : params.config.llmModel;

    let resolved: { llmService: string; model: string };
    if (preferredService && preferredModel) {
      resolved = { llmService: preferredService, model: preferredModel };
    } else if (aiManager.resolveModel) {
      try {
        resolved = await aiManager.resolveModel(
          preferredService && preferredModel ? { llmService: preferredService, model: preferredModel } : null,
        );
      } catch (err) {
        throw new DuHttpError(
          createProblem(
            503,
            'TEMPORARY_UNAVAILABLE',
            err instanceof Error ? err.message : 'No enabled LLM service found in NocoBase AI settings',
          ),
        );
      }
    } else {
      throw new DuHttpError(
        createProblem(503, 'TEMPORARY_UNAVAILABLE', 'Please configure an active LLM service and model in NocoBase'),
      );
    }

    const { provider, model } = await aiManager.getLLMService(resolved);
    const response = await provider.invoke({
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userContent },
      ],
    });

    const text = extractMessageText(response.content);
    const metaIn = response.usage_metadata?.input_tokens ?? response.response_metadata?.tokenUsage?.promptTokens;
    const metaOut = response.usage_metadata?.output_tokens ?? response.response_metadata?.tokenUsage?.completionTokens;
    const measured = typeof metaIn === 'number' || typeof metaOut === 'number';
    const serializedUser =
      typeof params.userContent === 'string' ? params.userContent : JSON.stringify(params.userContent);

    params.usage.add({
      inputTokens:
        typeof metaIn === 'number' ? metaIn : Math.ceil((params.systemPrompt.length + serializedUser.length) / 4),
      outputTokens: typeof metaOut === 'number' ? metaOut : Math.ceil(text.length / 4),
      model: model || resolved.model,
      provider: resolved.llmService,
      measured,
    });

    return text;
  }

  private async invokeLlmJson(params: {
    config: ServiceConfig;
    systemPrompt: string;
    userContent: string | Array<Record<string, unknown>>;
    vision?: boolean;
    usage: UsageAccumulator;
  }): Promise<Record<string, unknown>> {
    const raw = await this.invokeLlm({
      ...params,
      systemPrompt: `${params.systemPrompt}\nReturn ONLY valid JSON without markdown commentary.`,
    });
    return parseJsonFromLlm(raw);
  }

  private resolveSelectionForArtifact(
    artifactId: string,
    planItems: readonly DocumentInputPlanItem[],
    fallbackPagesSpec?: string,
  ): PageSelectionSpec {
    const planItem = planItems.find((p) => p.artifactId === artifactId);
    if (planItem) return planItem.selection;
    if (fallbackPagesSpec && fallbackPagesSpec.trim()) {
      const ranges = parsePageRangeString(fallbackPagesSpec);
      if (ranges.length > 0) {
        return { kind: 'ranges', ranges };
      }
    }
    return { kind: 'all' };
  }

  private async readAndOcrDocuments(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    options: { forceVisionOcr?: boolean; digitize?: boolean } = {},
  ): Promise<{ docs: ParsedDocument[]; outcomes: CoverageOutcome[] }> {
    const pagesInput = typeof ctx.input.pages === 'string' ? ctx.input.pages : undefined;
    const docs: ParsedDocument[] = [];
    const outcomes: CoverageOutcome[] = [];

    for (const artifact of ctx.artifacts) {
      const selection = this.resolveSelectionForArtifact(artifact.artifactId, ctx.planItems, pagesInput);
      const parsed = await this.artifactStorage.parseArtifactPages(artifact, selection);

      if (
        (options.forceVisionOcr || options.digitize || parsed.requiresVision) &&
        (!parsed.text.trim() || options.digitize || options.forceVisionOcr)
      ) {
        const buffer = this.artifactStorage.readArtifactBuffer(artifact);
        if (artifact.mimeType.startsWith('image/')) {
          const prompt = options.digitize
            ? 'Digitize this handwritten/printed form accurately, preserving all labels, values, and checkbox states ([x]/[ ]) in clean Markdown.'
            : 'Transcribe all visible text, tables, headers, and stamps from this document image into clean Markdown.';
          const ocrMd = await this.invokeLlm({
            config: ctx.config,
            systemPrompt: prompt,
            vision: true,
            usage,
            userContent: [
              {
                type: 'image_url',
                image_url: { url: `data:${artifact.mimeType};base64,${buffer.toString('base64')}` },
              },
            ],
          });
          parsed.markdown = ocrMd.trim();
          parsed.text = ocrMd.trim();
          parsed.parser = options.digitize ? 'vision-digitize' : 'vision-ocr';
        } else if (parsed.text.trim() && options.digitize) {
          const digitized = await this.invokeLlm({
            config: ctx.config,
            systemPrompt:
              'Normalize and structure all form fields, checkboxes, and tables from this raw document text into clean Markdown.',
            userContent: parsed.text,
            usage,
          });
          parsed.markdown = digitized.trim();
          parsed.text = digitized.trim();
          parsed.parser = 'llm-digitize';
        }
      }

      docs.push(parsed);
      outcomes.push({
        artifactId: artifact.artifactId,
        selection,
        status: 'processed',
        pagesProcessed: parsed.selectedPages.map((p) => p.pageNumber),
        outputRefs: [],
      });
    }

    return { docs, outcomes };
  }

  async execute(ctx: EngineExecutionContext): Promise<EngineExecutionOutcome> {
    const usage = new UsageAccumulator();
    const warnings: string[] = [];

    if (ctx.businessId === 'lc-checker') {
      return this.executeLcChecker(ctx, usage, warnings);
    }
    if (ctx.businessId === 'example-review') {
      return this.executeExampleReview(ctx, usage, warnings);
    }
    if (ctx.businessId !== 'document-core') {
      throw new DuHttpError(createProblem(404, 'NOT_FOUND', `Unknown businessId "${ctx.businessId}"`));
    }

    switch (ctx.action) {
      case 'ingest':
        return this.executeIngest(ctx, usage, warnings);
      case 'extract':
        return this.executeExtract(ctx, usage, warnings);
      case 'analyze':
        return this.executeAnalyze(ctx, usage, warnings);
      case 'transform':
        return this.executeTransform(ctx, usage, warnings);
      case 'generate':
        return this.executeGenerate(ctx, usage, warnings);
      case 'compare':
        return this.executeCompare(ctx, usage, warnings);
      case 'disbursement':
        return this.executeDisbursementWorkflow(ctx, usage, warnings);
      case 'doc-compare':
        return this.executeDocCompareWorkflow(ctx, usage, warnings);
      case 'schema-workflow':
        return this.executeSchemaWorkflow(ctx, usage, warnings);
      default:
        throw new DuHttpError(createProblem(422, 'INVALID_SCHEMA', `Unsupported document-core action "${ctx.action}"`));
    }
  }

  private async executeIngest(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    warnings: string[],
  ): Promise<EngineExecutionOutcome> {
    if (ctx.artifacts.length === 0) {
      throw new DuHttpError(createProblem(422, 'INVALID_SCHEMA', 'ingest requires at least one input artifact'));
    }

    const mode = String(ctx.input.mode || 'parse');
    if (!['parse', 'ocr', 'digitize', 'split'].includes(mode)) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', `Invalid ingest mode "${mode}"`, {
          errors: [{ pointer: '/input/mode', message: 'Expected parse | ocr | digitize | split' }],
        }),
      );
    }

    if (mode === 'split') {
      const target = ctx.artifacts[0];
      const parsedAll = await this.artifactStorage.parseArtifactPages(target, { kind: 'all' });
      const rawPages =
        typeof ctx.input.pages === 'string' && ctx.input.pages.trim()
          ? ctx.input.pages
          : `1-${parsedAll.totalPageCount}`;
      let ranges;
      try {
        ranges = parsePageRangeString(rawPages, 500);
      } catch (err) {
        throw new DuHttpError(createProblem(422, 'INVALID_SCHEMA', err instanceof Error ? err.message : String(err)));
      }

      const extraOutputArtifacts: ArtifactRecord[] = [];
      const splitArtifacts: Array<{
        artifactId: string;
        fileName: string;
        pageCount: number;
        pageRange: string;
      }> = [];

      const effectiveRanges = ranges.length > 0 ? ranges : [{ from: 1, to: parsedAll.totalPageCount }];
      for (let idx = 0; idx < effectiveRanges.length; idx += 1) {
        const range = effectiveRanges[idx];
        const slice = await this.artifactStorage.parseArtifactPages(target, { kind: 'ranges', ranges: [range] });
        const partName = `part-${idx + 1}-pages-${range.from}-${range.to}.md`;
        const createdPart = await this.artifactStorage.createReadyArtifactFromBuffer({
          tenantId: ctx.tenantId,
          operationId: ctx.operationId,
          role: 'output',
          fileName: partName,
          mimeType: 'text/markdown',
          buffer: Buffer.from(slice.markdown || slice.text, 'utf8'),
          userId: ctx.userId,
        });
        extraOutputArtifacts.push(createdPart);
        splitArtifacts.push({
          artifactId: createdPart.artifactId,
          fileName: partName,
          pageCount: slice.selectedPages.length,
          pageRange: `${range.from}-${range.to}`,
        });
      }

      return {
        kind: 'completed',
        outputPayload: {
          version: 'document-core-result-v1',
          splitArtifacts,
          metadata: {
            pageCount: parsedAll.totalPageCount,
            detectedFormat: parsedAll.detectedFormat,
            parser: parsedAll.parser,
            provenance: 'split',
          },
        },
        extraOutputArtifacts,
        coverageOutcomes: [
          {
            artifactId: target.artifactId,
            selection: { kind: 'ranges', ranges: effectiveRanges },
            status: 'processed',
            outputRefs: extraOutputArtifacts.map((a) => a.artifactId),
          },
        ],
        usage: usage.toMetrics(),
        warnings,
      };
    }

    const { docs, outcomes } = await this.readAndOcrDocuments(ctx, usage, {
      forceVisionOcr: mode === 'ocr',
      digitize: mode === 'digitize',
    });

    const markdown = docs.map((d) => (docs.length > 1 ? `## ${d.fileName}\n\n${d.markdown}` : d.markdown)).join('\n\n');
    const text = docs.map((d) => d.text).join('\n\n');
    const totalPages = docs.reduce((sum, d) => sum + d.selectedPages.length, 0);

    return {
      kind: 'completed',
      outputPayload: {
        version: 'document-core-result-v1',
        markdown,
        text,
        metadata: {
          pageCount: totalPages,
          detectedFormat: docs[0]?.detectedFormat || 'unknown',
          parser: docs[0]?.parser || 'local',
          provenance: mode,
        },
      },
      extraOutputArtifacts: [],
      coverageOutcomes: outcomes,
      usage: usage.toMetrics(),
      warnings,
    };
  }

  private async executeExtract(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    warnings: string[],
  ): Promise<EngineExecutionOutcome> {
    const variant = String(ctx.input.type || 'invoice');
    if (!['invoice', 'contract', 'id-card', 'receipt', 'table', 'custom'].includes(variant)) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', `Invalid extract type "${variant}"`, {
          errors: [{ pointer: '/input/type', message: 'Invalid enum value' }],
        }),
      );
    }

    const inlineText = typeof ctx.input.text === 'string' ? ctx.input.text : '';
    const { docs, outcomes } =
      ctx.artifacts.length > 0 ? await this.readAndOcrDocuments(ctx, usage) : { docs: [], outcomes: [] };
    const combinedText = [inlineText, ...docs.map((d) => `### File: ${d.fileName}\n${d.markdown || d.text}`)]
      .filter(Boolean)
      .join('\n\n');

    if (!combinedText.trim()) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', 'No document content or input text provided for extract'),
      );
    }

    const schemaPrompts: Record<string, string> = {
      invoice:
        'Extract invoice fields as JSON: { "supplier": {"name","taxId","address"}, "buyer": {"name","taxId","address"}, "invoiceNumber": string, "invoiceDate": string, "lineItems": [{"description","quantity","unitPrice","amount"}], "subtotal": number, "vatRate": number, "vatAmount": number, "total": number, "currency": string }.',
      contract:
        'Extract contract fields as JSON: { "contractNumber": string, "title": string, "effectiveDate": string, "expiryDate": string, "parties": [{"role","name","representative"}], "contractValue": {"amount": number, "currency": string}, "keyObligations": string[], "penaltyClauses": string[] }.',
      'id-card':
        'Extract identity card / passport fields as JSON: { "documentType": string, "idNumber": string, "fullName": string, "dateOfBirth": string, "gender": string, "nationality": string, "placeOfOrigin": string, "placeOfResidence": string, "issueDate": string, "expiryDate": string }.',
      receipt:
        'Extract receipt fields as JSON: { "merchantName": string, "receiptDate": string, "items": [{"name","quantity","price"}], "total": number, "currency": string, "paymentMethod": string }.',
      table:
        'Extract all tables from the document as JSON: { "tables": [{ "title": string, "headers": string[], "rows": string[][] }] }.',
      custom: `Extract structured JSON matching this specification: ${JSON.stringify(
        ctx.input.schema || ctx.input.fields || { summary: 'string' },
      )}.`,
    };

    const data = await this.invokeLlmJson({
      config: ctx.config,
      systemPrompt: `You are a high-precision Document Understanding extraction engine.\n${schemaPrompts[variant]}`,
      userContent: combinedText,
      usage,
    });

    return {
      kind: 'completed',
      outputPayload: {
        version: 'document-core-result-v1',
        data,
        provenance: { slot: 'reasoning', action: 'extract', variant },
      },
      extraOutputArtifacts: [],
      coverageOutcomes: outcomes,
      usage: usage.toMetrics(),
      warnings,
    };
  }

  private async executeAnalyze(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    warnings: string[],
  ): Promise<EngineExecutionOutcome> {
    const task = String(ctx.input.task || 'classify');
    if (!['classify', 'sentiment', 'compliance', 'fact-check', 'quality', 'risk', 'summarize-eval'].includes(task)) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', `Invalid analyze task "${task}"`, {
          errors: [{ pointer: '/input/task', message: 'Invalid enum value' }],
        }),
      );
    }

    const inlineText = typeof ctx.input.text === 'string' ? ctx.input.text : '';
    const { docs, outcomes } =
      ctx.artifacts.length > 0 ? await this.readAndOcrDocuments(ctx, usage) : { docs: [], outcomes: [] };
    const combinedText = [inlineText, ...docs.map((d) => `### File: ${d.fileName}\n${d.markdown || d.text}`)]
      .filter(Boolean)
      .join('\n\n');

    const taskPrompts: Record<string, string> = {
      classify: `Classify the document into categories (${JSON.stringify(
        ctx.input.categories || ['invoice', 'contract', 'report', 'id-card', 'other'],
      )}). Return JSON: { "category": string, "confidence": number, "reasoning": string }.`,
      sentiment:
        'Analyze document sentiment. Return JSON: { "sentiment": "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED", "confidence": number, "keyPhrases": string[], "summary": string }.',
      compliance: `Evaluate compliance against criteria: ${JSON.stringify(
        ctx.input.criteria || [],
      )}. Return JSON: { "verdict": "PASS" | "FAIL" | "WARNING", "summary": string, "violations": [{"rule": string, "severity": string, "detail": string}] }.`,
      'fact-check': `Cross-check the document against referenceData: ${JSON.stringify(
        ctx.input.referenceData ?? ctx.input.reference_data ?? {},
      )}. Return JSON: { "verdict": "PASS" | "FAIL", "summary": string, "checks": [{"field": string, "status": "PASS" | "FAIL" | "UNVERIFIED", "detail": string}] }.`,
      quality:
        'Score document writing & structural quality (0-100). Return JSON: { "score": number, "dimensions": {"clarity": number, "completeness": number, "consistency": number}, "recommendations": string[] }.',
      risk: `Assess legal and operational risk (focus: ${String(
        ctx.input.focus || 'general',
      )}). Return JSON: { "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL", "summary": string, "riskFactors": [{"clause": string, "severity": string, "mitigation": string}] }.`,
      'summarize-eval':
        'Summarize the document and evaluate the author perspective, strengths, and limitations. Return JSON: { "summary": string, "perspective": string, "strengths": string[], "limitations": string[] }.',
    };

    const data = await this.invokeLlmJson({
      config: ctx.config,
      systemPrompt: `You are an enterprise Document Understanding analysis engine.\n${taskPrompts[task]}`,
      userContent: combinedText,
      usage,
    });

    return {
      kind: 'completed',
      outputPayload: {
        version: 'document-core-result-v1',
        data,
        provenance: { slot: 'reasoning', action: 'analyze', variant: task },
      },
      extraOutputArtifacts: [],
      coverageOutcomes: outcomes,
      usage: usage.toMetrics(),
      warnings,
    };
  }

  private async executeTransform(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    warnings: string[],
  ): Promise<EngineExecutionOutcome> {
    // Support both canonical `variant` and legacy alias `action`
    const variant = String(ctx.input.variant || ctx.input.action || 'convert');
    if (!['convert', 'translate', 'rewrite', 'redact', 'template'].includes(variant)) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', `Invalid transform variant "${variant}"`, {
          errors: [{ pointer: '/input/variant', message: 'Invalid enum value' }],
        }),
      );
    }

    const inlineText = typeof ctx.input.text === 'string' ? ctx.input.text : '';
    const { docs, outcomes } =
      ctx.artifacts.length > 0 ? await this.readAndOcrDocuments(ctx, usage) : { docs: [], outcomes: [] };
    const sourceText = [inlineText, ...docs.map((d) => d.markdown || d.text)].filter(Boolean).join('\n\n');
    const outputFormat = String(ctx.input.outputFormat || ctx.input.output_format || 'text');

    let transformedText = sourceText;
    let slot: string | undefined;

    if (variant === 'convert') {
      if (outputFormat === 'html') {
        transformedText = markdownToSimpleHtml(sourceText);
      } else if (outputFormat === 'json') {
        transformedText = JSON.stringify({ paragraphs: sourceText.split(/\n{2,}/).filter(Boolean) }, null, 2);
      } else {
        transformedText = sourceText;
      }
    } else if (variant === 'template') {
      const tpl =
        typeof ctx.input.templateText === 'string' && ctx.input.templateText ? ctx.input.templateText : sourceText;
      const vars = isRecord(ctx.input.variables)
        ? ctx.input.variables
        : isRecord(ctx.input.template)
          ? ctx.input.template
          : {};
      transformedText = mergeTemplateLocally(tpl, vars);
    } else if (variant === 'redact') {
      const rawPatterns = ctx.input.redactPatterns ?? ctx.input.redact_patterns;
      const patterns = Array.isArray(rawPatterns)
        ? rawPatterns.map(String)
        : typeof rawPatterns === 'string'
          ? rawPatterns.split(',').map((s) => s.trim())
          : ['CCCD', 'PHONE_NUMBER', 'EMAIL'];
      transformedText = redactTextLocally(sourceText, patterns);
      if (ctx.input.useAi === true) {
        slot = 'reasoning';
        transformedText = await this.invokeLlm({
          config: ctx.config,
          systemPrompt: `Redact all sensitive PII matching ${JSON.stringify(
            patterns,
          )} by replacing sensitive values with [REDACTED]. Preserve all other text verbatim.`,
          userContent: transformedText,
          usage,
        });
      }
    } else if (variant === 'translate') {
      slot = 'reasoning';
      const targetLang = String(ctx.input.targetLanguage || ctx.input.target_language || 'en');
      const tone = String(ctx.input.tone || 'professional');
      transformedText = await this.invokeLlm({
        config: ctx.config,
        systemPrompt: `Translate the document accurately into "${targetLang}" with a "${tone}" tone. Preserve Markdown structure and numbers.`,
        userContent: sourceText,
        usage,
      });
    } else if (variant === 'rewrite') {
      slot = 'reasoning';
      const style = String(ctx.input.style || 'executive');
      const tone = String(ctx.input.tone || 'clear');
      transformedText = await this.invokeLlm({
        config: ctx.config,
        systemPrompt: `Rewrite the document in "${style}" style and "${tone}" tone while preserving factual accuracy.`,
        userContent: sourceText,
        usage,
      });
    }

    return {
      kind: 'completed',
      outputPayload: {
        version: 'document-core-result-v1',
        data: {
          transformedText,
          outputFormat,
        },
        provenance: { ...(slot ? { slot } : {}), action: 'transform', variant },
      },
      extraOutputArtifacts: [],
      coverageOutcomes: outcomes,
      usage: usage.toMetrics(),
      warnings,
    };
  }

  private async executeGenerate(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    warnings: string[],
  ): Promise<EngineExecutionOutcome> {
    const task = String(ctx.input.task || 'summary');
    if (!['summary', 'outline', 'report', 'email', 'minutes', 'qa'].includes(task)) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', `Invalid generate task "${task}"`, {
          errors: [{ pointer: '/input/task', message: 'Invalid enum value' }],
        }),
      );
    }

    const inlineText = typeof ctx.input.text === 'string' ? ctx.input.text : '';
    const { docs, outcomes } =
      ctx.artifacts.length > 0 ? await this.readAndOcrDocuments(ctx, usage) : { docs: [], outcomes: [] };
    const combinedText = [inlineText, ...docs.map((d) => `### File: ${d.fileName}\n${d.markdown || d.text}`)]
      .filter(Boolean)
      .join('\n\n');

    const prompts: Record<string, string> = {
      summary: `Generate a ${String(ctx.input.format || 'bullets')} summary in at most ${Number(
        ctx.input.maxWords ?? ctx.input.max_words ?? 300,
      )} words${
        ctx.input.audience ? ` for audience "${String(ctx.input.audience)}"` : ''
      }. Return JSON: { "summary": string, "keyPoints": string[] }.`,
      outline:
        'Extract a hierarchical outline of the document. Return JSON: { "sections": [{ "level": number, "title": string, "summary": string }] }.',
      report: `Generate an executive analytical report (focus: ${String(
        ctx.input.focus || 'comprehensive',
      )}). Return JSON: { "title": string, "markdownReport": string, "highlights": string[] }.`,
      email: `Draft a "${String(
        ctx.input.tone || 'formal',
      )}" email based on the document. Return JSON: { "subject": string, "body": string }.`,
      minutes:
        'Generate structured meeting minutes. Return JSON: { "title": string, "summary": string, "decisions": string[], "actionItems": [{"task": string, "owner": string, "dueDate": string}] }.',
      qa: `Answer each question grounded strictly in the document with verbatim evidence quotes: ${JSON.stringify(
        ctx.input.questions || [],
      )}. Return JSON: { "answers": [{ "question": string, "answer": string, "evidenceQuote": string, "confidence": number }] }.`,
    };

    const data = await this.invokeLlmJson({
      config: ctx.config,
      systemPrompt: `You are a grounded Document Understanding generation engine.\n${prompts[task]}`,
      userContent: combinedText,
      usage,
    });

    return {
      kind: 'completed',
      outputPayload: {
        version: 'document-core-result-v1',
        data,
        provenance: { slot: 'reasoning', action: 'generate', variant: task },
      },
      extraOutputArtifacts: [],
      coverageOutcomes: outcomes,
      usage: usage.toMetrics(),
      warnings,
    };
  }

  private async executeCompare(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    warnings: string[],
  ): Promise<EngineExecutionOutcome> {
    const mode = String(ctx.input.mode || 'diff');
    if (!['diff', 'semantic', 'version'].includes(mode)) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', `Invalid compare mode "${mode}"`, {
          errors: [{ pointer: '/input/mode', message: 'Invalid enum value' }],
        }),
      );
    }

    const { docs, outcomes } =
      ctx.artifacts.length > 0 ? await this.readAndOcrDocuments(ctx, usage) : { docs: [], outcomes: [] };
    const sourceText =
      (isRecord(ctx.input.source) && typeof ctx.input.source.text === 'string' ? ctx.input.source.text : undefined) ??
      docs[0]?.text ??
      '';
    const targetText =
      (isRecord(ctx.input.target) && typeof ctx.input.target.text === 'string' ? ctx.input.target.text : undefined) ??
      docs[1]?.text ??
      '';

    if (docs.length < 2 && (!sourceText || !targetText)) {
      throw new DuHttpError(createProblem(422, 'INVALID_SCHEMA', 'compare requires two documents (source and target)'));
    }

    if (mode === 'diff') {
      const diffData = computeLineDiff(sourceText, targetText);
      return {
        kind: 'completed',
        outputPayload: {
          version: 'document-core-result-v1',
          data: diffData,
          provenance: { action: 'compare', variant: 'diff' },
        },
        extraOutputArtifacts: [],
        coverageOutcomes: outcomes,
        usage: usage.toMetrics(),
        warnings,
      };
    }

    const prompt =
      mode === 'semantic'
        ? `Compare SOURCE vs TARGET clauses${
            ctx.input.focus ? ` focusing on "${String(ctx.input.focus)}"` : ''
          }. Return JSON: { "changes": [{ "clauseTitle": string, "sourceExcerpt": string, "targetExcerpt": string, "changeType": "ADDED" | "REMOVED" | "MODIFIED", "legalSignificance": "NEGLIGIBLE" | "MODERATE" | "HIGH", "commentary": string }] }.`
        : 'Generate a version changelog between SOURCE and TARGET. Return JSON: { "summary": string, "breakingChanges": string[], "additions": string[], "modifications": string[], "removals": string[] }.';

    const data = await this.invokeLlmJson({
      config: ctx.config,
      systemPrompt: prompt,
      userContent: `=== SOURCE ===\n${sourceText}\n\n=== TARGET ===\n${targetText}`,
      usage,
    });

    return {
      kind: 'completed',
      outputPayload: {
        version: 'document-core-result-v1',
        data,
        provenance: { slot: 'reasoning', action: 'compare', variant: mode },
      },
      extraOutputArtifacts: [],
      coverageOutcomes: outcomes,
      usage: usage.toMetrics(),
      warnings,
    };
  }

  private async executeDisbursementWorkflow(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    warnings: string[],
  ): Promise<EngineExecutionOutcome> {
    const maxConcurrency = Math.min(8, Math.max(1, Number(ctx.input.maxConcurrency) || 4));
    const requireApproval = ctx.input.requireApproval === true;

    let perFileRecords: Array<{ fileName: string; docType: string; extracted: Record<string, unknown> }> = [];
    let outcomes: CoverageOutcome[] = [];

    if (ctx.checkpointData && Array.isArray(ctx.checkpointData.perFileRecords)) {
      perFileRecords = ctx.checkpointData.perFileRecords as typeof perFileRecords;
      outcomes = (ctx.checkpointData.outcomes as CoverageOutcome[]) || [];
    } else {
      await ctx.onProgress?.(20, 'Classifying and extracting disbursement documents');
      const parsedBundle = await this.readAndOcrDocuments(ctx, usage);
      outcomes = parsedBundle.outcomes;

      perFileRecords = await mapWithConcurrency(parsedBundle.docs, maxConcurrency, async (doc) => {
        const res = await this.invokeLlmJson({
          config: ctx.config,
          systemPrompt:
            'Classify this credit disbursement document (e.g. promissory_note, vat_invoice, disbursement_request, contract, resolution) and extract key financial fields. Return JSON: { "docType": string, "extracted": Record<string, unknown> }.',
          userContent: `File: ${doc.fileName}\n\n${doc.markdown || doc.text}`,
          usage,
        });
        return {
          fileName: doc.fileName,
          docType: typeof res.docType === 'string' ? res.docType : 'supporting_document',
          extracted: isRecord(res.extracted) ? res.extracted : res,
        };
      });

      if (requireApproval && !ctx.resumedInput) {
        return {
          kind: 'waiting_input',
          waitState: {
            waitId: 'approval-wait',
            prompt: 'Review extracted disbursement records before cross-checking against credit approval.',
            inputSchema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean', default: true },
                approver: { type: 'string' },
                note: { type: 'string' },
              },
              required: ['approved'],
            },
            previewData: { perFileRecords },
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          },
          checkpointData: { perFileRecords, outcomes },
          usage: usage.toMetrics(),
        };
      }
    }

    if (ctx.resumedInput && ctx.resumedInput.approved === false) {
      throw new DuHttpError(
        createProblem(
          409,
          'STATE_CONFLICT',
          `Disbursement rejected by reviewer: ${String(ctx.resumedInput.note || '')}`,
        ),
      );
    }

    await ctx.onProgress?.(70, 'Cross-checking extracted evidence against referenceData');
    const referenceData = ctx.input.referenceData ?? ctx.input.resolution_data ?? [];
    const synthesis = await this.invokeLlmJson({
      config: ctx.config,
      systemPrompt:
        'Cross-check the extracted disbursement documents against referenceData and write a Vietnamese appraisal report. Return JSON: { "findings": [{"key": string, "status": "match" | "mismatch" | "unresolved", "detail": string}], "report": string }.',
      userContent: JSON.stringify({
        referenceData,
        extractedDocuments: perFileRecords,
        reviewerDecision: ctx.resumedInput,
      }),
      usage,
    });

    const findings = Array.isArray(synthesis.findings) ? (synthesis.findings as Array<Record<string, unknown>>) : [];
    const matchedCount = findings.filter((f) => f.status === 'match').length;
    const mismatchedCount = findings.filter((f) => f.status === 'mismatch').length;

    return {
      kind: 'completed',
      outputPayload: {
        resultVersion: 'disbursement-result-v1',
        businessId: 'document-core',
        businessVersion: '2.0.0',
        report: typeof synthesis.report === 'string' ? synthesis.report : '# BÁO CÁO ĐỐI CHIẾU HỒ SƠ GIẢI NGÂN',
        crosscheck: {
          findings,
          matchedCount,
          mismatchedCount,
        },
        evidence: {
          filesAnalyzed: perFileRecords.length,
          logicalDocumentCount: perFileRecords.length,
          extractedRecordCount: perFileRecords.length,
          perFile: perFileRecords.map((r) => ({ fileName: r.fileName, docType: r.docType })),
        },
        failedChildren: [],
      },
      extraOutputArtifacts: [],
      coverageOutcomes: outcomes,
      usage: usage.toMetrics(),
      warnings,
    };
  }

  private async executeDocCompareWorkflow(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    warnings: string[],
  ): Promise<EngineExecutionOutcome> {
    let comparisonPayload: Record<string, unknown>;
    let outcomes: CoverageOutcome[] = [];

    if (ctx.checkpointData && isRecord(ctx.checkpointData.comparisonPayload)) {
      comparisonPayload = ctx.checkpointData.comparisonPayload;
      outcomes = (ctx.checkpointData.outcomes as CoverageOutcome[]) || [];
    } else {
      const parsedBundle = await this.readAndOcrDocuments(ctx, usage);
      outcomes = parsedBundle.outcomes;
      if (parsedBundle.docs.length < 2) {
        throw new DuHttpError(createProblem(422, 'INVALID_SCHEMA', 'doc-compare workflow requires 2 input artifacts'));
      }
      const chunkSize = Math.min(200_000, Math.max(200, Number(ctx.input.chunkSizeChars) || 8_000));
      const src = (parsedBundle.docs[0].markdown || parsedBundle.docs[0].text).slice(0, chunkSize * 4);
      const tgt = (parsedBundle.docs[1].markdown || parsedBundle.docs[1].text).slice(0, chunkSize * 4);

      comparisonPayload = await this.invokeLlmJson({
        config: ctx.config,
        systemPrompt:
          'Perform deep structural and cross-reference comparison between two long documents. Return JSON: { "structureClaims": [{"section": string, "status": "unchanged" | "modified" | "added" | "removed" | "moved", "detail": string}], "referenceClaims": [{"reference": string, "status": "resolved" | "unresolved" | "contradicted", "detail": string}], "report": string }.',
        userContent: `=== SOURCE (${parsedBundle.docs[0].fileName}) ===\n${src}\n\n=== TARGET (${parsedBundle.docs[1].fileName}) ===\n${tgt}`,
        usage,
      });

      if (ctx.input.requireHumanReview === true && !ctx.resumedInput) {
        return {
          kind: 'waiting_input',
          waitState: {
            waitId: 'doc-compare-review',
            prompt: 'Confirm structural and cross-reference comparison claims before finalizing.',
            inputSchema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean', default: true },
                note: { type: 'string' },
              },
              required: ['approved'],
            },
            previewData: comparisonPayload,
          },
          checkpointData: { comparisonPayload, outcomes },
          usage: usage.toMetrics(),
        };
      }
    }

    return {
      kind: 'completed',
      outputPayload: {
        resultVersion: 'doc-compare-result-v1',
        businessId: 'document-core',
        businessVersion: '2.0.0',
        ...comparisonPayload,
        reviewerDecision: ctx.resumedInput ?? null,
      },
      extraOutputArtifacts: [],
      coverageOutcomes: outcomes,
      usage: usage.toMetrics(),
      warnings,
    };
  }

  private async executeSchemaWorkflow(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    warnings: string[],
  ): Promise<EngineExecutionOutcome> {
    if (!this.runSchemaPipeline) {
      throw new DuHttpError(createProblem(501, 'NOT_IMPLEMENTED', 'Dynamic pipeline runner is not attached'));
    }
    const pipelineId = typeof ctx.input.pipelineId === 'number' ? ctx.input.pipelineId : undefined;
    const pipelineName = typeof ctx.input.pipelineName === 'string' ? ctx.input.pipelineName : undefined;
    const params = isRecord(ctx.input.parameters) ? ctx.input.parameters : ctx.input;
    const result = await this.runSchemaPipeline({ pipelineId, pipelineName }, params, ctx.userId);
    return {
      kind: 'completed',
      outputPayload: {
        resultVersion: 'schema-workflow-result-v1',
        businessId: 'document-core',
        businessVersion: '2.0.0',
        data: result,
      },
      extraOutputArtifacts: [],
      coverageOutcomes: [],
      usage: usage.toMetrics(),
      warnings,
    };
  }

  /**
   * `lc-checker@1.2.0` — 5-step Trade Finance examination:
   * 1. ocr -> 2. screen -> 3. visual -> 4. adjudicate (UCP 600 / ISBP 821) -> 5. Vietnamese report
   */
  private async executeLcChecker(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    warnings: string[],
  ): Promise<EngineExecutionOutcome> {
    if (ctx.artifacts.length === 0) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', 'lc-checker requires at least one L/C presentation document'),
      );
    }
    if (ctx.artifacts.length > 50) {
      throw new DuHttpError(createProblem(422, 'INVALID_SCHEMA', 'lc-checker accepts at most 50 presentation files'));
    }

    // Step 1: OCR / Parse
    await ctx.onProgress?.(15, 'Step 1/5: OCR & text extraction');
    const { docs, outcomes } = await this.readAndOcrDocuments(ctx, usage, { forceVisionOcr: true });
    const filesWithoutOcrText = docs.filter((d) => !d.text.trim()).map((d) => d.fileName);
    const totalOcrChars = docs.reduce((sum, d) => sum + d.text.length, 0);

    // Step 2: Screen text & request visual checks (max 24, must cite valid ruleId)
    await ctx.onProgress?.(35, 'Step 2/5: Screening presentation & identifying visual checks');
    const rulesCatalogSummary = UCP600_ISBP821_RULES.map((r) => `${r.ruleId}: ${r.title} - ${r.description}`).join(
      '\n',
    );
    const combinedDocsText = docs.map((d) => `=== DOCUMENT: ${d.fileName} ===\n${d.markdown || d.text}`).join('\n\n');

    const screenResult = await this.invokeLlmJson({
      config: ctx.config,
      systemPrompt: `You are a Trade Finance L/C examiner screening documents against UCP 600 / ISBP 821.\nAvailable Rule Registry:\n${rulesCatalogSummary}\nReturn JSON: { "documentsPresent": string[], "documentsMissing": string[], "visualRequests": [{ "document": string, "check": string, "ruleId": string }] }. Cite ONLY ruleIds from the registry (max 24 visualRequests).`,
      userContent: combinedDocsText,
      usage,
    });

    const rawVisualRequests = Array.isArray(screenResult.visualRequests)
      ? (screenResult.visualRequests as Array<Record<string, unknown>>).slice(0, 24)
      : [];
    const validVisualRequests = rawVisualRequests.filter(
      (req) => typeof req.ruleId === 'string' && VALID_LC_RULE_IDS.has(req.ruleId),
    );

    // Step 3: Visual verification on image artifacts (or text attestation if digital-only)
    await ctx.onProgress?.(55, 'Step 3/5: Executing visual verification checks');
    const outstandingVisualChecks: Array<{ document: string; check: string; ruleId: string; reason: string }> = [];
    let satisfiedVisualCount = 0;

    for (const vReq of validVisualRequests) {
      const docName = String(vReq.document || '');
      const checkDesc = String(vReq.check || '');
      const ruleId = String(vReq.ruleId);
      const matchedArtifact = ctx.artifacts.find((a) => a.fileName === docName) || ctx.artifacts[0];

      if (matchedArtifact && matchedArtifact.mimeType.startsWith('image/')) {
        const imgBuf = this.artifactStorage.readArtifactBuffer(matchedArtifact);
        const vRes = await this.invokeLlmJson({
          config: ctx.config,
          vision: true,
          systemPrompt:
            'Verify the requested visual feature (signature, stamp, endorsement) on this document image. Return JSON: { "satisfied": boolean, "observation": string }.',
          userContent: [
            { type: 'text', text: `Check "${checkDesc}" under rule ${ruleId}` },
            {
              type: 'image_url',
              image_url: { url: `data:${matchedArtifact.mimeType};base64,${imgBuf.toString('base64')}` },
            },
          ],
          usage,
        });
        if (vRes.satisfied === true) {
          satisfiedVisualCount += 1;
        } else {
          outstandingVisualChecks.push({
            document: docName,
            check: checkDesc,
            ruleId,
            reason: String(vRes.observation || 'Visual element could not be confirmed'),
          });
        }
      } else {
        // Digital PDF/text without raster image inspection -> record as satisfied if text explicitly attests signature, else outstanding
        const matchedDoc = docs.find((d) => d.fileName === docName);
        if (matchedDoc && /sign|stamp|ký|đóng dấu/i.test(matchedDoc.text)) {
          satisfiedVisualCount += 1;
        } else {
          outstandingVisualChecks.push({
            document: docName || (docs[0]?.fileName ?? 'presentation'),
            check: checkDesc,
            ruleId,
            reason: 'Requires physical/raster visual inspection of signature or endorsement',
          });
        }
      }
    }

    // Step 4 & 5: Adjudicate against UCP 600 / ISBP 821 + Vietnamese report
    await ctx.onProgress?.(80, 'Step 4-5/5: Adjudicating UCP 600 / ISBP 821 compliance & generating Vietnamese report');
    const adjudication = await this.invokeLlmJson({
      config: ctx.config,
      systemPrompt: `Adjudicate the L/C presentation strictly under UCP 600 / ISBP 821.\nAllowed ruleIds ONLY:\n${Array.from(
        VALID_LC_RULE_IDS,
      ).join(
        ', ',
      )}\nReturn JSON: { "verdict": "COMPLIANT" | "DISCREPANT", "discrepancies": [{ "id": string, "severity": "MAJOR" | "MINOR" | "ADVISORY", "document": string, "field": string, "issue": string, "ruleId": string, "recommendation": string }], "summary": string, "report": string (detailed Markdown report in Vietnamese) }.`,
      userContent: JSON.stringify({
        documents: docs.map((d) => ({ fileName: d.fileName, content: d.markdown || d.text })),
        outstandingVisualChecks,
      }),
      usage,
    });

    const rawDiscrepancies = Array.isArray(adjudication.discrepancies)
      ? (adjudication.discrepancies as Array<Record<string, unknown>>)
      : [];

    // Enforce hard invariant: every discrepancy MUST cite a valid registered ruleId
    const verifiedDiscrepancies = rawDiscrepancies.map((disc, index) => {
      const cited =
        typeof disc.ruleId === 'string' && VALID_LC_RULE_IDS.has(disc.ruleId) ? disc.ruleId : 'UCP600-ART14-A';
      if (cited !== disc.ruleId) {
        warnings.push(`Normalized unregistered rule citation "${String(disc.ruleId)}" to UCP600-ART14-A.`);
      }
      const severityRaw = String(disc.severity || 'MAJOR').toUpperCase();
      const severity = ['MAJOR', 'MINOR', 'ADVISORY'].includes(severityRaw) ? severityRaw : 'MAJOR';
      return {
        id: String(disc.id || `DISC-${String(index + 1).padStart(2, '0')}`),
        severity,
        document: String(disc.document || docs[0]?.fileName || 'unknown'),
        field: String(disc.field || 'General'),
        issue: String(disc.issue || ''),
        ruleId: cited,
        recommendation: String(disc.recommendation || 'Xin ý kiến chấp nhận bất hợp lệ hoặc tu chỉnh chứng từ.'),
      };
    });

    const majorDiscrepancies = verifiedDiscrepancies.filter((d) => d.severity === 'MAJOR').length;
    const minorDiscrepancies = verifiedDiscrepancies.filter((d) => d.severity === 'MINOR').length;
    const advisoryCount = verifiedDiscrepancies.filter((d) => d.severity === 'ADVISORY').length;
    const totalDiscrepancies = verifiedDiscrepancies.length;

    // Hard state-machine safety rule from BRD Section 2.4:
    // Never conclude COMPLIANT if outstandingVisualChecks remain or major/minor discrepancies exist!
    const canBeCompliant = outstandingVisualChecks.length === 0 && majorDiscrepancies === 0 && minorDiscrepancies === 0;
    const verdict = canBeCompliant && adjudication.verdict === 'COMPLIANT' ? 'COMPLIANT' : 'DISCREPANT';
    const citedRuleIds = Array.from(new Set(verifiedDiscrepancies.map((d) => d.ruleId)));

    return {
      kind: 'completed',
      outputPayload: {
        resultVersion: 'lc-checker-result-v1',
        businessId: 'lc-checker',
        businessVersion: '1.2.0',
        verdict,
        recommendation: verdict === 'COMPLIANT' ? 'PROCEED_TO_HUMAN_SIGN_OFF' : 'RESERVE_FOR_REVIEW',
        totalDiscrepancies,
        majorDiscrepancies,
        minorDiscrepancies,
        advisoryCount,
        documentsPresent: Array.isArray(screenResult.documentsPresent)
          ? screenResult.documentsPresent
          : docs.map((d) => d.fileName),
        documentsMissing: Array.isArray(screenResult.documentsMissing) ? screenResult.documentsMissing : [],
        discrepancies: verifiedDiscrepancies,
        summary:
          typeof adjudication.summary === 'string'
            ? adjudication.summary
            : `Phát hiện ${totalDiscrepancies} điểm lưu ý/bất hợp lệ.`,
        report:
          typeof adjudication.report === 'string'
            ? adjudication.report
            : '# BÁO CÁO KIỂM TRA BỘ CHỨNG TỪ TÍN DỤNG THƯ (L/C)',
        evidence: {
          filesSubmitted: ctx.artifacts.length,
          filesOcred: docs.length,
          filesWithoutOcrText,
          totalOcrChars,
          ruleSetId: LC_RULESET_ID,
          ruleSetVersion: String(ctx.input.ruleSetVersion || LC_RULESET_VERSION),
          ruleSetStatus: 'PROVISIONAL',
          citedRuleIds,
          visualVerification: {
            requested: validVisualRequests.length,
            satisfied: satisfiedVisualCount,
            complete: outstandingVisualChecks.length === 0,
          },
        },
        humanSignOffRequired: true,
        outstandingVisualChecks,
        failedChildren: [],
      },
      extraOutputArtifacts: [],
      coverageOutcomes: outcomes,
      usage: usage.toMetrics(),
      warnings,
    };
  }

  /**
   * `example-review@1.0.0` — Multi-document compliance review (1..10 files) with optional HITL approval.
   */
  private async executeExampleReview(
    ctx: EngineExecutionContext,
    usage: UsageAccumulator,
    warnings: string[],
  ): Promise<EngineExecutionOutcome> {
    if (ctx.artifacts.length < 1 || ctx.artifacts.length > 10) {
      throw new DuHttpError(createProblem(422, 'INVALID_SCHEMA', 'example-review requires between 1 and 10 documents'));
    }

    const reviewId = String(ctx.input.reviewId || ctx.operationId);
    let itemReviews: Array<Record<string, unknown>> = [];
    let outcomes: CoverageOutcome[] = [];

    if (ctx.checkpointData && Array.isArray(ctx.checkpointData.itemReviews)) {
      itemReviews = ctx.checkpointData.itemReviews as Array<Record<string, unknown>>;
      outcomes = (ctx.checkpointData.outcomes as CoverageOutcome[]) || [];
    } else {
      const parsedBundle = await this.readAndOcrDocuments(ctx, usage);
      outcomes = parsedBundle.outcomes;
      const useAi = ctx.input.useAi !== false && Boolean(this.resolveAiManager());

      itemReviews = await mapWithConcurrency(parsedBundle.docs, 4, async (doc) => {
        if (!useAi) {
          return {
            fileName: doc.fileName,
            format: doc.detectedFormat,
            pageCount: doc.selectedPages.length,
            charCount: doc.text.length,
            status: doc.text.length > 0 ? 'PASS' : 'EMPTY',
          };
        }
        const aiItem = await this.invokeLlmJson({
          config: ctx.config,
          systemPrompt: `Review this document item against criteria ${JSON.stringify(
            ctx.input.criteria || ['completeness', 'consistency'],
          )}. Return JSON: { "status": "PASS" | "REVIEW_REQUIRED", "summary": string, "issues": string[] }.`,
          userContent: `File: ${doc.fileName}\n\n${doc.markdown || doc.text}`,
          usage,
        });
        return {
          fileName: doc.fileName,
          format: doc.detectedFormat,
          pageCount: doc.selectedPages.length,
          ...aiItem,
        };
      });

      if (ctx.input.requireApproval === true && !ctx.resumedInput) {
        return {
          kind: 'waiting_input',
          waitState: {
            waitId: 'compliance-officer-approval',
            prompt: 'Compliance Officer approval required to finalize multi-document review.',
            inputSchema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean', default: true },
                approver: { type: 'string' },
                comment: { type: 'string' },
              },
              required: ['approved'],
            },
            previewData: { reviewId, items: itemReviews },
          },
          checkpointData: { itemReviews, outcomes },
          usage: usage.toMetrics(),
        };
      }
    }

    return {
      kind: 'completed',
      outputPayload: {
        resultVersion: 'example-review-result-v1',
        businessId: 'example-review',
        businessVersion: '1.0.0',
        reviewId,
        approved: ctx.resumedInput ? Boolean(ctx.resumedInput.approved) : true,
        approverDecision: ctx.resumedInput ?? null,
        items: itemReviews,
      },
      extraOutputArtifacts: [],
      coverageOutcomes: outcomes,
      usage: usage.toMetrics(),
      warnings,
    };
  }
}
