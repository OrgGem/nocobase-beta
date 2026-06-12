/**
 * AI Analyzer pipeline stage for `plugin-build-visualization-block`.
 *
 * This module is built incrementally:
 * - Task 4.1 (this file) implements the pure output-cleaning and JSON-extraction
 *   helpers ported from `plugin-build-guide-block`'s `build.ts`:
 *   `stripThink`, `stripFence`, `toPlainText`, and `extractJsonObject`.
 * - Task 4.2 adds the LLM provider invocation (prompt + `chatModel.invoke`).
 * - Task 4.3 adds `JSON.parse` + `blockSpecSchema.safeParse` and the fallback.
 *
 * The helpers below are intentionally pure string functions with no imports
 * from `@nocobase/*` or `zod`, so they can be unit-tested in isolation and
 * reused by the parse/fallback logic in task 4.3.
 */

/**
 * Remove `<think>...</think>` reasoning blocks from model output.
 *
 * Handles an unclosed `<think>` tag (matches through end of string) and is
 * case-insensitive. Ported from `plugin-build-guide-block`'s `build.ts`.
 */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

/**
 * Strip a leading code fence (```json / ```markdown / ```md / ```html / ```)
 * and a trailing closing fence from model output. Ported from
 * `plugin-build-guide-block`'s `build.ts`.
 */
export function stripFence(text: string): string {
  return text
    .replace(/^```(?:json|markdown|md|html)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

/**
 * Coerce LangChain message content into plain text.
 *
 * Message content can be a plain string, an array of content parts (strings or
 * objects exposing `text`/`content`), or an object exposing `text`/`content`.
 * Anything else falls back to a JSON serialization. Ported from
 * `plugin-build-guide-block`'s `build.ts` (`toPlainText`), narrowed to avoid
 * `any`.
 */
export function toPlainText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object') {
          const part = item as { text?: unknown; content?: unknown };
          if (typeof part.text === 'string') {
            return part.text;
          }
          if (typeof part.content === 'string') {
            return part.content;
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const obj = value as { text?: unknown; content?: unknown };
    const text = obj.text ?? obj.content;
    if (typeof text === 'string') {
      return text;
    }
  }
  return JSON.stringify(value);
}

/**
 * Clean raw model output and extract the JSON object substring.
 *
 * Applies `stripThink` then `stripFence`, then returns the substring from the
 * first `{` to the last `}` (inclusive). When no balanced brace pair is found,
 * returns the cleaned text unchanged. Mirrors the brace-extraction logic in
 * `plugin-build-guide-block`'s `normalizePlan`.
 */
export function extractJsonObject(text: string): string {
  const cleanText = stripFence(stripThink(text));
  const jsonStart = cleanText.indexOf('{');
  const jsonEnd = cleanText.lastIndexOf('}');
  return jsonStart >= 0 && jsonEnd > jsonStart ? cleanText.slice(jsonStart, jsonEnd + 1) : cleanText;
}

/*
 * Task 4.2: LLM provider acquisition + prompt construction + timed invocation.
 *
 * These exports are kept separate so task 4.3 can compose them (together with
 * the cleaning helpers above) into the full `analyze(...)` stage that adds
 * `JSON.parse` + `blockSpecSchema.safeParse` and the fallback.
 */

import type { Application } from '@nocobase/server';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { BlockSpec, SchemaSummary, blockSpecSchema } from '../../shared/blockSpec';
import { LLM_TIMEOUT_MS } from '../../shared/constants';
import { buildFallbackSpec } from './fallback';

/**
 * The messages sent to a chat model: a system message establishing the
 * JSON-only contract followed by a human message carrying the request.
 */
export type AnalyzerMessage = SystemMessage | HumanMessage;

/**
 * The minimal LLM provider surface this stage relies on. The AI plugin's
 * `getLLMService` returns a richer provider; we narrow to just the chat model
 * `invoke` call so our own code stays typed without depending on `any`.
 */
export interface LLMProvider {
  chatModel: {
    invoke(messages: AnalyzerMessage[]): Promise<{ content: unknown }>;
  };
}

interface AIPluginLike {
  aiManager: {
    getLLMService(args: { llmService: string; model: string }): Promise<{ provider: LLMProvider }>;
  };
}

/**
 * Inputs to {@link buildAnalyzerMessages}.
 */
export interface BuildAnalyzerMessagesParams {
  /** The user's natural-language requirement. */
  requirement: string;
  /** The introspected schema for the selected collections. */
  summary: SchemaSummary;
}

/**
 * Resolve the chat-model provider from the AI plugin.
 *
 * Ported from `plugin-build-guide-block`'s `build.ts`: looks up the `ai`
 * plugin, asks its `aiManager` for the configured LLM service, and returns the
 * provider. Throws when the AI plugin is not installed/available.
 */
export async function getLLMProvider(app: Application, llmService: string, model: string): Promise<LLMProvider> {
  const aiPlugin = app.pm.get('ai') as AIPluginLike | undefined;
  if (!aiPlugin) {
    throw new Error('Plugin AI is not available');
  }
  const serviceData = await aiPlugin.aiManager.getLLMService({ llmService, model });
  return serviceData.provider;
}

/**
 * Produce a compact, token-friendly serialization of the schema summary. Only
 * the fields the model needs to choose collections/fields are included
 * (collection name + field name/type/interface + relation name/type/target).
 */
function compactSummary(summary: SchemaSummary): unknown {
  return {
    dataSource: summary.dataSource,
    collections: summary.collections.map((collection) => ({
      name: collection.name,
      ...(collection.introspectionFailed ? { introspectionFailed: true } : {}),
      fields: collection.fields.map((field) => ({
        name: field.name,
        type: field.type,
        interface: field.interface,
      })),
      relations: collection.relations.map((relation) => ({
        name: relation.name,
        type: relation.type,
        target: relation.target,
      })),
    })),
  };
}

/**
 * The system prompt: establishes the assistant's role and the strict
 * JSON-only contract describing the {@link import('../../shared/blockSpec').BlockSpec}
 * shape the model must return.
 */
const SYSTEM_PROMPT = `You are a NocoBase block designer. Given a natural-language requirement and a JSON description of the available collections (with their fields and relations), design exactly one block: a chart, a table, or a form.

Return ONLY one JSON object. Do not include any prose, explanation, Markdown, or code fences. The JSON object must conform to this BlockSpec shape:

{
  "version": 1,
  "blockType": "chart" | "table" | "form",
  "title": string,
  "primaryCollection": string,   // a collection name from the provided schema; the block is bound to it
  "dataSource": string,          // the provided dataSource
  // include exactly one of the following payloads, matching blockType:
  // when blockType === "chart":
  "charts": [
    {
      "key": string,
      "title": string,
      "chartType": string,       // e.g. "ant-design-charts.pie", "ant-design-charts.column", "antd.statistic"
      "measures": [
        { "field": string, "aggregation": "count" | "sum" | "avg" | "max" | "min", "alias": string }
      ],
      "dimensions": [ { "field": string } ]
    }
  ],
  // when blockType === "table":
  "table": { "fields": [string] },
  // when blockType === "form":
  "form": { "fields": [string] }
}

Rules:
- Use ONLY collections, fields, and relations that appear in the provided schema. Never invent field names.
- "primaryCollection" must be one of the provided collection names.
- "dataSource" must equal the provided dataSource.
- Always set "version" to 1.
- Choose the blockType that best satisfies the requirement and include only that type's payload.
- Output the single JSON object and nothing else.`;

/**
 * Build the `[SystemMessage, HumanMessage]` pair for the analyzer. The human
 * message carries the requirement and a compact JSON serialization of the
 * schema summary.
 */
export function buildAnalyzerMessages(params: BuildAnalyzerMessagesParams): AnalyzerMessage[] {
  const { requirement, summary } = params;
  const schemaJson = JSON.stringify(compactSummary(summary));
  return [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(`Requirement:
${requirement}

Available schema (JSON):
${schemaJson}

Return ONLY the BlockSpec JSON object.`),
  ];
}

/**
 * Invoke the chat model with a hard timeout of {@link LLM_TIMEOUT_MS}.
 *
 * Races the model call against a timer that rejects with a clear error, so a
 * hung provider can never block the build worker indefinitely. The raw model
 * output is cleaned (`stripThink`/`stripFence`) and reduced to the outermost
 * JSON object via {@link extractJsonObject}; parsing/validation/fallback are
 * handled by task 4.3.
 */
export async function invokeLLM(provider: LLMProvider, messages: AnalyzerMessage[]): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM invocation timed out after ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([provider.chatModel.invoke(messages), timeout]);
    return extractJsonObject(toPlainText(response.content));
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/*
 * Task 4.3: full analyzer entry — compose provider acquisition + invocation
 * (task 4.2), output cleaning + JSON extraction (task 4.1), shape validation,
 * and the grounded fallback (task 4.4) into a single `analyze(...)` stage.
 */

/**
 * The result of running the AI Analyzer stage.
 *
 * `spec` is always a usable {@link BlockSpec}: either the model's validated
 * output, or — when the model output cannot be parsed/validated or the LLM call
 * fails (timeout/transport) — the grounded fallback from
 * {@link buildFallbackSpec}. `usedFallback` records which path produced `spec`,
 * and `error` carries a concise human-readable reason for the fallback so the
 * caller (task 7.2) can persist it on the Build_Record. `analyze` performs no
 * DB writes itself.
 */
export interface AnalyzeResult {
  spec: BlockSpec;
  usedFallback: boolean;
  error?: string;
}

/**
 * Inputs to {@link analyze}.
 */
export interface AnalyzeParams {
  /** The user's natural-language requirement. */
  requirement: string;
  /** The introspected schema for the selected collections. */
  summary: SchemaSummary;
  /** The configured AI plugin LLM service name. */
  llmService: string;
  /** The model to invoke within that service. */
  model: string;
}

/**
 * Parse and shape-validate raw LLM output into a {@link BlockSpec}.
 *
 * Runs `JSON.parse` followed by `blockSpecSchema.safeParse`. On either failure
 * returns `{ ok: false, error }` with a concise message describing what went
 * wrong (Req 5.5); the caller turns that into a fallback. The input is expected
 * to already be the extracted JSON-object substring produced by
 * {@link invokeLLM} / {@link extractJsonObject}.
 */
export function parseBlockSpec(raw: string): { ok: true; spec: BlockSpec } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to parse LLM output as JSON: ${reason}` };
  }

  const result = blockSpecSchema.safeParse(parsed);
  if (!result.success) {
    const reason = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: `LLM output did not match BlockSpec shape: ${reason}` };
  }

  return { ok: true, spec: result.data as BlockSpec };
}

/**
 * Run the AI Analyzer stage: invoke the configured LLM with a prompt built from
 * the requirement + schema summary, then parse and shape-validate the output
 * into a {@link BlockSpec}.
 *
 * Failure handling (the result is always usable):
 * - parse/shape failure (Req 5.5) → grounded fallback with the parse error.
 * - LLM error / timeout / transport failure (Req 5.6) → grounded fallback with
 *   the underlying error message.
 *
 * `analyze` never writes to the database; it returns `error` so the caller
 * (task 7.2) can record it on the Build_Record.
 */
export async function analyze(app: Application, params: AnalyzeParams): Promise<AnalyzeResult> {
  const { requirement, summary, llmService, model } = params;

  let raw: string;
  try {
    const provider = await getLLMProvider(app, llmService, model);
    const messages = buildAnalyzerMessages({ requirement, summary });
    raw = await invokeLLM(provider, messages);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { spec: buildFallbackSpec(summary), usedFallback: true, error };
  }

  const parsed = parseBlockSpec(raw);
  if (parsed.ok) {
    return { spec: parsed.spec, usedFallback: false };
  }

  return { spec: buildFallbackSpec(summary), usedFallback: true, error: parsed.error };
}
