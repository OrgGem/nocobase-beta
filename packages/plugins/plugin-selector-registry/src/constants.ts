export const SELECTOR_TYPES = ['css', 'xpath', 'text', 'aria'] as const;
export type SelectorType = (typeof SELECTOR_TYPES)[number];

export const ENTRY_STATUSES = ['probation', 'active', 'degraded', 'quarantined', 'disabled'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const RESOLVE_PATHS = ['cache_hit', 'registry', 'heuristic', 'llm', 'miss', 'skipped', 'error'] as const;
export type ResolvePath = (typeof RESOLVE_PATHS)[number];

export const FAILURE_TYPES = ['not_found', 'ambiguous', 'stale', 'not_interactable', 'page_error', 'unknown'] as const;
export type FailureType = (typeof FAILURE_TYPES)[number];

// Failure types that must never trigger healing: the page evidence is dirty,
// so learning from it would poison the registry.
export const UNHEALABLE_FAILURE_TYPES: readonly FailureType[] = ['not_interactable', 'page_error'];

export const FEEDBACK_OUTCOMES = ['success', 'fail', 'verified', 'mismatch'] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

export const VERSION_SOURCES = ['client', 'heuristic', 'llm', 'manual', 'rollback'] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];

export const VERSION_STATUSES = ['active', 'superseded', 'failed', 'rolled_back'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const RESOLVED_BY = ['cache', 'registry', 'heuristic', 'llm', 'manual', 'rollback'] as const;
export type ResolvedBy = (typeof RESOLVED_BY)[number];

export interface ElementSignature {
  tag: string;
  stableAttrs: Record<string, string>;
  textSample: string;
  textHash: string;
}

export interface ClientCandidate {
  selector?: string;
  tag?: string;
  attrs?: Record<string, string>;
  text?: string;
  html?: string;
}

export interface SelectorRef {
  selector: string;
  selectorType: SelectorType;
}

export interface ResolveRequestPayload {
  app: string;
  elementKey?: string;
  logicalId?: string;
  name?: string;
  pageUrl?: string;
  pageUrlPattern?: string;
  selector?: string;
  selectorType?: SelectorType;
  failureType?: FailureType;
  errorMessage?: string;
  domSnippet?: string;
  candidates?: ClientCandidate[];
  triedSelectors?: string[];
  agentId?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export interface ResolveResponsePayload {
  elementKey: string;
  selector: string | null;
  selectorType: SelectorType;
  fallbacks: SelectorRef[];
  signature?: ElementSignature;
  confidence: number;
  source: ResolvePath;
  version: number;
  status: EntryStatus;
  healTriggered: boolean;
  ttlMs?: number;
  // Present when the app is in dry-run mode: the heal that was computed but
  // NOT applied, so admins can judge healing quality before trusting it.
  dryRunCandidate?: SelectorRef & { source: string };
}

export interface ReportRequestPayload {
  app: string;
  elementKey: string;
  selectorUsed?: string;
  outcome: FeedbackOutcome;
  failureType?: FailureType;
  signatureMatch?: boolean;
  pageUrl?: string;
  pageHealth?: Record<string, unknown>;
  errorMessage?: string;
  agentId?: string;
  runId?: string;
}

export interface BulkLookupItem {
  elementKey: string;
  version?: number;
}

export interface BulkLookupRequestPayload {
  app: string;
  items: BulkLookupItem[];
}
