import type { Context } from '@nocobase/actions';
import { getAiApiConfig, resolveRequestUserGroup } from './request-cache';

export type ContextOverflowBehavior = 'reject' | 'truncate';

export interface OpenAIMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  [key: string]: unknown;
}

interface ModelMetadata {
  contextWindow: number;
  maxCompletionTokens: number;
  systemPrompt?: string;
}

interface ContextPreparationOptions {
  serviceName: string;
  modelId: string;
  messages: OpenAIMessage[];
  tools?: unknown;
  maxCompletionTokens?: unknown;
  maxTokens?: unknown;
}

export interface PreparedDirectLlmContext {
  messages: OpenAIMessage[];
  estimatedInputTokens: number;
  inputTokenBudget: number;
  reservedOutputTokens: number;
  truncated: boolean;
}

export class DirectLlmContextError extends Error {
  constructor(
    readonly code:
      | 'context_length_exceeded'
      | 'context_estimation_unsupported'
      | 'max_completion_tokens_exceeds_model_limit',
    message: string,
  ) {
    super(message);
    this.name = 'DirectLlmContextError';
  }
}

function getValue<T>(
  record: { get?: (key: string) => unknown; [key: string]: unknown } | null,
  key: string,
): T | undefined {
  return (record?.get?.(key) as T | undefined) ?? (record?.[key] as T | undefined);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function estimateValueTokens(value: unknown): number {
  if (value === undefined) return 0;
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── Image dimension parsing ───

interface ImageDimensions {
  width: number;
  height: number;
}

function readBigEndian(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

function readUInt16BE(buf: Buffer, offset: number): number {
  return buf.readUInt16BE(offset);
}

function readLittleEndian(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function parsePngDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 24) return undefined;
  return { width: readBigEndian(buffer, 16), height: readBigEndian(buffer, 20) };
}

function parseJpegDimensions(buffer: Buffer): ImageDimensions | undefined {
  let offset = 2; // skip SOI
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    // SOF0, SOF1, SOF2, SOF3, SOF5, SOF6, SOF7, SOF9, SOF10, SOF11, SOF13, SOF14, SOF15
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (offset + 9 <= buffer.length) {
        return { height: readUInt16BE(buffer, offset + 5), width: readUInt16BE(buffer, offset + 7) };
      }
      return undefined;
    }
    if (marker === 0xd9 || offset + 4 >= buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  return undefined;
}

function parseGifDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 10) return undefined;
  return { width: readLittleEndian(buffer, 6), height: readLittleEndian(buffer, 8) };
}

function parseWebpDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 30) return undefined;
  const riff = buffer.toString('ascii', 0, 4);
  const webp = buffer.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || webp !== 'WEBP') return undefined;

  const chunkType = buffer.toString('ascii', 12, 16);
  if (chunkType === 'VP8 ' && buffer.length >= 26) {
    // Simple lossy WebP
    return { width: readLittleEndian(buffer, 26), height: readLittleEndian(buffer, 28) };
  }
  if (chunkType === 'VP8L' && buffer.length >= 24) {
    // Lossless WebP: dimensions packed into 32 bits at offset 21
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunkType === 'VP8X' && buffer.length >= 30) {
    // Extended WebP: width/height at offset 24, 27
    return {
      width: ((buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) & 0xffffff) + 1,
      height: ((buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) & 0xffffff) + 1,
    };
  }
  return undefined;
}

export function parseImageDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 12) return undefined;
  // Use 'binary' (latin1) so high bytes such as PNG's 0x89 are preserved.
  const header = buffer.toString('binary', 0, 4);
  if (header === '\x89PNG') return parsePngDimensions(buffer);
  if (header === 'GIF8') return parseGifDimensions(buffer);
  if (header === 'RIFF') return parseWebpDimensions(buffer);
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return parseJpegDimensions(buffer);
  return undefined;
}

// ─── Vision token estimation ───

const VISION_TILE_SIZE = 512;
const VISION_LOW_DETAIL_TOKENS = 85;
const VISION_TILE_TOKENS = 170;
const VISION_HTTP_URL_ESTIMATE = 1024;
const FILE_BASE64_FALLBACK_TOKENS = 1024;

function estimateVisionTokensForDimensions(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return VISION_LOW_DETAIL_TOKENS;
  }
  const tilesX = Math.ceil(width / VISION_TILE_SIZE);
  const tilesY = Math.ceil(height / VISION_TILE_SIZE);
  return VISION_LOW_DETAIL_TOKENS + tilesX * tilesY * VISION_TILE_TOKENS;
}

function decodeBase64DataUrl(url: string): { mimeType: string; buffer: Buffer } | undefined {
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/]+=?=?)$/.exec(url);
  if (!match) return undefined;
  try {
    const buffer = Buffer.from(match[2], 'base64');
    return { mimeType: match[1].toLowerCase(), buffer };
  } catch {
    return undefined;
  }
}

function estimateImageUrlTokens(imageUrl: unknown): number {
  const url = typeof imageUrl === 'string' ? imageUrl : isRecord(imageUrl) ? String(imageUrl.url ?? '') : '';
  if (!url) return 0;

  if (url.startsWith('data:')) {
    const decoded = decodeBase64DataUrl(url);
    if (!decoded) return FILE_BASE64_FALLBACK_TOKENS;
    if (!decoded.mimeType.startsWith('image/')) return FILE_BASE64_FALLBACK_TOKENS;
    const dimensions = parseImageDimensions(decoded.buffer);
    return dimensions
      ? estimateVisionTokensForDimensions(dimensions.width, dimensions.height)
      : VISION_LOW_DETAIL_TOKENS;
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    // We cannot fetch here because context enforcement runs before any
    // network I/O. Use a conservative fixed estimate.
    return VISION_HTTP_URL_ESTIMATE;
  }

  return 0;
}

function estimateFileBlockTokens(block: Record<string, unknown>): number {
  const file = isRecord(block.file) ? block.file : undefined;
  if (!file) return 0;

  const fileData = String(file.file_data ?? '');
  if (fileData.startsWith('data:')) {
    const decoded = decodeBase64DataUrl(fileData);
    if (decoded) {
      // Conservative upper-bound: one token per ~3 bytes of decoded binary.
      return Math.max(1, Math.ceil(decoded.buffer.length / 3));
    }
    // Fallback when the data URL is malformed or cannot be decoded.
    // The request is still forwarded; the provider will reject it if invalid.
    return FILE_BASE64_FALLBACK_TOKENS;
  }

  return FILE_BASE64_FALLBACK_TOKENS;
}

function estimateContentBlockTokens(block: unknown): number {
  if (!isRecord(block)) return estimateValueTokens(block);

  const type = typeof block.type === 'string' ? block.type : undefined;
  if (type === 'text') {
    return typeof block.text === 'string' ? estimateValueTokens(block.text) + 4 : 4;
  }
  if (type === 'image_url') {
    return estimateImageUrlTokens(block.image_url) + 4;
  }
  if (type === 'file') {
    return estimateFileBlockTokens(block) + 4;
  }
  if (type === 'file_url') {
    // Will be converted to a `file` block before reaching the model; use a
    // conservative placeholder until processing runs.
    return VISION_HTTP_URL_ESTIMATE + 4;
  }
  return estimateValueTokens(block) + 4;
}

function estimateMessageTokens(message: OpenAIMessage): number {
  if (Array.isArray(message.content)) {
    return message.content.reduce((total, block) => total + estimateContentBlockTokens(block), 4);
  }
  return estimateValueTokens(message) + 4;
}

function estimateMessagesTokens(messages: OpenAIMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function isInstruction(message: OpenAIMessage): boolean {
  return message.role === 'system' || message.role === 'developer';
}

function splitTurns(messages: OpenAIMessage[]): { fixed: OpenAIMessage[]; turns: OpenAIMessage[][] } {
  const fixed: OpenAIMessage[] = [];
  const turns: OpenAIMessage[][] = [];
  let currentTurn: OpenAIMessage[] | undefined;

  for (const message of messages) {
    if (isInstruction(message)) {
      fixed.push(message);
      continue;
    }
    if (message.role === 'user' || !currentTurn) {
      currentTurn = [message];
      turns.push(currentTurn);
      continue;
    }
    currentTurn.push(message);
  }

  return { fixed, turns };
}

function messagesWithTurns(messages: OpenAIMessage[], turns: OpenAIMessage[][]): OpenAIMessage[] {
  const retainedMessages = new Set(turns.flat());
  return messages.filter((message) => isInstruction(message) || retainedMessages.has(message));
}

/**
 * Gateway-wide context budget used when a model has no metadata override (or a
 * partial one). Direct LLM mode must work out of the box for every model; the
 * metadata table is an override mechanism, not a prerequisite. Providers still
 * reject requests that exceed their real window, and admins can tighten the
 * budget per model by adding a metadata row.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_COMPLETION_TOKENS = 8_192;

async function loadModelMetadata(ctx: Context, serviceName: string, modelId: string): Promise<ModelMetadata> {
  const row = await ctx.db.getRepository('aiApiModelMetadata').findOne({
    filter: { llmService: serviceName, model: modelId, enabled: true },
  });
  const config = await getAiApiConfig(ctx);
  const contextWindow =
    positiveInteger(getValue<unknown>(row, 'contextWindow')) ??
    positiveInteger(getValue<unknown>(config, 'defaultContextWindow')) ??
    DEFAULT_CONTEXT_WINDOW;
  const maxCompletionTokens =
    positiveInteger(getValue<unknown>(row, 'maxCompletionTokens')) ??
    positiveInteger(getValue<unknown>(config, 'defaultMaxCompletionTokens')) ??
    DEFAULT_MAX_COMPLETION_TOKENS;
  const systemPromptValue = getValue<unknown>(row, 'systemPrompt');
  const systemPrompt = typeof systemPromptValue === 'string' ? systemPromptValue.trim() : '';
  return { contextWindow, maxCompletionTokens, ...(systemPrompt ? { systemPrompt } : {}) };
}

async function resolveOverflowBehavior(ctx: Context): Promise<ContextOverflowBehavior> {
  const userId = ctx.state.currentUser?.id;
  if (userId === null || userId === undefined) return 'reject';
  const group = await resolveRequestUserGroup(ctx, userId);
  return group.contextOverflowBehavior === 'truncate' ? 'truncate' : 'reject';
}

function resolveReservedOutputTokens(options: ContextPreparationOptions, metadata: ModelMetadata): number {
  const requested = positiveInteger(options.maxCompletionTokens ?? options.maxTokens);
  if (requested && requested > metadata.maxCompletionTokens) {
    throw new DirectLlmContextError(
      'max_completion_tokens_exceeds_model_limit',
      `Requested max completion tokens (${requested}) exceeds the model limit (${metadata.maxCompletionTokens}).`,
    );
  }
  return requested ?? metadata.maxCompletionTokens;
}

export async function prepareDirectLlmContext(
  ctx: Context,
  options: ContextPreparationOptions,
): Promise<PreparedDirectLlmContext> {
  const [metadata, behavior] = await Promise.all([
    loadModelMetadata(ctx, options.serviceName, options.modelId),
    resolveOverflowBehavior(ctx),
  ]);
  const reservedOutputTokens = resolveReservedOutputTokens(options, metadata);
  const inputTokenBudget = metadata.contextWindow - reservedOutputTokens;
  if (inputTokenBudget <= 0) {
    throw new DirectLlmContextError(
      'context_length_exceeded',
      `The model context window (${metadata.contextWindow}) leaves no input capacity after reserving ${reservedOutputTokens} output tokens.`,
    );
  }

  const fixedOverheadTokens = estimateValueTokens(options.tools) + (options.tools === undefined ? 0 : 4);
  // The initial system prompt from model metadata is prepended before every
  // client message — including the client's own system prompt, which is kept.
  // Being a system message, it is a fixed instruction that truncation never
  // drops, and it counts toward the input budget.
  const baseMessages: OpenAIMessage[] = metadata.systemPrompt
    ? [{ role: 'system', content: metadata.systemPrompt }, ...options.messages]
    : options.messages;
  const originalEstimate = estimateMessagesTokens(baseMessages) + fixedOverheadTokens;
  if (originalEstimate <= inputTokenBudget) {
    return {
      messages: baseMessages,
      estimatedInputTokens: originalEstimate,
      inputTokenBudget,
      reservedOutputTokens,
      truncated: false,
    };
  }

  if (behavior === 'reject') {
    throw new DirectLlmContextError(
      'context_length_exceeded',
      `Estimated input tokens (${originalEstimate}) exceed the allowed input budget (${inputTokenBudget}).`,
    );
  }

  const { turns } = splitTurns(baseMessages);
  let remainingTurns = turns;
  let messages = messagesWithTurns(baseMessages, remainingTurns);
  let estimatedInputTokens = estimateMessagesTokens(messages) + fixedOverheadTokens;

  while (remainingTurns.length > 1 && estimatedInputTokens > inputTokenBudget) {
    remainingTurns = remainingTurns.slice(1);
    messages = messagesWithTurns(baseMessages, remainingTurns);
    estimatedInputTokens = estimateMessagesTokens(messages) + fixedOverheadTokens;
  }

  if (estimatedInputTokens > inputTokenBudget) {
    throw new DirectLlmContextError(
      'context_length_exceeded',
      `The fixed instructions, tools, and newest conversation turn require ${estimatedInputTokens} input tokens, exceeding the allowed budget (${inputTokenBudget}).`,
    );
  }

  return {
    messages,
    estimatedInputTokens,
    inputTokenBudget,
    reservedOutputTokens,
    truncated: messages.length !== baseMessages.length,
  };
}
