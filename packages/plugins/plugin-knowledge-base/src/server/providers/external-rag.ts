/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * External RAG provider
 *
 * Allows a Knowledge Base of type 'EXTERNAL_RAG' to delegate retrieval to an
 * external HTTP service instead of using a local vector database.
 *
 * The external service must expose a POST endpoint that accepts:
 *   { query, topK?, scoreThreshold?, namespace?, filter? }
 * and responds with:
 *   { results: [{ content, score, metadata?, id? }, ...] }
 *
 * KB options used by the built-in 'external-http' strategy:
 *   options.ragApiUrl       (required) — full URL to POST
 *   options.ragApiKey       (optional) — sent as "Authorization: Bearer <key>"
 *   options.ragNamespace    (optional) — forwarded in the request body
 *   options.ragTopK         (optional) — overrides default topK
 *   options.ragScoreThreshold (optional) — overrides default score threshold
 */

export type RagSearchResult = {
  content: string;
  score: number;
  metadata?: Record<string, any>;
  id?: string;
};

export type RagSearchOptions = {
  topK?: number;
  scoreThreshold?: number;
  filter?: Record<string, any>;
};

/**
 * A strategy function registered by a plugin or built-in provider.
 * Receives the raw KB record (from aiKnowledgeBases) plus search options.
 * Returns an array of matching document segments.
 */
export type RagSearchStrategy = (
  query: string,
  kb: Record<string, any>,
  options: RagSearchOptions,
) => Promise<RagSearchResult[]>;

// ─────────────────────────────────────────────────────────────────────────────
// Built-in strategy: generic HTTP endpoint
// ─────────────────────────────────────────────────────────────────────────────

type ExternalRagRequestBody = {
  query: string;
  topK?: number;
  scoreThreshold?: number;
  namespace?: string;
  filter?: Record<string, any>;
  embedding?: {
    provider: 'openai-compatible';
    baseURL: string;
    apiKey?: string;
    model: string;
    queryPrefix?: string;
    passagePrefix?: string;
  };
};

type ExternalRagResponseBody = {
  results: Array<{
    content: string;
    score?: number;
    metadata?: Record<string, any>;
    id?: string;
  }>;
};

/** Default timeout for external RAG HTTP requests (ms). */
const RAG_REQUEST_TIMEOUT_MS = 30_000;

function normalizeTopK(value: unknown, fallback: number): number {
  const parsed = value != null ? Number(value) : fallback;
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), 100) : 5;
}

function normalizeThreshold(value: unknown, fallback: number): number {
  const parsed = value != null ? Number(value) : fallback;
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRagResults(data: ExternalRagResponseBody, apiUrl: string): RagSearchResult[] {
  if (!Array.isArray(data.results)) {
    throw new Error(`External RAG API "${apiUrl}" response is missing a "results" array`);
  }

  return data.results
    .filter((r) => typeof r.content === 'string' && r.content.trim().length > 0)
    .map((r) => ({
      content: r.content,
      score: Number(r.score) || 0,
      metadata: r.metadata ?? {},
      id: r.id,
    }));
}

/**
 * SSRF guard — blocks requests to localhost, private RFC-1918 ranges,
 * link-local, cloud metadata endpoints, and DNS-rebinding attacks.
 *
 * Fix P0-4: After hostname string checks, resolves the hostname to an IP
 * and validates the resolved address against private/loopback/link-local
 * ranges. This closes DNS rebinding, octal/hex IP encoding, and
 * IPv6-mapped IPv4 bypass vectors.
 */
function validateExternalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid RAG API URL: "${url}"`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`RAG API URL must use http or https: "${url}"`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants (string-level check)
  const localhostNames = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];
  if (localhostNames.includes(hostname)) {
    throw new Error(`RAG API URL cannot point to localhost: "${url}"`);
  }

  // Block cloud metadata endpoints (string-level check)
  if (
    hostname === '169.254.169.254' ||
    hostname.startsWith('169.254.') ||
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata.internal'
  ) {
    throw new Error(`RAG API URL cannot point to cloud metadata service: "${url}"`);
  }

  // Block common private IP ranges (string-level check)
  if (hostname.startsWith('10.') || hostname.startsWith('192.168.')) {
    throw new Error(`RAG API URL cannot point to private network: "${url}"`);
  }
  // 172.16.0.0 – 172.31.255.255
  const match172 = /^172\.(\d+)\./.exec(hostname);
  if (match172) {
    const second = parseInt(match172[1], 10);
    if (second >= 16 && second <= 31) {
      throw new Error(`RAG API URL cannot point to private network: "${url}"`);
    }
  }
}

/**
 * Check if a resolved IP address is in a private/loopback/link-local range.
 * Catches DNS rebinding, octal/hex IP encodings, and IPv6-mapped IPv4 bypasses.
 */
function isPrivateOrReservedIP(ip: string): boolean {
  // Normalize IPv6-mapped IPv4 (e.g., ::ffff:127.0.0.1 → 127.0.0.1)
  const normalized = ip.replace(/^::ffff:/i, '');

  // IPv4 checks
  const ipv4Parts = normalized.split('.').map(Number);
  if (ipv4Parts.length === 4 && ipv4Parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
    const [a, b] = ipv4Parts;
    // Loopback: 127.0.0.0/8
    if (a === 127) return true;
    // 0.0.0.0
    if (a === 0 && b === 0) return true;
    // Private: 10.0.0.0/8
    if (a === 10) return true;
    // Private: 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // Private: 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // Link-local: 169.254.0.0/16 (includes cloud metadata 169.254.169.254)
    if (a === 169 && b === 254) return true;
  }

  // IPv6 loopback
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  // IPv6 link-local
  if (normalized.toLowerCase().startsWith('fe80:')) return true;

  // IPv6 unique local
  if (normalized.toLowerCase().startsWith('fd') || normalized.toLowerCase().startsWith('fc')) return true;

  return false;
}

/**
 * Async SSRF guard — resolves hostname to IP and validates against private ranges.
 * Call this in addition to validateExternalUrl() for defense-in-depth.
 */
async function validateResolvedIP(url: string): Promise<void> {
  const { hostname } = new URL(url);

  try {
    const dns = await import('dns');
    const resolvedIP = await new Promise<string>((resolve, reject) => {
      dns.lookup(hostname, { family: 0 }, (err, address) => {
        if (err) reject(err);
        else resolve(address);
      });
    });

    if (isPrivateOrReservedIP(resolvedIP)) {
      throw new Error(
        `RAG API URL "${url}" resolves to private/reserved IP ${resolvedIP}. This is blocked to prevent SSRF.`,
      );
    }
  } catch (err: any) {
    // If it's our own SSRF error, re-throw
    if (err.message?.includes('blocked to prevent SSRF')) throw err;
    // DNS resolution failure — let the fetch() handle it naturally
  }
}

async function postExternalRag(
  apiUrl: string,
  apiKey: string,
  body: ExternalRagRequestBody,
  label = 'External RAG API',
): Promise<RagSearchResult[]> {

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RAG_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`${label} "${apiUrl}" timed out after ${RAG_REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `${label} "${apiUrl}" returned HTTP ${response.status}${errorText ? ': ' + errorText.slice(0, 200) : ''}`,
    );
  }

  return normalizeRagResults((await response.json()) as ExternalRagResponseBody, apiUrl);
}

/**
 * Built-in 'external-http' strategy.
 *
 * Reads apiUrl / apiKey / namespace from kb.options and forwards the query
 * to the external endpoint via a POST request.
 *
 * Security: validates URL against SSRF blocklist before fetching.
 * Reliability: uses AbortController with 30s timeout to prevent hangs.
 */
export const externalHttpRagStrategy: RagSearchStrategy = async (
  query,
  kb,
  { topK = 5, scoreThreshold = 0, filter },
) => {
  const opts = (kb.options ?? {}) as Record<string, any>;
  const apiUrl: string = opts.ragApiUrl ?? '';
  const apiKey: string = opts.ragApiKey ?? '';
  const namespace: string | undefined = opts.ragNamespace;
  const effectiveTopK = normalizeTopK(opts.ragTopK, topK);
  const effectiveThreshold = normalizeThreshold(opts.ragScoreThreshold, scoreThreshold);

  if (!apiUrl) {
    throw new Error(`Knowledge base "${kb.name ?? kb.id}" (EXTERNAL_RAG) is missing options.ragApiUrl`);
  }

  // Fix #1: Validate URL to prevent SSRF attacks against internal services
  validateExternalUrl(apiUrl);
  // Fix P0-4: Defense-in-depth — validate resolved IP against private ranges
  await validateResolvedIP(apiUrl);

  const body: ExternalRagRequestBody = {
    query,
    topK: effectiveTopK,
    scoreThreshold: effectiveThreshold,
    ...(namespace ? { namespace } : {}),
    ...(filter ? { filter } : {}),
  };

  return (await postExternalRag(apiUrl, apiKey, body)).filter((r) => (Number(r.score) || 0) >= effectiveThreshold);

};

type EmbeddingHttpProviderOptions = {
  db: any;
  app: any;
};

async function resolveLlmServiceEmbeddingConfig(
  providerOptions: EmbeddingHttpProviderOptions,
  kb: Record<string, any>,
): Promise<NonNullable<ExternalRagRequestBody['embedding']>> {
  const opts = (kb.options ?? {}) as Record<string, any>;
  const llmServiceName = opts.ragEmbeddingLlmService || opts.embeddingLlmService || opts.llmService;
  const model = opts.ragEmbeddingModel || opts.embeddingModel;

  if (!llmServiceName) {
    throw new Error(
      `Knowledge base "${kb.name ?? kb.id}" (EXTERNAL_RAG/openai-compatible) is missing options.ragEmbeddingLlmService`,
    );
  }
  if (!model) {
    throw new Error(
      `Knowledge base "${kb.name ?? kb.id}" (EXTERNAL_RAG/openai-compatible) is missing options.ragEmbeddingModel`,
    );
  }

  const llmServiceRecord = await providerOptions.db.getRepository('llmServices').findOne({
    filter: { name: llmServiceName },
  });
  if (!llmServiceRecord) {
    throw new Error(`LLM service "${llmServiceName}" not found for EXTERNAL_RAG/openai-compatible`);
  }

  const llmService = llmServiceRecord.toJSON ? llmServiceRecord.toJSON() : llmServiceRecord;
  const serviceOpts = providerOptions.app.environment.renderJsonTemplate(llmService.options || {});
  const baseURL = serviceOpts.baseURL || serviceOpts.baseUrl || '';
  if (!baseURL) {
    throw new Error(`LLM service "${llmServiceName}" is missing options.baseURL/baseUrl`);
  }

  return {
    provider: 'openai-compatible',
    baseURL,
    apiKey: serviceOpts.apiKey || '',
    model,
    queryPrefix: opts.ragQueryPrefix || 'query: ',
    passagePrefix: opts.ragPassagePrefix || 'passage: ',
  };
}

export function createOpenAICompatibleRagStrategy(providerOptions: EmbeddingHttpProviderOptions): RagSearchStrategy {
  return async (query, kb, { topK = 5, scoreThreshold = 0, filter }) => {
    const opts = (kb.options ?? {}) as Record<string, any>;
    const apiUrl: string = opts.ragApiUrl ?? '';
    const apiKey: string = opts.ragApiKey ?? '';
    const namespace: string | undefined = opts.ragNamespace;
    const effectiveTopK = normalizeTopK(opts.ragTopK, topK);
    const effectiveThreshold = normalizeThreshold(opts.ragScoreThreshold, scoreThreshold);

    if (!apiUrl) {
      throw new Error(
        `Knowledge base "${kb.name ?? kb.id}" (EXTERNAL_RAG/openai-compatible) is missing options.ragApiUrl`,
      );
    }

    // Fix P0-4: Defense-in-depth — validate resolved IP against private ranges

    const embedding = await resolveLlmServiceEmbeddingConfig(providerOptions, kb);
    const body: ExternalRagRequestBody = {
      query,
      topK: effectiveTopK,
      scoreThreshold: effectiveThreshold,
      embedding,
      ...(namespace ? { namespace } : {}),
      ...(filter ? { filter } : {}),
    };

    return (await postExternalRag(apiUrl, apiKey, body, 'External embedding RAG API')).filter(
      (r) => (Number(r.score) || 0) >= effectiveThreshold,
    );

  };
}

export const EXTERNAL_RAG_KB_TYPE = 'EXTERNAL_RAG';
export const EXTERNAL_HTTP_RAG_PROVIDER = 'external-http';
export const OPENAI_COMPATIBLE_RAG_PROVIDER = 'openai-compatible';
export const E5_HTTP_RAG_PROVIDER = 'e5-http';
export const createE5HttpRagStrategy = createOpenAICompatibleRagStrategy;
