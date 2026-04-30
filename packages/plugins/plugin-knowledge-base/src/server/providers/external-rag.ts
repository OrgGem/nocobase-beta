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

/**
 * Basic SSRF guard — blocks requests to localhost, private RFC-1918 ranges,
 * link-local, and cloud metadata endpoints.
 *
 * This is NOT a bulletproof solution (DNS rebinding can bypass hostname checks),
 * but it prevents the most common misconfiguration / accidental internal hits.
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

  // Block localhost variants
  const localhostNames = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];
  if (localhostNames.includes(hostname)) {
    throw new Error(`RAG API URL cannot point to localhost: "${url}"`);
  }

  // Block cloud metadata endpoints
  if (
    hostname === '169.254.169.254' ||
    hostname.startsWith('169.254.') ||
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata.internal'
  ) {
    throw new Error(`RAG API URL cannot point to cloud metadata service: "${url}"`);
  }

  // Block common private IP ranges (basic string check)
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
  const parsedTopK = opts.ragTopK != null ? Number(opts.ragTopK) : topK;
  const parsedThreshold = opts.ragScoreThreshold != null ? Number(opts.ragScoreThreshold) : scoreThreshold;
  const effectiveTopK = Number.isFinite(parsedTopK) ? Math.min(Math.max(Math.floor(parsedTopK), 1), 100) : 5;
  const effectiveThreshold = Number.isFinite(parsedThreshold) ? parsedThreshold : 0;

  if (!apiUrl) {
    throw new Error(`Knowledge base "${kb.name ?? kb.id}" (EXTERNAL_RAG) is missing options.ragApiUrl`);
  }

  // Fix #1: Validate URL to prevent SSRF attacks against internal services
  validateExternalUrl(apiUrl);

  const body: ExternalRagRequestBody = {
    query,
    topK: effectiveTopK,
    scoreThreshold: effectiveThreshold,
    ...(namespace ? { namespace } : {}),
    ...(filter ? { filter } : {}),
  };

  // Fix #2: Add request timeout to prevent indefinite hangs
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
      throw new Error(`External RAG API "${apiUrl}" timed out after ${RAG_REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `External RAG API "${apiUrl}" returned HTTP ${response.status}${errorText ? ': ' + errorText.slice(0, 200) : ''}`,
    );
  }

  const data = (await response.json()) as ExternalRagResponseBody;

  if (!Array.isArray(data.results)) {
    throw new Error(`External RAG API "${apiUrl}" response is missing a "results" array`);
  }

  return data.results
    .filter((r) => typeof r.content === 'string' && r.content.trim().length > 0)
    .filter((r) => (Number(r.score) || 0) >= effectiveThreshold)
    .map((r) => ({
      content: r.content,
      score: Number(r.score) || 0,
      metadata: r.metadata ?? {},
      id: r.id,
    }));
};

export const EXTERNAL_RAG_KB_TYPE = 'EXTERNAL_RAG';
export const EXTERNAL_HTTP_RAG_PROVIDER = 'external-http';
