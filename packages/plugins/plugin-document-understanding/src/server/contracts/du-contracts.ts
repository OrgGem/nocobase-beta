// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical contracts, catalog definitions, UCP 600 / ISBP 821 rule registry,
 * and Document-Input API v1 (DI-06) helpers for Document Understanding (`du-rework` v1 compatible).
 * Kept runtime-neutral (no Node-only imports) so both server and client-v2 can share types and catalog metadata.
 */

export const DU_OPERATION_STATES = [
  'PENDING_INGESTION',
  'ACCEPTED',
  'QUEUED',
  'RUNNING',
  'WAITING_CHILDREN',
  'WAITING_INPUT',
  'RETRY_PENDING',
  'CANCEL_REQUESTED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const;

export type DuOperationState = (typeof DU_OPERATION_STATES)[number];

export const TERMINAL_OPERATION_STATES: ReadonlySet<DuOperationState> = new Set<DuOperationState>([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);

export type DuArtifactRole = 'input' | 'output' | 'intermediate' | 'source' | 'target';
export type DuArtifactState = 'UPLOADING' | 'READY' | 'ABORTED';

export interface PageRange {
  from: number;
  to: number;
}

export type PageSelectionSpec =
  | { kind: 'all' }
  | {
      kind: 'ranges';
      ranges: PageRange[];
    };

export interface ArtifactPageSelection {
  artifactId: string;
  selection: PageSelectionSpec;
}

export interface DocumentSelection {
  kind: 'requestSelection';
  schemaVersion: 1;
  mode: 'all' | 'subset' | 'combined';
  artifactIds?: string[];
  pageSelections?: ArtifactPageSelection[];
}

export interface DocumentInputPlanItem {
  artifactId: string;
  fileName?: string;
  mimeType?: string;
  selection: PageSelectionSpec;
}

export interface DocumentInputPlan {
  kind: 'documentInputPlan';
  schemaVersion: 1;
  items: DocumentInputPlanItem[];
}

export interface CoverageOutcome {
  artifactId: string;
  selection: PageSelectionSpec;
  status: 'processed' | 'failed';
  pagesProcessed?: number[];
  outputRefs: string[];
  detail?: string;
}

export interface DocumentInputCoverage {
  kind: 'coverageReport';
  schemaVersion: 1;
  planDigest: string;
  status: 'complete' | 'failed';
  outcomes: CoverageOutcome[];
}

export interface SubmissionArtifactRef {
  artifactId: string;
  role?: DuArtifactRole;
}

export interface CallbackConfig {
  url: string;
  mode?: 'notification_only' | 'notification_with_result';
}

export interface SubmissionPayload {
  input: Record<string, unknown>;
  artifacts?: SubmissionArtifactRef[];
  sourceUrl?: string;
  documentSelection?: DocumentSelection;
  callback?: CallbackConfig;
  clientReference?: string;
}

export interface WaitState {
  waitId: string;
  prompt?: string;
  inputSchema?: Record<string, unknown>;
  previewData?: unknown;
  expiresAt?: string;
  resumedAt?: string;
  resumedBy?: string;
  resumedInput?: Record<string, unknown>;
}

export interface OperationProgress {
  percent: number;
  message: string;
}

export interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  costStatus: 'pending' | 'estimated' | 'measured' | 'final' | 'corrected';
  model: string;
  provider?: string;
  measurement: 'estimated' | 'measured';
}

export interface ArtifactEnvelopeItem {
  artifactId: string;
  role: DuArtifactRole;
  fileName?: string;
  mimeType: string;
  sizeBytes: number;
  hashSha256: string;
  download: string;
}

export interface ResultEnvelope {
  schemaVersion: '1';
  data: Record<string, unknown>;
  artifacts: ArtifactEnvelopeItem[];
  usage: UsageMetrics;
  warnings: string[];
}

export interface OperationView {
  id: string;
  name: string;
  businessId: string;
  businessVersion: string;
  action: string;
  state: DuOperationState;
  stateVersion: number;
  correlationId?: string;
  clientReference?: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt?: string;
  progress: OperationProgress;
  wait?: WaitState;
  documentInputCoverage?: DocumentInputCoverage;
  usage?: UsageMetrics;
  error?: ProblemDetails;
  links: {
    self: string;
    result: string;
  };
}

export interface ProblemErrorPointer {
  pointer: string;
  message: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  correlationId?: string;
  errors?: ProblemErrorPointer[];
}

export function createProblem(
  status: number,
  code: string,
  title: string,
  options: { detail?: string; correlationId?: string; errors?: ProblemErrorPointer[] } = {},
): ProblemDetails {
  return {
    type: `urn:du:error:${code.toLowerCase()}`,
    title,
    status,
    code,
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    ...(options.errors && options.errors.length > 0 ? { errors: options.errors } : {}),
  };
}

/**
 * Parse a human-friendly page range string such as "1-3, 5, 7-9" into normalized PageRange[].
 * Throws a descriptive Error if any range is invalid (< 1, inverted, or > 500 pages).
 */
export function parsePageRangeString(spec: string, maxPages = 500): PageRange[] {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') {
    return [];
  }
  const ranges: PageRange[] = [];
  let selectedCount = 0;
  for (const rawPart of trimmed.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) {
      throw new Error(`Invalid page range segment "${part}". Expected "1-5" or "1,3-5".`);
    }
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
      throw new Error(`Invalid page range "${part}": page numbers must be >= 1 and from <= to.`);
    }
    selectedCount += to - from + 1;
    if (selectedCount > maxPages) {
      throw new Error(`Selected page count (${selectedCount}) exceeds maximum allowed (${maxPages}).`);
    }
    ranges.push({ from, to });
  }
  return ranges;
}

export function expandPageRanges(spec: PageSelectionSpec, totalPages: number): number[] {
  if (totalPages <= 0) return [];
  if (spec.kind === 'all') {
    return Array.from({ length: totalPages }, (_, idx) => idx + 1);
  }
  const pageSet = new Set<number>();
  for (const range of spec.ranges) {
    if (range.from < 1 || range.to < range.from || range.to > totalPages) {
      throw new Error(`Requested page range ${range.from}-${range.to} exceeds document page count (${totalPages}).`);
    }
    for (let p = range.from; p <= range.to; p += 1) {
      pageSet.add(p);
    }
  }
  return Array.from(pageSet).sort((a, b) => a - b);
}

/**
 * Versioned UCP 600 / ISBP 821 Rule Registry (`ucp600-isbp821-v1`) for `lc-checker@1.2.0`.
 * Every discrepancy reported by `lc-checker` MUST cite a valid `ruleId` from this registry.
 */
export interface LcRuleDefinition {
  ruleId: string;
  standard: 'UCP 600' | 'ISBP 821';
  title: string;
  description: string;
  requiresVisualCheck?: boolean;
}

export const LC_RULESET_ID = 'lc-rules-base';
export const LC_RULESET_VERSION = 'ucp600-isbp821-v1';

export const UCP600_ISBP821_RULES: readonly LcRuleDefinition[] = [
  {
    ruleId: 'UCP600-ART14-A',
    standard: 'UCP 600',
    title: 'Standard for Examination of Documents',
    description:
      'Nominated/issuing bank must determine on the basis of the documents alone whether they appear on their face to constitute a complying presentation.',
  },
  {
    ruleId: 'UCP600-ART14-D',
    standard: 'UCP 600',
    title: 'Non-conflicting Data Across Documents',
    description:
      'Data in a document, when read in context with the credit, the document itself and international standard banking practice, need not be identical to, but must not conflict with, data in that document, any other stipulated document or the credit.',
  },
  {
    ruleId: 'UCP600-ART14-E',
    standard: 'UCP 600',
    title: 'Description of Goods in Non-Invoice Documents',
    description:
      'In documents other than the commercial invoice, the description of the goods, services or performance, if stated, may be in general terms not conflicting with their description in the credit.',
  },
  {
    ruleId: 'UCP600-ART14-I',
    standard: 'UCP 600',
    title: 'Document Dates vs Presentation Date',
    description:
      'A document may be dated prior to the issuance date of the credit, but must not be dated later than its date of presentation.',
  },
  {
    ruleId: 'UCP600-ART18-A',
    standard: 'UCP 600',
    title: 'Commercial Invoice Issuer & Beneficiary',
    description:
      'A commercial invoice must appear to have been issued by the beneficiary, made out in the name of the applicant, and in the same currency as the credit.',
  },
  {
    ruleId: 'UCP600-ART18-B',
    standard: 'UCP 600',
    title: 'Commercial Invoice Amount Within Credit Limit',
    description: 'Commercial invoice amount must not exceed the amount permitted by the credit.',
  },
  {
    ruleId: 'UCP600-ART18-C',
    standard: 'UCP 600',
    title: 'Exact Goods Description in Commercial Invoice',
    description:
      'The description of the goods, services or performance in a commercial invoice must correspond with that appearing in the credit.',
  },
  {
    ruleId: 'UCP600-ART20-A-I',
    standard: 'UCP 600',
    title: 'Bill of Lading Carrier Identification & Signature',
    description:
      'A bill of lading must indicate the name of the carrier and be signed by the carrier, master, or named agent.',
    requiresVisualCheck: true,
  },
  {
    ruleId: 'UCP600-ART20-A-II',
    standard: 'UCP 600',
    title: 'Bill of Lading Shipped On Board Notation & Date',
    description:
      'Bill of lading must indicate that the goods have been shipped on board a named vessel at the port of loading stated in the credit with an on-board date.',
  },
  {
    ruleId: 'UCP600-ART20-A-III',
    standard: 'UCP 600',
    title: 'Port of Loading and Discharge Match',
    description:
      'Bill of lading must indicate shipment from the port of loading to the port of discharge stated in the credit.',
  },
  {
    ruleId: 'UCP600-ART27',
    standard: 'UCP 600',
    title: 'Clean Transport Document',
    description:
      'A bank will only accept a clean transport document bearing no clause or notation expressly declaring a defective condition of the goods or packaging.',
  },
  {
    ruleId: 'UCP600-ART28-A',
    standard: 'UCP 600',
    title: 'Insurance Document Signature & Coverage',
    description:
      'Insurance document must appear to be issued and signed by an insurance company, underwriter or their agent/proxy, and cover at least 110% of CIF/CIP value when unspecified.',
    requiresVisualCheck: true,
  },
  {
    ruleId: 'ISBP821-A35',
    standard: 'ISBP 821',
    title: 'Signatures, Stamps and Endorsements',
    description:
      'Required manual/facsimile signatures, stamps, or bill of lading endorsements must be visually verifiable when stipulated.',
    requiresVisualCheck: true,
  },
  {
    ruleId: 'ISBP821-C3',
    standard: 'ISBP 821',
    title: 'Invoice Value & Trade Terms Consistency',
    description: 'Incoterms and invoice line items/totals must match the credit terms without unpermitted charges.',
  },
];

export const VALID_LC_RULE_IDS: ReadonlySet<string> = new Set(UCP600_ISBP821_RULES.map((r) => r.ruleId));

/**
 * Catalog definition for all 36 canonical profiles across:
 * - `document-core@2.0.0` (31 core variants + 3 workflows)
 * - `lc-checker@1.2.0` (1 trade-finance workflow)
 * - `example-review@1.0.0` (1 multi-document review workflow)
 */
export interface DuCatalogEntry {
  endpointName: string;
  legacyEndpointName?: string;
  pipelineName: string;
  businessId: 'document-core' | 'lc-checker' | 'example-review';
  businessVersion: string;
  action: string;
  discriminatorField?: string;
  discriminatorValue?: string;
  maxFiles: number;
  description: string;
  inputSchema: Record<string, unknown>;
}

function coreSchema(
  discriminatorField: string,
  discriminatorValue: string,
  extraProperties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      [discriminatorField]: { type: 'string', enum: [discriminatorValue], default: discriminatorValue },
      ...extraProperties,
    },
    required: [discriminatorField, ...required],
  };
}

export const DU_BUSINESS_CATALOG: readonly DuCatalogEntry[] = [
  // ── 1. document-core / ingest (4) ──────────────────────────────────────────────
  {
    endpointName: 'du-ingest-parse',
    legacyEndpointName: 'dugate-ingest-parse',
    pipelineName: 'Ingest Parse',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'ingest',
    discriminatorField: 'mode',
    discriminatorValue: 'parse',
    maxFiles: 10,
    description: 'Parse digital documents (PDF, DOCX, XLSX, PPTX, TXT, CSV, HTML) into clean Markdown/text.',
    inputSchema: coreSchema('mode', 'parse', {
      language: { type: 'string', default: 'vi' },
      pages: { type: 'string', description: 'Page ranges, e.g. "1-5" or "all"' },
      outputFormat: { type: 'string', enum: ['md', 'text', 'json'], default: 'md' },
    }),
  },
  {
    endpointName: 'du-ingest-ocr',
    legacyEndpointName: 'dugate-ingest-ocr',
    pipelineName: 'Ingest Ocr',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'ingest',
    discriminatorField: 'mode',
    discriminatorValue: 'ocr',
    maxFiles: 10,
    description: 'OCR scanned PDFs and images into Markdown and plain text.',
    inputSchema: coreSchema('mode', 'ocr', {
      language: { type: 'string', default: 'vi' },
      pages: { type: 'string', description: 'Page ranges, e.g. "1-5"' },
      outputFormat: { type: 'string', enum: ['md', 'text'], default: 'md' },
    }),
  },
  {
    endpointName: 'du-ingest-digitize',
    legacyEndpointName: 'dugate-ingest-digitize',
    pipelineName: 'Ingest Digitize',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'ingest',
    discriminatorField: 'mode',
    discriminatorValue: 'digitize',
    maxFiles: 5,
    description: 'Digitize handwritten forms, checkboxes, and structured form fields.',
    inputSchema: coreSchema('mode', 'digitize', {
      language: { type: 'string', default: 'vi' },
      outputFormat: { type: 'string', enum: ['md', 'json'], default: 'json' },
    }),
  },
  {
    endpointName: 'du-ingest-split',
    legacyEndpointName: 'dugate-ingest-split',
    pipelineName: 'Ingest Split',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'ingest',
    discriminatorField: 'mode',
    discriminatorValue: 'split',
    maxFiles: 1,
    description:
      'Split a multi-page document by page ranges (up to 500 selected pages) into separate output artifacts.',
    inputSchema: coreSchema('mode', 'split', {
      pages: { type: 'string', default: '1-2', description: 'Comma-separated page ranges, e.g. "1-2,3-5"' },
    }),
  },

  // ── 2. document-core / extract (6) ─────────────────────────────────────────────
  {
    endpointName: 'du-extract-invoice',
    legacyEndpointName: 'dugate-extract-invoice',
    pipelineName: 'Extract Invoice',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'extract',
    discriminatorField: 'type',
    discriminatorValue: 'invoice',
    maxFiles: 5,
    description: 'Extract structured VAT/commercial invoice data (supplier, buyer, invoiceNumber, lineItems, totals).',
    inputSchema: coreSchema('type', 'invoice', {
      outputFormat: { type: 'string', enum: ['json'], default: 'json' },
    }),
  },
  {
    endpointName: 'du-extract-contract',
    legacyEndpointName: 'dugate-extract-contract',
    pipelineName: 'Extract Contract',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'extract',
    discriminatorField: 'type',
    discriminatorValue: 'contract',
    maxFiles: 5,
    description: 'Extract parties, effectiveDate, value, obligations, and penaltyClauses from contracts.',
    inputSchema: coreSchema('type', 'contract', {
      outputFormat: { type: 'string', enum: ['json'], default: 'json' },
    }),
  },
  {
    endpointName: 'du-extract-id-card',
    legacyEndpointName: 'dugate-extract-id-card',
    pipelineName: 'Extract Id Card',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'extract',
    discriminatorField: 'type',
    discriminatorValue: 'id-card',
    maxFiles: 5,
    description:
      'Extract identity information (ID number, fullName, dateOfBirth, address, expiryDate) from CCCD/Passport.',
    inputSchema: coreSchema('type', 'id-card', {
      outputFormat: { type: 'string', enum: ['json'], default: 'json' },
    }),
  },
  {
    endpointName: 'du-extract-receipt',
    legacyEndpointName: 'dugate-extract-receipt',
    pipelineName: 'Extract Receipt',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'extract',
    discriminatorField: 'type',
    discriminatorValue: 'receipt',
    maxFiles: 5,
    description: 'Extract merchant, receipt date, items, payment method, and total from receipts.',
    inputSchema: coreSchema('type', 'receipt', {
      outputFormat: { type: 'string', enum: ['json'], default: 'json' },
    }),
  },
  {
    endpointName: 'du-extract-table',
    legacyEndpointName: 'dugate-extract-table',
    pipelineName: 'Extract Table',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'extract',
    discriminatorField: 'type',
    discriminatorValue: 'table',
    maxFiles: 5,
    description: 'Extract all tables from documents as structured JSON headers and rows.',
    inputSchema: coreSchema('type', 'table', {
      outputFormat: { type: 'string', enum: ['json'], default: 'json' },
    }),
  },
  {
    endpointName: 'du-extract-custom',
    legacyEndpointName: 'dugate-extract-custom',
    pipelineName: 'Extract Custom',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'extract',
    discriminatorField: 'type',
    discriminatorValue: 'custom',
    maxFiles: 5,
    description: 'Extract custom entities matching a caller-supplied JSON Schema or field list.',
    inputSchema: coreSchema('type', 'custom', {
      fields: { type: 'array', items: { type: 'string' }, description: 'Field names when schema is omitted' },
      schema: { type: 'object', description: 'Target JSON Schema for structured output' },
      outputFormat: { type: 'string', enum: ['json'], default: 'json' },
    }),
  },

  // ── 3. document-core / analyze (7) ─────────────────────────────────────────────
  {
    endpointName: 'du-analyze-classify',
    legacyEndpointName: 'dugate-analyze-classify',
    pipelineName: 'Analyze Classify',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'analyze',
    discriminatorField: 'task',
    discriminatorValue: 'classify',
    maxFiles: 5,
    description: 'Classify documents into categories with 0-1 confidence scores.',
    inputSchema: coreSchema('task', 'classify', {
      categories: { type: 'array', items: { type: 'string' } },
    }),
  },
  {
    endpointName: 'du-analyze-sentiment',
    legacyEndpointName: 'dugate-analyze-sentiment',
    pipelineName: 'Analyze Sentiment',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'analyze',
    discriminatorField: 'task',
    discriminatorValue: 'sentiment',
    maxFiles: 5,
    description: 'Analyze sentiment polarity, confidence, and key phrases.',
    inputSchema: coreSchema('task', 'sentiment', {}),
  },
  {
    endpointName: 'du-analyze-compliance',
    legacyEndpointName: 'dugate-analyze-compliance',
    pipelineName: 'Analyze Compliance',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'analyze',
    discriminatorField: 'task',
    discriminatorValue: 'compliance',
    maxFiles: 5,
    description: 'Check regulatory/policy compliance (PASS/FAIL/WARNING + violations).',
    inputSchema: coreSchema('task', 'compliance', {
      criteria: { type: 'array', items: { type: 'string' } },
    }),
  },
  {
    endpointName: 'du-analyze-fact-check',
    legacyEndpointName: 'dugate-analyze-fact-check',
    pipelineName: 'Analyze Fact Check',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'analyze',
    discriminatorField: 'task',
    discriminatorValue: 'fact-check',
    maxFiles: 5,
    description: 'Cross-check document facts against authoritative referenceData.',
    inputSchema: coreSchema('task', 'fact-check', {
      referenceData: { type: 'object', description: 'Expected key-value facts to verify against' },
    }),
  },
  {
    endpointName: 'du-analyze-quality',
    legacyEndpointName: 'dugate-analyze-quality',
    pipelineName: 'Analyze Quality',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'analyze',
    discriminatorField: 'task',
    discriminatorValue: 'quality',
    maxFiles: 5,
    description: 'Score document completeness and writing quality from 0 to 100.',
    inputSchema: coreSchema('task', 'quality', {
      criteria: { type: 'array', items: { type: 'string' } },
    }),
  },
  {
    endpointName: 'du-analyze-risk',
    legacyEndpointName: 'dugate-analyze-risk',
    pipelineName: 'Analyze Risk',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'analyze',
    discriminatorField: 'task',
    discriminatorValue: 'risk',
    maxFiles: 5,
    description: 'Assess legal/financial contract risk level (LOW, MEDIUM, HIGH, CRITICAL) and risk factors.',
    inputSchema: coreSchema('task', 'risk', {
      focus: { type: 'string' },
    }),
  },
  {
    endpointName: 'du-analyze-summarize-eval',
    legacyEndpointName: 'dugate-analyze-summarize-eval',
    pipelineName: 'Analyze Summarize Eval',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'analyze',
    discriminatorField: 'task',
    discriminatorValue: 'summarize-eval',
    maxFiles: 5,
    description: 'Summarize document and evaluate author perspective, strengths, and gaps.',
    inputSchema: coreSchema('task', 'summarize-eval', {}),
  },

  // ── 4. document-core / transform (5) ───────────────────────────────────────────
  {
    endpointName: 'du-transform-convert',
    legacyEndpointName: 'dugate-transform-convert',
    pipelineName: 'Transform Convert',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'transform',
    discriminatorField: 'variant',
    discriminatorValue: 'convert',
    maxFiles: 1,
    description: 'Convert document content locally between Markdown, HTML, plain text, and JSON.',
    inputSchema: coreSchema('variant', 'convert', {
      outputFormat: { type: 'string', enum: ['md', 'html', 'text', 'json'], default: 'md' },
    }),
  },
  {
    endpointName: 'du-transform-translate',
    legacyEndpointName: 'dugate-transform-translate',
    pipelineName: 'Transform Translate',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'transform',
    discriminatorField: 'variant',
    discriminatorValue: 'translate',
    maxFiles: 1,
    description: 'Translate document into targetLanguage while preserving formatting.',
    inputSchema: coreSchema('variant', 'translate', {
      targetLanguage: { type: 'string', default: 'en' },
      tone: { type: 'string', default: 'professional' },
    }),
  },
  {
    endpointName: 'du-transform-rewrite',
    legacyEndpointName: 'dugate-transform-rewrite',
    pipelineName: 'Transform Rewrite',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'transform',
    discriminatorField: 'variant',
    discriminatorValue: 'rewrite',
    maxFiles: 1,
    description: 'Rewrite document in academic, executive, simplified, or bullet_points style.',
    inputSchema: coreSchema('variant', 'rewrite', {
      style: {
        type: 'string',
        enum: ['academic', 'executive', 'simplified', 'bullet_points'],
        default: 'executive',
      },
      tone: { type: 'string' },
    }),
  },
  {
    endpointName: 'du-transform-redact',
    legacyEndpointName: 'dugate-transform-redact',
    pipelineName: 'Transform Redact',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'transform',
    discriminatorField: 'variant',
    discriminatorValue: 'redact',
    maxFiles: 1,
    description: 'Mask PII (CCCD, PHONE_NUMBER, EMAIL, BANK_ACCOUNT, TAX_ID, or custom patterns) in text/documents.',
    inputSchema: coreSchema('variant', 'redact', {
      text: { type: 'string' },
      redactPatterns: {
        type: 'array',
        items: { type: 'string' },
        default: ['CCCD', 'PHONE_NUMBER', 'EMAIL'],
      },
      useAi: { type: 'boolean', default: false },
      outputFormat: { type: 'string', enum: ['text', 'md'], default: 'text' },
    }),
  },
  {
    endpointName: 'du-transform-template',
    legacyEndpointName: 'dugate-transform-template',
    pipelineName: 'Transform Template',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'transform',
    discriminatorField: 'variant',
    discriminatorValue: 'template',
    maxFiles: 1,
    description: 'Merge structured JSON variables into a {{placeholder}} document template.',
    inputSchema: coreSchema('variant', 'template', {
      templateText: { type: 'string' },
      variables: { type: 'object', description: 'Key-value map merged into {{key}} placeholders' },
    }),
  },

  // ── 5. document-core / generate (6) ────────────────────────────────────────────
  {
    endpointName: 'du-generate-summary',
    legacyEndpointName: 'dugate-generate-summary',
    pipelineName: 'Generate Summary',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'generate',
    discriminatorField: 'task',
    discriminatorValue: 'summary',
    maxFiles: 5,
    description: 'Generate a concise summary constrained by maxWords, format, and target audience.',
    inputSchema: coreSchema('task', 'summary', {
      format: {
        type: 'string',
        enum: ['paragraph', 'bullets', 'numbered', 'table', 'mind_map'],
        default: 'bullets',
      },
      maxWords: { type: 'integer', default: 300 },
      audience: { type: 'string' },
    }),
  },
  {
    endpointName: 'du-generate-outline',
    legacyEndpointName: 'dugate-generate-outline',
    pipelineName: 'Generate Outline',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'generate',
    discriminatorField: 'task',
    discriminatorValue: 'outline',
    maxFiles: 5,
    description: 'Extract hierarchical H1/H2/H3 outline and section structure.',
    inputSchema: coreSchema('task', 'outline', {}),
  },
  {
    endpointName: 'du-generate-report',
    legacyEndpointName: 'dugate-generate-report',
    pipelineName: 'Generate Report',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'generate',
    discriminatorField: 'task',
    discriminatorValue: 'report',
    maxFiles: 10,
    description: 'Synthesize an executive analytical report across uploaded documents.',
    inputSchema: coreSchema('task', 'report', {
      focus: { type: 'string' },
      language: { type: 'string', default: 'vi' },
    }),
  },
  {
    endpointName: 'du-generate-email',
    legacyEndpointName: 'dugate-generate-email',
    pipelineName: 'Generate Email',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'generate',
    discriminatorField: 'task',
    discriminatorValue: 'email',
    maxFiles: 5,
    description: 'Draft a professional email based on the uploaded documents.',
    inputSchema: coreSchema('task', 'email', {
      tone: { type: 'string', default: 'formal' },
      recipientRole: { type: 'string' },
    }),
  },
  {
    endpointName: 'du-generate-minutes',
    legacyEndpointName: 'dugate-generate-minutes',
    pipelineName: 'Generate Minutes',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'generate',
    discriminatorField: 'task',
    discriminatorValue: 'minutes',
    maxFiles: 5,
    description: 'Generate structured meeting minutes with decisions, action items, and owners.',
    inputSchema: coreSchema('task', 'minutes', {
      format: { type: 'string', enum: ['md', 'json'], default: 'json' },
    }),
  },
  {
    endpointName: 'du-generate-qa',
    legacyEndpointName: 'dugate-generate-qa',
    pipelineName: 'Generate Qa',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'generate',
    discriminatorField: 'task',
    discriminatorValue: 'qa',
    maxFiles: 5,
    description: 'Answer questions grounded in the document with verbatim evidence quotes and confidence.',
    inputSchema: coreSchema('task', 'qa', {
      questions: { type: 'array', items: { type: 'string' } },
    }),
  },

  // ── 6. document-core / compare (3) ─────────────────────────────────────────────
  {
    endpointName: 'du-compare-diff',
    legacyEndpointName: 'dugate-compare-diff',
    pipelineName: 'Compare Diff',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'compare',
    discriminatorField: 'mode',
    discriminatorValue: 'diff',
    maxFiles: 2,
    description: 'Compute deterministic line-by-line lexical diff between source and target documents.',
    inputSchema: coreSchema('mode', 'diff', {
      outputFormat: { type: 'string', enum: ['unified', 'json'], default: 'json' },
    }),
  },
  {
    endpointName: 'du-compare-semantic',
    legacyEndpointName: 'dugate-compare-semantic',
    pipelineName: 'Compare Semantic',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'compare',
    discriminatorField: 'mode',
    discriminatorValue: 'semantic',
    maxFiles: 2,
    description: 'Compare two documents semantically and assess legal significance (NEGLIGIBLE, MODERATE, HIGH).',
    inputSchema: coreSchema('mode', 'semantic', {
      focus: { type: 'string' },
    }),
  },
  {
    endpointName: 'du-compare-version',
    legacyEndpointName: 'dugate-compare-version',
    pipelineName: 'Compare Version',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'compare',
    discriminatorField: 'mode',
    discriminatorValue: 'version',
    maxFiles: 2,
    description: 'Generate a structured version changelog between two document revisions.',
    inputSchema: coreSchema('mode', 'version', {}),
  },

  // ── 7. document-core / multi-step workflows (3) ────────────────────────────────
  {
    endpointName: 'du-workflow-disbursement',
    legacyEndpointName: 'dugate-workflow-disbursement',
    pipelineName: 'Workflow Disbursement',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'disbursement',
    maxFiles: 20,
    description:
      'Credit disbursement appraisal: parallel classify & extract, optional HITL approval (WAITING_INPUT), cross-check against referenceData, and memo generation.',
    inputSchema: {
      type: 'object',
      properties: {
        inputVersion: { type: 'string', default: 'disbursement-input-v1' },
        referenceData: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              expected: {},
            },
          },
        },
        maxConcurrency: { type: 'integer', default: 4, minimum: 1, maximum: 8 },
        requireApproval: { type: 'boolean', default: false },
        failurePolicy: { type: 'string', enum: ['fail-closed', 'continue'], default: 'fail-closed' },
      },
    },
  },
  {
    endpointName: 'du-workflow-doc-compare',
    legacyEndpointName: 'dugate-workflow-doc-compare',
    pipelineName: 'Workflow Doc Compare',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'doc-compare',
    maxFiles: 2,
    description:
      'Long-document deep comparison: section chunking, structureClaims & referenceClaims verification, optional HITL review.',
    inputSchema: {
      type: 'object',
      properties: {
        inputVersion: { type: 'string', default: 'doc-compare-input-v1' },
        chunkSizeChars: { type: 'integer', default: 8000, minimum: 200, maximum: 200000 },
        requireHumanReview: { type: 'boolean', default: false },
        focus: { type: 'string' },
      },
    },
  },
  {
    endpointName: 'du-workflow-schema',
    pipelineName: 'Workflow Schema',
    businessId: 'document-core',
    businessVersion: '2.0.0',
    action: 'schema-workflow',
    maxFiles: 10,
    description: 'Execute a provisioned dynamic pipeline/DAG workflow by pipelineName or pipelineId.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineName: { type: 'string' },
        pipelineId: { type: 'integer' },
        parameters: { type: 'object' },
      },
    },
  },

  // ── 8. lc-checker@1.2.0 (Trade Finance L/C Document Checking) ──────────────────
  {
    endpointName: 'du-lc-checker',
    legacyEndpointName: 'dugate-workflow-lc-checker',
    pipelineName: 'Workflow Lc Checker',
    businessId: 'lc-checker',
    businessVersion: '1.2.0',
    action: 'lc-checker',
    maxFiles: 50,
    description:
      '5-step Trade Finance L/C examination (OCR -> Screen -> Visual -> Adjudicate UCP 600 / ISBP 821 -> Vietnamese Report) with mandatory rule citations and humanSignOffRequired.',
    inputSchema: {
      type: 'object',
      properties: {
        inputVersion: { type: 'string', default: 'lc-checker-input-v1' },
        ruleSetVersion: { type: 'string', default: LC_RULESET_VERSION },
        maxConcurrency: { type: 'integer', default: 4, minimum: 1, maximum: 8 },
        failurePolicy: { type: 'string', enum: ['fail-closed', 'continue'], default: 'fail-closed' },
      },
    },
  },

  // ── 9. example-review@1.0.0 (Multi-Document Compliance Review) ─────────────────
  {
    endpointName: 'du-example-review',
    pipelineName: 'Example Review',
    businessId: 'example-review',
    businessVersion: '1.0.0',
    action: 'review',
    maxFiles: 10,
    description:
      'Multi-document compliance review (1..10 PDF/DOCX/XLSX/JSON files) with fan-out item review and optional HITL approval.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewId: { type: 'string' },
        requireApproval: { type: 'boolean', default: false },
        useAi: { type: 'boolean', default: true },
        criteria: { type: 'array', items: { type: 'string' } },
      },
    },
  },
];
