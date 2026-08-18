import type { Application } from '@nocobase/server';
import { SELECTOR_TYPES, type ClientCandidate, type FailureType, type SelectorType } from '../../constants';

export interface LLMCompletionResult {
  content: string;
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface SelectorLLMGateway {
  complete(input: { system: string; user: string }): Promise<LLMCompletionResult>;
}

export interface LLMCandidate {
  selector: string;
  selectorType: SelectorType;
  confidence: number;
  reasoning: string;
}

export interface LLMResolveInput {
  failedSelector: string;
  selectorType: SelectorType;
  failureType?: FailureType;
  errorMessage?: string;
  domSnippet?: string;
  candidates?: ClientCandidate[];
  history?: { selector: string; selectorType: SelectorType; status: string; createdAt?: string }[];
  maxDomChars?: number;
}

export interface LLMResolveResult {
  candidates: LLMCandidate[];
  model?: string;
  usage?: LLMCompletionResult['usage'];
}

const MAX_CANDIDATES = 3;

const SYSTEM_PROMPT = `You are an expert at repairing broken UI selectors for web automation (UiPath-style bots).
Given a failed selector, the failure details and a DOM snapshot, propose replacement selectors that locate the SAME element.

Strict rules:
- Respond with JSON only, no markdown fences, matching: {"candidates":[{"selector":string,"selectorType":"css"|"xpath"|"text"|"aria","confidence":number,"reasoning":string}]}
- Maximum ${MAX_CANDIDATES} candidates, best first. confidence is between 0 and 1.
- Prefer stable anchors: data-testid, name, aria-label, role, placeholder, unique visible text. Avoid positional paths, generated ids and volatile classes.
- A CSS candidate must be valid CSS that matches exactly one element in the provided DOM snapshot.
- If the DOM snapshot is missing or no reliable selector can be derived, return {"candidates":[]}.`;

const clampConfidence = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.max(0, Math.min(1, parsed));
};

export const buildResolverPrompt = (input: LLMResolveInput): { system: string; user: string } => {
  const lines: string[] = [
    `FAILED SELECTOR (${input.selectorType}): ${input.failedSelector}`,
    `FAILURE TYPE: ${input.failureType ?? 'unknown'}`,
  ];
  if (input.errorMessage) lines.push(`ERROR: ${input.errorMessage}`);

  if (input.domSnippet) {
    const snippet = input.domSnippet.slice(0, input.maxDomChars ?? 16000);
    lines.push('', 'DOM SNIPPET:', snippet);
  } else {
    lines.push('', 'DOM SNIPPET: (not provided)');
  }

  if (input.candidates?.length) {
    lines.push('', 'CANDIDATE ELEMENTS REPORTED BY CLIENT:');
    input.candidates.slice(0, 10).forEach((candidate, index) => {
      lines.push(`#${index + 1} ${JSON.stringify(candidate)}`);
    });
  }

  if (input.history?.length) {
    lines.push('', 'SELECTOR HISTORY FOR THIS ELEMENT (newest last):');
    input.history.slice(-5).forEach((record) => {
      lines.push(`- [${record.status}] (${record.selectorType}) ${record.selector}`);
    });
  }

  lines.push('', 'Return the JSON object now.');
  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
};

const extractJson = (content: string): unknown => {
  const cleaned = content.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to slicing for prose-wrapped payloads
  }
  const bracketPairs: [string, string][] = cleaned.startsWith('[')
    ? [
        ['[', ']'],
        ['{', '}'],
      ]
    : [
        ['{', '}'],
        ['[', ']'],
      ];
  for (const [open, close] of bracketPairs) {
    const start = cleaned.indexOf(open);
    const end = cleaned.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // try the next bracket pair
      }
    }
  }
  return null;
};

export const parseLLMCandidates = (content: string): LLMCandidate[] => {
  const parsed = extractJson(content);
  let rawCandidates: unknown[] = [];
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray((parsed as { candidates?: unknown }).candidates)) {
      rawCandidates = (parsed as { candidates: unknown[] }).candidates;
    } else if (Array.isArray(parsed)) {
      rawCandidates = parsed as unknown[];
    } else if (typeof (parsed as { selector?: unknown }).selector === 'string') {
      rawCandidates = [parsed];
    }
  }

  const candidates: LLMCandidate[] = [];
  for (const raw of rawCandidates) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const selector = typeof record.selector === 'string' ? record.selector.trim() : '';
    if (!selector) continue;
    const selectorType = SELECTOR_TYPES.includes(record.selectorType as SelectorType)
      ? (record.selectorType as SelectorType)
      : 'css';
    candidates.push({
      selector,
      selectorType,
      confidence: clampConfidence(record.confidence),
      reasoning: typeof record.reasoning === 'string' ? record.reasoning : '',
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
};

export class LLMResolver {
  constructor(private readonly gateway: SelectorLLMGateway) {}

  async resolve(input: LLMResolveInput): Promise<LLMResolveResult> {
    const { system, user } = buildResolverPrompt(input);
    const completion = await this.gateway.complete({ system, user });
    return {
      candidates: parseLLMCandidates(completion.content),
      model: completion.model,
      usage: completion.usage,
    };
  }
}

const extractText = (result: unknown): string => {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '',
      )
      .join('');
  }
  return '';
};

type AiManagerLike = {
  getLLMService(options: { llmService: string; model: string }): Promise<{
    provider: { invoke(context: { messages: { role: string; content: string }[] }): Promise<unknown> };
  }>;
};

type PluginAiLike = { aiManager?: AiManagerLike };

// Runtime adapter over @nocobase/plugin-ai. Resolved lazily so the registry
// still boots (and serves cached selectors) when plugin-ai is disabled.
export class PluginAiSelectorGateway implements SelectorLLMGateway {
  constructor(
    private readonly app: Application,
    private readonly options: { llmService: string; model: string },
  ) {}

  async complete(input: { system: string; user: string }): Promise<LLMCompletionResult> {
    const plugin = this.app.pm.get('ai') as PluginAiLike | undefined;
    if (!plugin?.aiManager) {
      throw new Error('plugin-ai is required for LLM selector resolution');
    }
    const { provider } = await plugin.aiManager.getLLMService({
      llmService: this.options.llmService,
      model: this.options.model,
    });
    const result = await provider.invoke({
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
    });
    return { content: extractText(result), model: this.options.model };
  }
}
