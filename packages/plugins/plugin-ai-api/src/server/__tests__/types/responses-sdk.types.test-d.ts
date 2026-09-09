/**
 * Compile-time structural contracts: local response shapes must be assignable to
 * the OpenAI SDK types. If this file compiles, the runtime payload shape is SDK-compatible.
 * Run with: tsc -p tsconfig.test.json --noEmit
 */
import type {
  Response as OpenAIResponse,
  ResponseCreatedEvent,
  ResponseCompletedEvent,
  ResponseUsage,
} from 'openai/resources/responses/responses';
import type { ResponseObject } from '../../utils/responses-format';

// ─── ResponseObject must be assignable to the SDK Response type ──────────────
declare const responseObject: ResponseObject;
const sdkResponse: OpenAIResponse = responseObject;

// ─── ResponseStreamEvent terminal payloads must be SDK-compatible ────────────
declare const response: OpenAIResponse;
const sdkCreated: ResponseCreatedEvent = { type: 'response.created', response, sequence_number: 0 };
const sdkCompleted: ResponseCompletedEvent = { type: 'response.completed', response, sequence_number: 0 };

export { sdkResponse, sdkCreated, sdkCompleted };