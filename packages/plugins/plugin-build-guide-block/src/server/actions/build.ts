/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context, Next } from '@nocobase/actions';
import { Repository } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import sanitizeHtml from 'sanitize-html';
// @ts-ignore
import { PluginAIServer } from '@nocobase/plugin-ai';
// @ts-ignore
import { PluginFileManagerServer } from '@nocobase/plugin-file-manager';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { marked } from 'marked';
import { Op } from 'sequelize';
import { NoPermissionError } from '@nocobase/acl';

const MAX_SOURCE_CHARS = 90000;
const MIN_CHAPTERS = 1;
const MAX_CHAPTERS = 12;
const DEFAULT_TARGET_CHAPTERS = 5;
export const WORKER_JOB_BUILD_GUIDE_PROCESS = 'build-guide:process';

const BUILD_GUIDE_QUEUE_CHANNEL = 'plugin-build-guide-block.build';
const BUILD_GUIDE_WORKER_ALIASES = [BUILD_GUIDE_QUEUE_CHANNEL, 'plugin-build-guide-block:build:queue'];
const BUILD_GUIDE_QUEUE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.BUILD_GUIDE_QUEUE_CONCURRENCY || process.env.BUILD_GUIDE_MAX_CONCURRENCY || '1', 10) || 1,
);
const BUILD_GUIDE_QUEUE_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.BUILD_GUIDE_QUEUE_TIMEOUT_MS || '', 10) || 30 * 60 * 1000,
);
const BUILD_GUIDE_QUEUE_POLL_INTERVAL_MS = Math.max(
  1000,
  Number.parseInt(process.env.BUILD_GUIDE_QUEUE_POLL_INTERVAL_MS || '', 10) || 5000,
);
const BUILD_GUIDE_QUEUE_WAKE_CHANNEL = 'plugin-build-guide-block.build.wake';
const BUILD_GUIDE_QUEUE_REDIS_CONNECTION = 'plugin-build-guide-block.build.queue';
const BUILD_TRIGGER_LOCK_TTL_MS = 30_000;
const BUILD_HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  Number.parseInt(process.env.BUILD_GUIDE_HEARTBEAT_MS || '', 10) || 30_000,
);
const BUILD_STALE_MS = Math.max(
  BUILD_HEARTBEAT_INTERVAL_MS * 2,
  Number.parseInt(process.env.BUILD_GUIDE_STALE_MS || '', 10) || 120_000,
);
const BUILD_RECOVERY_INTERVAL_MS = Math.max(
  BUILD_GUIDE_QUEUE_POLL_INTERVAL_MS,
  Number.parseInt(process.env.BUILD_GUIDE_RECOVERY_INTERVAL_MS || '', 10) || 30_000,
);
const BUILD_RECOVERY_BATCH_SIZE = 100;

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.xml',
  '.html',
  '.htm',
  '.yaml',
  '.yml',
  '.log',
  '.sql',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.scss',
  '.less',
]);
const TEXT_MIMETYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/typescript',
  'image/svg+xml',
]);

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'div',
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tr',
    'td',
    'th',
    'a',
    'img',
    'span',
    'strong',
    'em',
    'code',
    'pre',
    'blockquote',
    'br',
    'hr',
  ],
  allowedAttributes: {
    a: ['href', 'target'],
    img: ['src', 'alt', 'width', 'height'],
    '*': ['style', 'class', 'id'],
  },
  allowedStyles: {
    '*': {
      color: [/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, /^rgb/, /^rgba/],
      'background-color': [/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, /^rgb/, /^rgba/],
      'text-align': [/^left$/, /^right$/, /^center$/, /^justify$/],
      'font-size': [/^\d+(?:px|em|%)$/],
    },
  },
};

export type GuidePlanItem = {
  title: string;
  goal?: string;
  sourceHints?: string[];
};

export type GuidePlan = {
  title?: string;
  chapters: GuidePlanItem[];
};

type GuideSearchMetadata = {
  title: string;
  slug: string;
  goal?: string;
  guideTitle?: string;
  sourceHints: string[];
  headings: string[];
  keywords: string[];
  summary?: string;
};

type BuildGuideQueueMessage = {
  spaceId: string;
  runId: string;
  userId?: number | string | null;
  queuedAt?: string;
};

type BuildRunContext = {
  spaceId: string;
  runId: string;
  workerId?: string;
};

export type BuildGuideInputSnapshot = {
  title: string;
  llmService: string;
  model: string;
  systemPrompt: string;
  outputFormat: string;
  targetChapterCount: number;
  chapterGuidance: string;
  documentsText: string;
  sourceHash: string;
  sourceWarnings?: BuildGuideSourceWarning[];
};

export type BuildGuideSourceWarning = {
  code: 'SOURCE_UNSUPPORTED' | 'SOURCE_READ_FAILED' | 'SOURCE_PARSE_FAILED' | 'SOURCE_EMPTY';
  documentId: string;
  filename: string;
};

type BuildGuideDocumentRead = {
  documentsText: string;
  sourceWarnings: BuildGuideSourceWarning[];
};

export type BuildGuideInputDescriptor = Omit<BuildGuideInputSnapshot, 'documentsText' | 'sourceHash'> & {
  documents: Array<{
    id: string | number;
    updatedAt: string;
    filename: string;
    mimetype: string;
    extname: string;
  }>;
};

let buildQueueTimer: NodeJS.Timeout | null = null;
let buildQueueKickTimer: NodeJS.Timeout | null = null;
let buildQueueProcessing = false;
let buildQueueWakeHandler: ((message?: any) => Promise<void>) | null = null;
let buildRecoveryTimer: NodeJS.Timeout | null = null;
let buildRecoveryProcessing = false;
let buildRecoveryCursor: string | null = null;
let buildQueueRunCursor: { createdAt: Date; id: string } | null = null;

class StaleBuildRunError extends Error {
  constructor(spaceId: string, runId: string) {
    super(`Build run ${runId} for space ${spaceId} is no longer current`);
    this.name = 'StaleBuildRunError';
  }
}

class BuildGuideSourceError extends Error {
  readonly code = 'SOURCE_NO_USABLE_TEXT';

  constructor(readonly sourceWarnings: BuildGuideSourceWarning[]) {
    super('No configured source documents could be read');
    this.name = 'BuildGuideSourceError';
  }
}

export function clampChapterCount(value: unknown) {
  const count = Number(value);
  if (!Number.isFinite(count)) return DEFAULT_TARGET_CHAPTERS;
  return Math.max(MIN_CHAPTERS, Math.min(MAX_CHAPTERS, Math.round(count)));
}

function resolveExtname(file: any) {
  const explicit = file?.extname;
  if (typeof explicit === 'string' && explicit) return explicit.toLowerCase();
  const name = file?.filename || file?.name || '';
  const index = String(name).lastIndexOf('.');
  return index >= 0 ? String(name).slice(index).toLowerCase() : '';
}

function isTextDocument(file: any) {
  const mimetype = String(file?.mimetype || '').toLowerCase();
  if (mimetype.startsWith('text/')) return true;
  if (TEXT_MIMETYPES.has(mimetype)) return true;
  return TEXT_EXTENSIONS.has(resolveExtname(file));
}

function createParserContext(app: any) {
  const headers: Record<string, string> = { 'x-timezone': '+00:00', 'x-locale': 'en-US' };
  return {
    app,
    db: app.db,
    log: app.log || app.logger || console,
    logger: app.logger || app.log || console,
    state: {},
    auth: {},
    req: { headers },
    request: { headers },
    get(name: string) {
      return headers[String(name).toLowerCase()] || '';
    },
    getCurrentLocale() {
      return 'en-US';
    },
    t(key: string) {
      return key;
    },
    i18n: {
      t(key: string) {
        return key;
      },
    },
  };
}

function extractParsedText(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractParsedText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (value.content) return extractParsedText(value.content);
    if (value.message) return extractParsedText(value.message);
  }
  return '';
}

function getDocumentParserPlugin(app: any) {
  return app.pm?.get?.('@nocobase/plugin-document-parser') || app.pm?.get?.('plugin-document-parser') || null;
}

function sourceWarning(file: any, code: BuildGuideSourceWarning['code']): BuildGuideSourceWarning {
  const filename = String(file?.filename || file?.name || 'document');
  return {
    code,
    documentId: String(file?.id ?? ''),
    filename: path.basename(filename).slice(0, 160),
  };
}

type SourceReadOutcome = { text: string; warning?: BuildGuideSourceWarning };

function sourceTextOutcome(file: any, value: string): SourceReadOutcome {
  const text = value.trim();
  return text ? { text } : { text: '', warning: sourceWarning(file, 'SOURCE_EMPTY') };
}

async function fetchTextFileContent(app: any, file: any): Promise<SourceReadOutcome> {
  if (!isTextDocument(file)) {
    return { text: '', warning: sourceWarning(file, 'SOURCE_UNSUPPORTED') };
  }

  const docParserPlugin = getDocumentParserPlugin(app);
  try {
    if (docParserPlugin?.fetchFileBuffer) {
      const { buffer } = await docParserPlugin.fetchFileBuffer(createParserContext(app), file);
      return sourceTextOutcome(file, buffer.toString('utf8'));
    }

    const fileManager = app.pm?.get?.('file-manager') as PluginFileManagerServer | undefined;
    if (!fileManager) return { text: '', warning: sourceWarning(file, 'SOURCE_READ_FAILED') };
    const url = await fileManager.getFileURL(file);
    if (url.startsWith('http')) {
      const response = await axios.get(url, { responseType: 'text', timeout: 15000 });
      return sourceTextOutcome(file, String(response.data ?? ''));
    }

    let localPath = url;
    if (process.env.APP_PUBLIC_PATH && localPath.startsWith(process.env.APP_PUBLIC_PATH)) {
      localPath = localPath.slice(process.env.APP_PUBLIC_PATH.length);
    }
    localPath = path.join(process.cwd(), localPath);
    return sourceTextOutcome(file, await fs.promises.readFile(localPath, 'utf8'));
  } catch (err) {
    app.log?.warn?.('[plugin-build-guide-block] Failed to read a source document', {
      errorName: err instanceof Error ? err.name : 'Error',
    });
    return { text: '', warning: sourceWarning(file, 'SOURCE_READ_FAILED') };
  }
}

async function parseWithDocumentParser(app: any, file: any): Promise<SourceReadOutcome | null> {
  const docParserPlugin = getDocumentParserPlugin(app);
  if (!docParserPlugin) return null;

  const parserCtx = createParserContext(app);
  if (docParserPlugin.documentParseService?.parseAttachment) {
    try {
      const result = await docParserPlugin.documentParseService.parseAttachment(parserCtx, file, { useCase: 'api' });
      if (result?.handled && typeof result.text === 'string' && result.text.trim()) {
        return sourceTextOutcome(file, result.text);
      }
      if (result?.handled) return { text: '', warning: sourceWarning(file, 'SOURCE_EMPTY') };
      return null;
    } catch (err) {
      app.log?.warn?.('[plugin-build-guide-block] Document parser failed', {
        errorName: err instanceof Error ? err.name : 'Error',
      });
      return { text: '', warning: sourceWarning(file, 'SOURCE_PARSE_FAILED') };
    }
  }

  const defaultParser = async () => {
    const result = await fetchTextFileContent(app, file);
    return { placement: 'contentBlocks', content: { type: 'text', text: result.text } };
  };

  const isParserDirective = (text: string) =>
    /<document_indexed\b/i.test(text) ||
    /^\s*\[Attachment:.*(?:no parser available|unsupported|no usable text).*(?:\]|$)/i.test(text);

  try {
    if (docParserPlugin.parseRouter?.route) {
      const result = await docParserPlugin.parseRouter.route(parserCtx, file, defaultParser);
      const text = extractParsedText(result?.content);
      if (text.trim() && !isParserDirective(text)) return sourceTextOutcome(file, text);
    }

    if (docParserPlugin.internalParserRegistry?.parse) {
      const result = await docParserPlugin.internalParserRegistry.parse(file, parserCtx);
      if (result?.handled && result?.text?.trim()) {
        return sourceTextOutcome(file, result.text);
      }
    }
  } catch (err) {
    app.log?.warn?.('[plugin-build-guide-block] Document parser failed', {
      errorName: err instanceof Error ? err.name : 'Error',
    });
    return { text: '', warning: sourceWarning(file, 'SOURCE_PARSE_FAILED') };
  }

  return null;
}

async function fetchFileContent(app: any, file: any): Promise<SourceReadOutcome> {
  const parsed = await parseWithDocumentParser(app, file);
  if (parsed?.text.trim()) return parsed;
  const fallback = await fetchTextFileContent(app, file);
  if (fallback.text.trim() || !parsed?.warning) return fallback;
  return parsed;
}

export function toPlainText(value: unknown) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item: any) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const text = (value as any).text || (value as any).content;
    if (typeof text === 'string') return text;
  }
  return JSON.stringify(value);
}

function stripThink(text: string) {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

function stripFence(text: string) {
  return text
    .replace(/^```(?:json|markdown|md|html)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

export function slugify(text: string, fallback: string) {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function normalizeSearchText(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueValues(values: string[], limit: number) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalizeSearchText(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function extractMarkdownHeadings(markdown: string) {
  return uniqueValues(
    markdown
      .split(/\r?\n/)
      .map((line) => line.match(/^\s{0,3}#{1,4}\s+(.+?)\s*#*\s*$/)?.[1] || '')
      .filter(Boolean),
    12,
  );
}

function stripMarkdownForSearch(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|`-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractKeywords(...parts: string[]) {
  const stopWords = new Set([
    'about',
    'after',
    'before',
    'chapter',
    'configuration',
    'guide',
    'into',
    'this',
    'that',
    'the',
    'and',
    'for',
    'with',
    'from',
    'how',
    'what',
    'when',
    'where',
    'which',
    'a',
    'an',
    'to',
    'of',
    'in',
    'on',
    'by',
    'or',
    'is',
    'are',
    'be',
    'can',
    'cach',
    'cac',
    'cho',
    'cua',
    'duoc',
    'huong',
    'dan',
    'la',
    'mot',
    'nguoi',
    'nhung',
    'tao',
    'thiet',
    'trong',
    'va',
    'voi',
  ]);
  const tokens = normalizeSearchText(parts.join(' '))
    .split(' ')
    .filter((token) => token.length >= 3 && !stopWords.has(token));
  return uniqueValues(tokens, 40);
}

export function createGuideSearchMetadata(params: {
  chapter: GuidePlanItem;
  guideTitle?: string;
  markdown?: string;
  slug: string;
}): { metadata: GuideSearchMetadata; searchText: string } {
  const markdown = params.markdown || '';
  const headings = extractMarkdownHeadings(markdown);
  const plainText = stripMarkdownForSearch(markdown);
  const sourceHints = uniqueValues(params.chapter.sourceHints || [], 20);
  const summary = plainText.slice(0, 500);
  const keywords = extractKeywords(
    params.guideTitle || '',
    params.chapter.title,
    params.chapter.goal || '',
    sourceHints.join(' '),
    headings.join(' '),
    plainText.slice(0, 4000),
  );
  const metadata: GuideSearchMetadata = {
    title: params.chapter.title,
    slug: params.slug,
    goal: params.chapter.goal,
    guideTitle: params.guideTitle,
    sourceHints,
    headings,
    keywords,
    summary,
  };
  const searchText = normalizeSearchText(
    [
      params.guideTitle,
      params.chapter.title,
      params.chapter.goal,
      params.slug,
      ...sourceHints,
      ...headings,
      ...keywords,
      summary,
    ]
      .filter(Boolean)
      .join(' '),
  );

  return { metadata, searchText };
}

function createFallbackPlan(guideTitle: string, targetChapterCount: number): GuidePlan {
  const chapterTemplates = [
    {
      title: 'Overview and scope',
      goal: 'Explain what the guide covers, who it is for, and the expected outcome.',
    },
    {
      title: 'Prerequisites and preparation',
      goal: 'List required access, tools, input data, setup steps, and assumptions before starting.',
    },
    {
      title: 'Initial setup',
      goal: 'Guide the user through the first required configuration or installation flow.',
    },
    {
      title: 'Core workflow',
      goal: 'Describe the main task flow users need to complete successfully.',
    },
    {
      title: 'Advanced usage and configuration',
      goal: 'Cover optional settings, variations, and deeper operational procedures.',
    },
    {
      title: 'Verification and validation',
      goal: 'Show how to confirm that the setup or workflow is working correctly.',
    },
    {
      title: 'Troubleshooting',
      goal: 'Document common problems, likely causes, and recovery steps.',
    },
    {
      title: 'Reference and next steps',
      goal: 'Summarize related tasks, reference information, and recommended follow-up actions.',
    },
  ];

  return {
    title: guideTitle,
    chapters: Array.from({ length: targetChapterCount }, (_, index) => {
      const template = chapterTemplates[index] || {
        title: `Additional topic ${index + 1}`,
        goal: 'Expand an important topic from the source documents into a focused guide section.',
      };
      return {
        ...template,
        sourceHints: [],
      };
    }),
  };
}

export function normalizePlan(rawText: string, guideTitle: string, targetChapterCount: number): GuidePlan {
  const targetCount = clampChapterCount(targetChapterCount);
  const cleanText = stripFence(stripThink(rawText));
  const jsonStart = cleanText.indexOf('{');
  const jsonEnd = cleanText.lastIndexOf('}');
  const jsonText = jsonStart >= 0 && jsonEnd > jsonStart ? cleanText.slice(jsonStart, jsonEnd + 1) : cleanText;
  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return createFallbackPlan(guideTitle, targetCount);
  }
  const rawChapters = Array.isArray(parsed?.chapters) ? parsed.chapters : [];
  const planTitle = parsed?.title ? String(parsed.title) : guideTitle;
  const fallbackPlan = createFallbackPlan(planTitle, targetCount);
  const chapters = fallbackPlan.chapters.map((fallback, index) => {
    const item = rawChapters[index];
    if (!item) return fallback;
    const title = typeof item === 'string' ? item : item?.title;
    const goal = typeof item === 'object' ? item?.goal : undefined;
    const sourceHints = typeof item === 'object' && Array.isArray(item?.sourceHints) ? item.sourceHints : undefined;

    return {
      title: String(title || fallback.title),
      goal: goal ? String(goal) : fallback.goal,
      sourceHints: sourceHints ? sourceHints.map((hint: any) => String(hint)) : fallback.sourceHints,
    };
  });

  return {
    title: planTitle,
    chapters,
  };
}

export async function getLLMProvider(app: any, llmService: string, model: string) {
  const aiPlugin = app.pm.get('ai') as PluginAIServer;
  if (!aiPlugin) {
    throw new Error('Plugin AI is not available');
  }
  const serviceData = await aiPlugin.aiManager.getLLMService({ llmService, model });
  return serviceData.provider;
}

export async function buildPlan(provider: any, space: any, documentsText: string): Promise<GuidePlan> {
  const { title, systemPrompt, targetChapterCount, chapterGuidance } = space.get();
  const targetCount = clampChapterCount(targetChapterCount);
  const messages = [];
  if (systemPrompt) {
    messages.push(new SystemMessage(systemPrompt));
  }
  messages.push(
    new HumanMessage(`Create a concise breakdown plan for a multi-page user guide.

Return ONLY valid JSON with this shape:
{
  "title": "Guide title",
  "chapters": [
    {
      "title": "Chapter title",
      "goal": "What this chapter should teach",
      "sourceHints": ["Relevant topics, file names, or keywords"]
    }
  ]
}

Rules:
- Create exactly ${targetCount} chapter${targetCount === 1 ? '' : 's'}.
- If more than one chapter is requested, each chapter must cover a distinct user goal.
- Keep chapter titles user-facing and action-oriented.
- Do not include markdown fences or explanations.

Guide title: ${title || 'User guide'}

Chapter guidance:
${chapterGuidance || 'Use the source document structure and split the guide into logical user-facing tasks.'}

Source documents:
${documentsText.slice(0, MAX_SOURCE_CHARS)}`),
  );
  const response = await provider.chatModel.invoke(messages);
  return normalizePlan(toPlainText(response.content), title || 'User guide', targetCount);
}

export async function buildPageMarkdown(
  provider: any,
  space: any,
  plan: GuidePlan,
  chapter: GuidePlanItem,
  documentsText: string,
) {
  const { title, systemPrompt } = space.get();
  const messages = [];
  if (systemPrompt) {
    messages.push(new SystemMessage(systemPrompt));
  }
  messages.push(
    new HumanMessage(`Write one chapter for a user guide in pure Markdown.

Output rules:
- Output ONLY Markdown content for this chapter.
- Start with a level-2 heading using the chapter title.
- Use clear steps, tables, and callouts when useful.
- Do not wrap the whole response in a code fence.
- Do not mention that this was generated by AI.

Guide title: ${plan.title || title || 'User guide'}

Full chapter plan:
${JSON.stringify(plan, null, 2)}

Chapter to write:
${JSON.stringify(chapter, null, 2)}

Source documents:
${documentsText.slice(0, MAX_SOURCE_CHARS)}`),
  );
  const response = await provider.chatModel.invoke(messages);
  return stripFence(stripThink(toPlainText(response.content)));
}

export async function markdownToCleanHtml(markdown: string) {
  const renderedHtml = await marked.parse(markdown, { async: true });
  return sanitizeHtml(renderedHtml, SANITIZE_OPTIONS);
}

export async function readDocumentsWithMetadata(app: any, space: any): Promise<BuildGuideDocumentRead> {
  const documents = await space.getDocuments();
  if (!documents || documents.length === 0) {
    return { documentsText: '', sourceWarnings: [] };
  }

  const results = await Promise.all(
    documents.map(async (document: any) => ({ document, outcome: await fetchFileContent(app, document) })),
  );
  const readable = results.filter(({ outcome }) => outcome.text.trim());
  const sourceWarnings = results
    .filter(({ outcome }) => !outcome.text.trim())
    .map(({ document, outcome }) => outcome.warning || sourceWarning(document, 'SOURCE_EMPTY'));
  if (!readable.length) throw new BuildGuideSourceError(sourceWarnings);
  return {
    documentsText: readable
      .map(({ document, outcome }) => `--- Document: ${document.filename || document.id} ---\n${outcome.text}\n`)
      .join('\n'),
    sourceWarnings,
  };
}

export async function readDocuments(app: any, space: any) {
  return (await readDocumentsWithMetadata(app, space)).documentsText;
}

export async function createBuildGuideInputDescriptor(space: any): Promise<BuildGuideInputDescriptor> {
  const values = space.get();
  if (!values.llmService || !values.model) throw new Error('LLM configuration is missing');
  return {
    title: String(values.title || ''),
    llmService: String(values.llmService),
    model: String(values.model),
    systemPrompt: String(values.systemPrompt || ''),
    outputFormat: String(values.outputFormat || 'html'),
    targetChapterCount: clampChapterCount(values.targetChapterCount),
    chapterGuidance: String(values.chapterGuidance || ''),
    documents: (await space.getDocuments()).map((document: any) => {
      const updatedAt = document.get?.('updatedAt') ?? document.updatedAt;
      if (!(updatedAt instanceof Date) && typeof updatedAt !== 'string') {
        throw new Error('Source attachment version is unavailable');
      }
      return {
        id: (document.get?.('id') ?? document.id) as string | number,
        updatedAt: new Date(updatedAt).toISOString(),
        filename: String(document.get?.('filename') ?? document.filename ?? ''),
        mimetype: String(document.get?.('mimetype') ?? document.mimetype ?? ''),
        extname: String(document.get?.('extname') ?? document.extname ?? ''),
      };
    }),
  };
}

export async function materializeBuildGuideInputSnapshot(
  app: any,
  descriptor: BuildGuideInputDescriptor,
): Promise<BuildGuideInputSnapshot> {
  const matchesDescriptor = (record: any, saved: BuildGuideInputDescriptor['documents'][number]) => {
    const updatedAt = record.get?.('updatedAt') ?? record.updatedAt;
    return (
      String(record.get?.('id') ?? record.id) === String(saved.id) &&
      updatedAt != null &&
      new Date(updatedAt).toISOString() === saved.updatedAt &&
      String(record.get?.('filename') ?? record.filename ?? '') === saved.filename &&
      String(record.get?.('mimetype') ?? record.mimetype ?? '') === saved.mimetype &&
      String(record.get?.('extname') ?? record.extname ?? '') === saved.extname
    );
  };
  const documents: unknown[] = [];
  for (const saved of descriptor.documents) {
    const record = await app.db.getRepository('attachments').findOne({ filterByTk: saved.id, appends: [] });
    if (!record || !matchesDescriptor(record, saved))
      throw new Error('A source attachment changed before snapshotting');
    documents.push(record);
  }
  const sourceSpace = {
    get: (key?: string) => (key ? descriptor[key as keyof BuildGuideInputDescriptor] : descriptor),
    getDocuments: async () => documents,
  };
  const sourceRead = await readDocumentsWithMetadata(app, sourceSpace);
  const documentsText = sourceRead.documentsText.slice(0, MAX_SOURCE_CHARS);
  for (const saved of descriptor.documents) {
    const record = await app.db.getRepository('attachments').findOne({ filterByTk: saved.id, appends: [] });
    if (!record || !matchesDescriptor(record, saved)) throw new Error('A source attachment changed while snapshotting');
  }
  return {
    title: descriptor.title,
    llmService: descriptor.llmService,
    model: descriptor.model,
    systemPrompt: descriptor.systemPrompt,
    outputFormat: descriptor.outputFormat,
    targetChapterCount: descriptor.targetChapterCount,
    chapterGuidance: descriptor.chapterGuidance,
    documentsText,
    sourceHash: crypto.createHash('sha256').update(documentsText).digest('hex'),
    sourceWarnings: sourceRead.sourceWarnings,
  };
}

function getSpaceModel(app: any) {
  return app.db.getModel('aiBuildGuideSpaces');
}

async function lockOwnedBuildRun(app: any, run: BuildRunContext, transaction: any) {
  const runRecord = await app.db.getCollection('aiBuildGuideRuns').model.findOne({
    where: { id: run.runId, engine: 'legacy', status: run.workerId ? 'running' : 'queued' },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const spaceRecord = await getSpaceModel(app).findOne({
    where: {
      id: run.spaceId,
      status: 'building',
      buildRunId: run.runId,
      ...(run.workerId ? { buildWorkerId: run.workerId } : {}),
    },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!runRecord || !spaceRecord) throw new StaleBuildRunError(run.spaceId, run.runId);
  return { runRecord, spaceRecord };
}

async function withOwnedBuildRun<T>(
  app: any,
  run: BuildRunContext,
  fn: (runRecord: any, spaceRecord: any, transaction: any) => Promise<T>,
) {
  return app.db.sequelize.transaction(async (transaction: any) => {
    const { runRecord, spaceRecord } = await lockOwnedBuildRun(app, run, transaction);
    return fn(runRecord, spaceRecord, transaction);
  });
}

async function updateSpaceForRun(app: any, run: BuildRunContext, values: Record<string, any>, optional = false) {
  let updated = false;
  try {
    updated = await app.db.sequelize.transaction(async (transaction: any) => {
      const { runRecord, spaceRecord } = await lockOwnedBuildRun(app, run, transaction);
      await spaceRecord.update(values, { transaction });
      const runValues: Record<string, unknown> = {};
      if (typeof values.buildPhase === 'string') runValues.stage = values.buildPhase;
      if (values.status === 'completed') {
        runValues.status = 'completed';
        runValues.stage = 'completed';
        runValues.finishedAt = new Date();
      } else if (values.status === 'error') {
        runValues.status = 'failed';
        runValues.stage = 'failed';
        runValues.errorCode = values.buildLog === 'SOURCE_NO_USABLE_TEXT' ? values.buildLog : 'BUILD_FAILED';
        runValues.finishedAt = new Date();
      }
      if (Object.keys(runValues).length) await runRecord.update(runValues, { transaction });
      return true;
    });
  } catch (error) {
    if (error instanceof StaleBuildRunError && optional) return false;
    throw error;
  }
  if (!updated && !optional) {
    throw new StaleBuildRunError(run.spaceId, run.runId);
  }
  return updated;
}

async function buildRunStateForError(error: unknown) {
  if (error instanceof BuildGuideSourceError) return error.code;
  return 'BUILD_FAILED';
}

/*
 * Keep the public terminal state and the private run row in one transaction.
 * A stale worker cannot publish an error after recovery has transferred ownership.
 */
export async function markBuildError(
  app: Application,
  spaceId: string,
  runId: string | undefined,
  error: unknown,
  workerId?: string,
) {
  const buildLog = await buildRunStateForError(error);
  app.log?.warn?.('[plugin-build-guide-block] Legacy build failed', {
    errorName: error instanceof Error ? error.name : 'Error',
  });
  const updated = await app.db.sequelize.transaction(async (transaction: any) => {
    const spaceModel = getSpaceModel(app);
    const pageModel = app.db.getCollection('aiBuildGuidePages').model;
    if (runId) {
      const run = await app.db.getCollection('aiBuildGuideRuns').model.findOne({
        where: { id: runId, engine: 'legacy', status: workerId ? 'running' : 'queued' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const space = await spaceModel.findOne({
        where: {
          id: spaceId,
          status: 'building',
          buildRunId: runId,
          ...(workerId ? { buildWorkerId: workerId } : {}),
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!run || !space) return false;
      await space.update(
        { status: 'error', buildPhase: 'error', buildLog, buildHeartbeatAt: new Date(), activeRunId: null },
        { transaction },
      );
      await run.update(
        { status: 'failed', stage: 'failed', errorCode: buildLog, finishedAt: new Date() },
        { transaction },
      );
      await pageModel.update(
        { status: 'error', buildLog },
        { where: { spaceId, runId, status: 'pending' }, transaction },
      );
      return true;
    }

    const space = await spaceModel.findOne({
      where: { id: spaceId, status: 'building' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!space) return false;
    await space.update({ status: 'error', buildPhase: 'error', buildLog, activeRunId: null }, { transaction });
    await pageModel.update({ status: 'error', buildLog }, { where: { spaceId, status: 'pending' }, transaction });
    return true;
  });
  if (!updated) return;
}

async function claimBuildRun(app: any, run: BuildRunContext, workerId: string) {
  const now = new Date();
  const SpaceModel = getSpaceModel(app);
  return app.db.sequelize.transaction(async (transaction: any) => {
    const runRecord = await app.db.getCollection('aiBuildGuideRuns').model.findOne({
      where: { id: run.runId, engine: 'legacy', status: 'queued' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!runRecord || String(runRecord.get('spaceId')) !== run.spaceId) return false;
    const spaceRecord = await SpaceModel.findOne({
      where: { id: run.spaceId, status: 'building', buildPhase: 'queued', buildRunId: run.runId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!spaceRecord) return false;
    await spaceRecord.update(
      { buildPhase: 'running', buildStartedAt: now, buildHeartbeatAt: now, buildWorkerId: workerId },
      { transaction },
    );
    await runRecord.update({ status: 'running', stage: 'reading', startedAt: now }, { transaction });
    return true;
  });
}

function getBuildWorkerId(app: any) {
  return [
    process.env.HOSTNAME || process.env.COMPUTERNAME || 'worker',
    app.name || 'app',
    app.instanceId || '0',
    process.pid,
  ].join(':');
}

function startBuildHeartbeat(app: any, run: BuildRunContext) {
  const timer = setInterval(() => {
    updateSpaceForRun(
      app,
      run,
      {
        buildHeartbeatAt: new Date(),
      },
      true,
    ).catch((error) => {
      app.log?.warn?.(`[plugin-build-guide-block] Failed to update heartbeat for build ${run.runId}`, error);
    });
  }, BUILD_HEARTBEAT_INTERVAL_MS);

  return () => clearInterval(timer);
}

export async function runBuild(app: any, db: any, run: BuildRunContext) {
  const spaceRepo = db.getRepository('aiBuildGuideSpaces') as Repository;
  const space = await spaceRepo.findById(run.spaceId);

  if (!space) {
    throw new Error('Space not found');
  }

  if (space.get('buildRunId') !== run.runId) {
    throw new StaleBuildRunError(run.spaceId, run.runId);
  }

  const inputArtifact = await db.getRepository('aiBuildGuideRunArtifacts').findOne({
    filter: { runId: run.runId, artifactKey: 'input' },
  });
  const savedSnapshot = inputArtifact?.get('payload');
  let snapshot: BuildGuideInputSnapshot | null =
    savedSnapshot &&
    typeof savedSnapshot === 'object' &&
    typeof (savedSnapshot as BuildGuideInputSnapshot).documentsText === 'string'
      ? (savedSnapshot as BuildGuideInputSnapshot)
      : null;
  if (!snapshot && savedSnapshot && typeof savedSnapshot === 'object') {
    snapshot = await materializeBuildGuideInputSnapshot(app, savedSnapshot as BuildGuideInputDescriptor);
    await withOwnedBuildRun(app, run, async (runRecord, spaceRecord, transaction) => {
      await spaceRecord.update({ buildPhase: 'reading', buildLog: 'Preparing source snapshot' }, { transaction });
      await runRecord.update({ stage: 'reading' }, { transaction });
      await inputArtifact.update({ payload: snapshot }, { transaction });
    });
  }
  const legacySpace = {
    get(key?: string) {
      return key ? space.get(key) : space.get();
    },
  };
  const currentSnapshot = snapshot;
  const guideSpace = currentSnapshot
    ? {
        get(key?: string) {
          return key ? currentSnapshot[key as keyof BuildGuideInputSnapshot] : currentSnapshot;
        },
      }
    : legacySpace;
  const { llmService, model } = snapshot || space.get();
  if (!llmService || !model) throw new Error('LLM configuration is missing');

  const sourceRead = snapshot
    ? { documentsText: snapshot.documentsText, sourceWarnings: snapshot.sourceWarnings || [] }
    : await readDocumentsWithMetadata(app, space);
  const documentsText = sourceRead.documentsText.slice(0, MAX_SOURCE_CHARS);
  const sourceHash = snapshot?.sourceHash ?? crypto.createHash('sha256').update(documentsText).digest('hex');
  await updateSpaceForRun(app, run, {
    buildPhase: 'reading',
    buildLog: sourceRead.sourceWarnings.length
      ? `SOURCE_PARTIAL_READ:${sourceRead.sourceWarnings.length}`
      : 'Reading source documents',
  });
  let provider: Awaited<ReturnType<typeof getLLMProvider>> | undefined;
  const getProvider = async () => {
    if (!provider) provider = await getLLMProvider(app, llmService, model);
    return provider;
  };

  await updateSpaceForRun(app, run, {
    buildPhase: 'planning',
    buildLog: 'Creating guide breakdown plan',
    sourceHash,
  });

  const previousPlan = await db.getRepository('aiBuildGuideRunArtifacts').findOne({
    filter: { runId: run.runId, artifactKey: 'legacy-plan' },
  });
  const previousPlanValue: unknown = previousPlan?.get('payload');
  const plan =
    previousPlanValue &&
    typeof previousPlanValue === 'object' &&
    Array.isArray((previousPlanValue as GuidePlan).chapters)
      ? (previousPlanValue as GuidePlan)
      : await buildPlan(await getProvider(), guideSpace, documentsText);
  if (!previousPlan) {
    await withOwnedBuildRun(app, run, async (_runRecord, _spaceRecord, transaction) => {
      await db
        .getCollection('aiBuildGuideRunArtifacts')
        .model.create(
          { id: crypto.randomUUID(), runId: run.runId, artifactKey: 'legacy-plan', payload: plan },
          { transaction },
        );
    });
  }
  const chapterKeys = plan.chapters.map((chapter, index) => {
    const slug = slugify(chapter.title, `chapter-${index + 1}`);
    return `${index + 1}:${slug}`;
  });
  const chapterArtifacts = await db.getRepository('aiBuildGuideRunArtifacts').find({
    filter: { runId: run.runId },
    appends: [],
  });
  const completedBefore = chapterArtifacts.filter((artifact: any) => {
    const key = artifact.get('artifactKey');
    const payload = artifact.get('payload');
    return (
      typeof key === 'string' &&
      chapterKeys.some((chapterKey) => key === `legacy-chapter:${chapterKey}`) &&
      payload?.status === 'completed'
    );
  }).length;
  await withOwnedBuildRun(app, run, async (runRecord, _spaceRecord, transaction) => {
    await runRecord.update({ expectedCount: plan.chapters.length, completedCount: completedBefore }, { transaction });
  });
  await updateSpaceForRun(app, run, {
    buildPhase: 'building_pages',
    buildLog: `Plan created with ${plan.chapters.length} chapters`,
  });
  for (const [index, chapter] of plan.chapters.entries()) {
    const chapterSlug = slugify(chapter.title, `chapter-${index + 1}`);
    const chapterKey = chapterKeys[index];
    const artifactKey = `legacy-chapter:${chapterKey}`;
    const saved = await db
      .getRepository('aiBuildGuideRunArtifacts')
      .findOne({ filter: { runId: run.runId, artifactKey } });
    const savedPayload: unknown = saved?.get('payload');
    if (
      savedPayload &&
      typeof savedPayload === 'object' &&
      (savedPayload as { status?: unknown }).status === 'completed'
    ) {
      continue;
    }
    await updateSpaceForRun(app, run, {
      buildPhase: 'building_pages',
      buildLog: `Building chapter ${index + 1}/${plan.chapters.length}`,
    });

    const markdown = await buildPageMarkdown(await getProvider(), guideSpace, plan, chapter, documentsText);
    const html = await markdownToCleanHtml(markdown);
    const { metadata, searchText } = createGuideSearchMetadata({
      chapter,
      guideTitle: plan.title || guideSpace.get('title'),
      markdown,
      slug: chapterSlug,
    });
    await app.db.sequelize.transaction(async (transaction: any) => {
      const activeRun = await db.getCollection('aiBuildGuideRuns').model.findOne({
        where: { id: run.runId, engine: 'legacy', status: 'running' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const activeSpace = await getSpaceModel(app).findOne({
        where: {
          id: run.spaceId,
          status: 'building',
          buildRunId: run.runId,
          ...(run.workerId ? { buildWorkerId: run.workerId } : {}),
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!activeRun || !activeSpace) throw new StaleBuildRunError(run.spaceId, run.runId);
      const artifact = await db.getRepository('aiBuildGuideRunArtifacts').findOne({
        filter: { runId: run.runId, artifactKey },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const payload = {
        status: 'completed',
        chapterKey,
        sort: index + 1,
        title: chapter.title,
        slug: chapterSlug,
        goal: chapter.goal,
        planItem: chapter,
        generatedMarkdown: markdown,
        generatedHtml: html,
        searchMetadata: metadata,
        searchText,
      };
      if (artifact) await artifact.update({ payload }, { transaction });
      else {
        await db
          .getCollection('aiBuildGuideRunArtifacts')
          .model.create({ id: crypto.randomUUID(), runId: run.runId, artifactKey, payload }, { transaction });
      }
      await activeRun.increment('completedCount', { by: 1, transaction });
    });
  }

  const privateChapterArtifacts = await db.getRepository('aiBuildGuideRunArtifacts').find({
    filter: { runId: run.runId },
    appends: [],
  });
  const privateChapters = chapterKeys.map((key) => {
    const artifact = privateChapterArtifacts.find((item: any) => item.get('artifactKey') === `legacy-chapter:${key}`);
    const payload: unknown = artifact?.get('payload');
    return payload && typeof payload === 'object' && (payload as { status?: unknown }).status === 'completed'
      ? (payload as Record<string, unknown>)
      : null;
  });
  if (privateChapters.some((chapter) => !chapter || typeof chapter.generatedMarkdown !== 'string')) {
    throw new Error('Guide chapter set is incomplete');
  }
  const combinedMarkdown = privateChapters
    .map((chapter) => chapter?.generatedMarkdown)
    .filter((markdown): markdown is string => typeof markdown === 'string')
    .join('\n\n---\n\n');
  const combinedHtml = await markdownToCleanHtml(combinedMarkdown);

  await db.sequelize.transaction(async (transaction: any) => {
    const activeRun = await db.getCollection('aiBuildGuideRuns').model.findOne({
      where: { id: run.runId, engine: 'legacy', status: 'running' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!activeRun) throw new StaleBuildRunError(run.spaceId, run.runId);
    const [affected] = await getSpaceModel(app).update(
      {
        status: 'completed',
        buildPhase: 'completed',
        buildLog: `Built ${privateChapters.length} chapters successfully`,
        generatedMarkdown: combinedMarkdown,
        generatedHtml: combinedHtml,
        planJson: plan,
        pageCount: privateChapters.length,
        published: true,
        publishedRunId: run.runId,
        latestRunId: run.runId,
        activeRunId: null,
        buildHeartbeatAt: new Date(),
      },
      {
        where: {
          id: run.spaceId,
          buildRunId: run.runId,
          activeRunId: run.runId,
          ...(run.workerId ? { buildWorkerId: run.workerId } : {}),
        },
        transaction,
      },
    );
    if (!affected) throw new StaleBuildRunError(run.spaceId, run.runId);
    const previousPages = await db.getCollection('aiBuildGuidePages').model.findAll({
      where: { spaceId: run.spaceId, [Op.or]: [{ runId: { [Op.ne]: run.runId } }, { runId: null }] },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const page of previousPages) await page.destroy({ transaction });
    for (const chapter of privateChapters) {
      await db.getCollection('aiBuildGuidePages').model.create(
        {
          spaceId: run.spaceId,
          sort: chapter?.sort,
          title: chapter?.title,
          slug: chapter?.slug,
          goal: chapter?.goal,
          planItem: chapter?.planItem,
          status: 'completed',
          runId: run.runId,
          published: true,
          generatedMarkdown: chapter?.generatedMarkdown,
          generatedHtml: chapter?.generatedHtml,
          searchMetadata: chapter?.searchMetadata,
          searchText: chapter?.searchText,
        },
        { transaction },
      );
    }
    const [runAffected] = await app.db.getCollection('aiBuildGuideRuns').model.update(
      {
        status: 'completed',
        stage: 'completed',
        expectedCount: privateChapters.length,
        completedCount: privateChapters.length,
        finishedAt: new Date(),
      },
      { where: { id: run.runId, status: 'running' }, transaction },
    );
    if (!runAffected) throw new StaleBuildRunError(run.spaceId, run.runId);
  });
}

function isBuildGuideWorker(app: Application) {
  return app.serving(WORKER_JOB_BUILD_GUIDE_PROCESS) || workerModeServesBuildGuide();
}

function workerModeServesBuildGuide() {
  const workerMode = process.env.WORKER_MODE || '';
  const workerModes = workerMode
    .split(',')
    .map((mode) => mode.trim())
    .filter(Boolean);

  return workerModes.some((mode) => {
    if (mode === '*' || mode === 'worker' || mode === 'task' || mode === WORKER_JOB_BUILD_GUIDE_PROCESS) {
      return true;
    }
    return BUILD_GUIDE_WORKER_ALIASES.some((alias) => mode === alias || mode.endsWith(`:${alias}`));
  });
}

function clearLocalBuildMemoryQueue(app: Application) {
  const eventQueue = (app as any).eventQueue;
  const adapter = eventQueue?.adapter;
  const fullChannel = eventQueue?.getFullChannel?.(BUILD_GUIDE_QUEUE_CHANNEL);
  const queue = fullChannel ? adapter?.queues?.get?.(fullChannel) : null;
  if (!queue?.length) return;

  adapter.queues.set(fullChannel, []);
  app.log?.warn?.(
    `[plugin-build-guide-block] Cleared ${queue.length} stale local memory message(s) on non-worker node; queued DB builds will be picked up by workers`,
  );
}

function getBuildQueueRedisKey(app: Application): string {
  const appName = (app as any).name || process.env.APP_NAME || 'main';
  return `${appName}:plugin-build-guide-block:build:queue`;
}

async function getBuildQueueRedis(app: Application): Promise<any | null> {
  const manager = (app as any).redisConnectionManager;
  if (!manager?.getConnectionSync) {
    return null;
  }

  try {
    const connectionString = process.env.QUEUE_ADAPTER_REDIS_URL || process.env.REDIS_URL;
    return await manager.getConnectionSync(
      BUILD_GUIDE_QUEUE_REDIS_CONNECTION,
      connectionString ? { connectionString } : undefined,
    );
  } catch (error: any) {
    app.log?.debug?.(
      `[plugin-build-guide-block] Redis queue unavailable; DB polling fallback active: ${error?.message || error}`,
    );
    return null;
  }
}

async function enqueueBuildToRedis(app: Application, message: BuildGuideQueueMessage): Promise<boolean> {
  const redis = await getBuildQueueRedis(app);
  if (!redis) return false;

  try {
    await redis.sendCommand(['RPUSH', getBuildQueueRedisKey(app), JSON.stringify(message)]);
    app.log?.debug?.(
      `[plugin-build-guide-block] Enqueued build ${message.runId} for space "${message.spaceId}" to Redis`,
    );
    return true;
  } catch (error: any) {
    app.log?.warn?.(`[plugin-build-guide-block] Failed to enqueue build to Redis; DB polling fallback active`, error);
    return false;
  }
}

async function publishBuildQueueWake(app: Application, message?: BuildGuideQueueMessage) {
  try {
    await (app as any).pubSubManager?.publish?.(
      BUILD_GUIDE_QUEUE_WAKE_CHANNEL,
      { spaceId: message?.spaceId, runId: message?.runId },
      { skipSelf: !isBuildGuideWorker(app) },
    );
  } catch (error: any) {
    app.log?.debug?.(`[plugin-build-guide-block] Wake publish skipped: ${error?.message || error}`);
  }
}

function startBuildGuideQueueProcessor(app: Application) {
  if (!isBuildGuideWorker(app)) {
    app.log?.debug?.('[plugin-build-guide-block] Build queue processor disabled on non-worker node');
    return;
  }
  if (buildQueueTimer) return;

  buildQueueWakeHandler = async () => {
    scheduleBuildQueueTick(app, 0);
  };

  const subscribe = (app as any).pubSubManager?.subscribe?.(BUILD_GUIDE_QUEUE_WAKE_CHANNEL, buildQueueWakeHandler);
  if (subscribe?.catch) {
    subscribe.catch((error: any) => {
      app.log?.debug?.(`[plugin-build-guide-block] Wake subscribe skipped: ${error?.message || error}`);
    });
  }

  buildQueueTimer = setInterval(() => scheduleBuildQueueTick(app, 0), BUILD_GUIDE_QUEUE_POLL_INTERVAL_MS);
  (buildQueueTimer as any).unref?.();
  scheduleBuildQueueTick(app, 1000);
  app.log?.info?.(
    `[plugin-build-guide-block] Build queue processor started (interval ${BUILD_GUIDE_QUEUE_POLL_INTERVAL_MS}ms)`,
  );
}

function stopBuildGuideQueueProcessor(app: Application) {
  if (buildQueueTimer) {
    clearInterval(buildQueueTimer);
    buildQueueTimer = null;
  }
  if (buildQueueKickTimer) {
    clearTimeout(buildQueueKickTimer);
    buildQueueKickTimer = null;
  }
  if (buildQueueWakeHandler) {
    const unsubscribe = (app as any).pubSubManager?.unsubscribe?.(
      BUILD_GUIDE_QUEUE_WAKE_CHANNEL,
      buildQueueWakeHandler,
    );
    if (unsubscribe?.catch) {
      unsubscribe.catch(() => undefined);
    }
    buildQueueWakeHandler = null;
  }
  buildQueueProcessing = false;
  buildQueueRunCursor = null;
}

function scheduleBuildQueueTick(app: Application, delayMs: number) {
  if (buildQueueKickTimer) return;
  buildQueueKickTimer = setTimeout(() => {
    buildQueueKickTimer = null;
    runBuildQueueTick(app).catch((error) => {
      app.log?.error?.('[plugin-build-guide-block] Build queue tick failed', error);
    });
  }, delayMs);
  (buildQueueKickTimer as any).unref?.();
}

async function runBuildQueueTick(app: Application) {
  if (buildQueueProcessing || !isBuildGuideWorker(app)) return;

  buildQueueProcessing = true;
  try {
    const redisMessages = await drainRedisBuildQueue(app, BUILD_GUIDE_QUEUE_CONCURRENCY);
    await processBuildQueueMessages(app, redisMessages);

    const remaining = Math.max(1, BUILD_GUIDE_QUEUE_CONCURRENCY - redisMessages.length);
    await processQueuedBuildsFromDb(app, remaining);
  } finally {
    buildQueueProcessing = false;
  }
}

function startBuildRecoveryProcessor(app: Application) {
  if (buildRecoveryTimer) return;
  buildRecoveryTimer = setInterval(() => {
    if (buildRecoveryProcessing) return;
    buildRecoveryProcessing = true;
    return recoverInterruptedBuilds(app)
      .catch((error) => {
        app.log?.warn?.('[plugin-build-guide-block] Periodic legacy build recovery failed', {
          errorName: error instanceof Error ? error.name : 'Error',
        });
      })
      .finally(() => {
        buildRecoveryProcessing = false;
      });
  }, BUILD_RECOVERY_INTERVAL_MS);
  buildRecoveryTimer.unref?.();
}

function stopBuildRecoveryProcessor() {
  if (buildRecoveryTimer) clearInterval(buildRecoveryTimer);
  buildRecoveryTimer = null;
  buildRecoveryProcessing = false;
}

async function drainRedisBuildQueue(app: Application, count: number): Promise<BuildGuideQueueMessage[]> {
  const redis = await getBuildQueueRedis(app);
  if (!redis) return [];

  const key = getBuildQueueRedisKey(app);
  const messages: BuildGuideQueueMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = await redis.sendCommand(['LPOP', key]);
    if (!raw) break;
    try {
      messages.push(JSON.parse(String(raw)));
    } catch (error: any) {
      app.log?.warn?.(`[plugin-build-guide-block] Dropped invalid Redis build message: ${error?.message || error}`);
    }
  }
  return messages;
}

function createBuildQueueMessageFromSpace(space: any): BuildGuideQueueMessage | null {
  const runId = space.get('buildRunId');
  if (!runId) return null;
  return {
    spaceId: String(space.get('id')),
    runId: String(runId),
    queuedAt: space.get('buildQueuedAt') ? new Date(space.get('buildQueuedAt')).toISOString() : undefined,
  };
}

export async function processQueuedBuildsFromDb(app: Application, count: number) {
  const RunModel = app.db.getCollection('aiBuildGuideRuns').model;
  const SpaceModel = getSpaceModel(app);
  const where: Record<PropertyKey, unknown> = { engine: 'legacy', status: 'queued' };
  if (buildQueueRunCursor) {
    where[Op.or] = [
      { createdAt: { [Op.gt]: buildQueueRunCursor.createdAt } },
      { createdAt: buildQueueRunCursor.createdAt, id: { [Op.gt]: buildQueueRunCursor.id } },
    ];
  }
  const runs = await RunModel.findAll({
    where,
    attributes: ['id', 'spaceId', 'createdAt'],
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: Math.max(10, count * 10),
  });
  if (!runs.length) {
    buildQueueRunCursor = null;
    return;
  }

  const messages: BuildGuideQueueMessage[] = [];
  for (const run of runs) {
    const runId = String(run.get('id'));
    const spaceId = String(run.get('spaceId'));
    buildQueueRunCursor = { createdAt: new Date(run.get('createdAt')), id: runId };
    const space = await SpaceModel.findOne({
      where: { id: spaceId, status: 'building', buildPhase: 'queued', buildRunId: runId },
      attributes: ['id'],
    });
    if (!space) continue;
    messages.push({ spaceId, runId });
    if (messages.length >= count) break;
  }
  await processBuildQueueMessages(app, messages);
}

async function processBuildQueueMessages(app: Application, messages: BuildGuideQueueMessage[]) {
  if (!messages.length) return;
  await Promise.all(messages.map((message) => processQueuedBuild(app, message)));
}

async function enqueueBuild(app: Application, message: BuildGuideQueueMessage) {
  try {
    const queuedInRedis = await enqueueBuildToRedis(app, message);
    if (queuedInRedis) {
      await publishBuildQueueWake(app, message);
      return;
    }

    await publishBuildQueueWake(app, message);

    if (isBuildGuideWorker(app)) {
      await app.eventQueue.publish(BUILD_GUIDE_QUEUE_CHANNEL, message, {
        timeout: BUILD_GUIDE_QUEUE_TIMEOUT_MS,
        maxRetries: 0,
      });
      return;
    }

    app.log?.warn?.(
      `[plugin-build-guide-block] Redis queue is unavailable; build ${message.runId} for space "${message.spaceId}" will remain queued until a worker DB poller picks it up`,
    );
  } catch (error) {
    await markBuildError(app, message.spaceId, message.runId, error);
    throw error;
  }
}

async function processQueuedBuild(app: Application, message: BuildGuideQueueMessage) {
  const spaceId = message?.spaceId;
  const runId = message?.runId;
  if (!spaceId || !runId) {
    app.log?.warn?.('[plugin-build-guide-block] Build queue message missing spaceId or runId');
    return;
  }

  const run = { spaceId, runId };
  const workerId = `${getBuildWorkerId(app)}:${crypto.randomUUID()}`;
  const claimed = await claimBuildRun(app, run, workerId);
  if (!claimed) {
    app.log?.info?.(`[plugin-build-guide-block] Build ${runId} for space "${spaceId}" was already claimed or stale`);
    return;
  }
  const claimedRun = { ...run, workerId };

  const spaceRepo = app.db.getRepository('aiBuildGuideSpaces') as Repository;
  const space = await spaceRepo.findById(spaceId);
  if (!space) {
    app.log?.warn?.(`[plugin-build-guide-block] Build space "${spaceId}" not found; skipping queued build`);
    return;
  }

  if (space.get('status') !== 'building') {
    app.log?.info?.(
      `[plugin-build-guide-block] Build space "${spaceId}" is ${space.get('status')}; skipping queued build`,
    );
    return;
  }

  const stopHeartbeat = startBuildHeartbeat(app, claimedRun);
  try {
    await runBuild(app, app.db, claimedRun);
  } catch (error) {
    if (error instanceof StaleBuildRunError) {
      app.log?.info?.(`[plugin-build-guide-block] ${error.message}`);
      return;
    }
    app.log?.error?.('Build Guide Worker Error', { errorName: error instanceof Error ? error.name : 'Error' });
    await markBuildError(app, spaceId, runId, error, workerId);
  } finally {
    stopHeartbeat();
  }
}

export function registerBuildGuideQueue(app: Application) {
  app.eventQueue.subscribe(BUILD_GUIDE_QUEUE_CHANNEL, {
    concurrency: BUILD_GUIDE_QUEUE_CONCURRENCY,
    idle: () => isBuildGuideWorker(app),
    process: async (message: BuildGuideQueueMessage) => {
      await processQueuedBuild(app, message);
    },
  });
  if (!isBuildGuideWorker(app)) {
    app.on('afterStart', () => clearLocalBuildMemoryQueue(app));
  }
  if (isBuildGuideWorker(app)) startBuildRecoveryProcessor(app);
  startBuildGuideQueueProcessor(app);
}

export function unregisterBuildGuideQueue(app: Application) {
  app.eventQueue.unsubscribe(BUILD_GUIDE_QUEUE_CHANNEL);
  stopBuildGuideQueueProcessor(app);
  stopBuildRecoveryProcessor();
}

async function withBuildTriggerLock<T>(app: Application, spaceId: string, fn: () => Promise<T>) {
  return app.lockManager.runExclusive(`build-guide:trigger:${spaceId}`, fn, BUILD_TRIGGER_LOCK_TTL_MS);
}

function fieldsAllow(fields: unknown, excluded: unknown, required: string[]) {
  const allowedFields = Array.isArray(fields) ? fields.map(String) : undefined;
  const excludedFields = Array.isArray(excluded) ? excluded.map(String) : [];
  return required.every(
    (field) => (!allowedFields || allowedFields.includes(field)) && !excludedFields.includes(field),
  );
}

async function getAuthorizedBuildSpace(ctx: Context, spaceId: string) {
  const dataSource = ctx.app.dataSourceManager.get('main');
  let access;
  let buildAccess;
  try {
    access = await dataSource.acl.resolveActionParams(ctx, {
      resourceName: 'aiBuildGuideSpaces',
      actionName: 'get',
      params: { filterByTk: spaceId },
    });
    buildAccess = await dataSource.acl.resolveActionParams(ctx, {
      resourceName: 'aiBuildGuideSpaces',
      actionName: 'build',
      params: { filterByTk: spaceId },
    });
  } catch (error) {
    if (error instanceof NoPermissionError)
      ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
    throw error;
  }
  if (!access.can || !buildAccess.can)
    ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
  const requiredSpaceFields = [
    'id',
    'title',
    'llmService',
    'model',
    'systemPrompt',
    'targetChapterCount',
    'chapterGuidance',
    'outputFormat',
    'documents',
  ];
  const getFieldsAllowed = fieldsAllow(access.parsedParams?.fields, access.parsedParams?.except, requiredSpaceFields);
  const buildFieldsAllowed = fieldsAllow(
    buildAccess.parsedParams?.fields,
    buildAccess.parsedParams?.except,
    requiredSpaceFields,
  );
  if (!getFieldsAllowed || !buildFieldsAllowed) {
    ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
  }
  const space = await ctx.db.getRepository('aiBuildGuideSpaces').findOne({
    ...access.mergedParams,
    filterByTk: spaceId,
    appends: [],
  });
  if (!space) ctx.throw(404, ctx.t('Space not found', { ns: 'plugin-build-guide-block' }));

  const documents = await space.getDocuments();
  const permittedDocuments: unknown[] = [];
  const requiredDocumentFields = ['id', 'updatedAt', 'filename', 'mimetype', 'extname', 'url', 'storageId'];
  for (const document of documents || []) {
    let documentAccess;
    try {
      documentAccess = await dataSource.acl.resolveActionParams(ctx, {
        resourceName: 'attachments',
        actionName: 'get',
        params: { filterByTk: document.id },
      });
    } catch (error) {
      if (error instanceof NoPermissionError)
        ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
      throw error;
    }
    if (!documentAccess.can) ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
    const allowedFields = documentAccess.parsedParams?.fields as string[] | undefined;
    const excludedFields = (documentAccess.parsedParams?.except || []) as string[];
    if (
      requiredDocumentFields.some(
        (field) => (allowedFields && !allowedFields.includes(field)) || excludedFields.includes(field),
      )
    ) {
      ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
    }
    const readable = await ctx.db.getRepository('attachments').findOne({
      ...documentAccess.mergedParams,
      filterByTk: document.id,
      appends: [],
    });
    if (!readable) ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
    permittedDocuments.push(readable);
  }
  return {
    get: (key?: string) => (key ? space.get(key) : space.get()),
    getDocuments: async () => permittedDocuments,
    buildFilter: buildAccess.mergedParams,
  };
}

export async function recoverInterruptedBuilds(app: Application) {
  const SpaceModel = getSpaceModel(app);
  const RunModel = app.db.getCollection('aiBuildGuideRuns').model;
  const PageModel = app.db.getCollection('aiBuildGuidePages').model;
  const staleBefore = new Date(Date.now() - BUILD_STALE_MS);
  const findStaleSpaces = (afterId: string | null) =>
    SpaceModel.findAll({
      where: {
        status: 'building',
        [Op.or]: [{ buildHeartbeatAt: null }, { buildHeartbeatAt: { [Op.lte]: staleBefore } }],
        ...(afterId ? { id: { [Op.gt]: afterId } } : {}),
      },
      order: [['id', 'ASC']],
      limit: BUILD_RECOVERY_BATCH_SIZE,
    });
  let candidates = await findStaleSpaces(buildRecoveryCursor);
  if (!candidates.length && buildRecoveryCursor) {
    buildRecoveryCursor = null;
    candidates = await findStaleSpaces(null);
  }
  buildRecoveryCursor = candidates.length ? String(candidates[candidates.length - 1].get('id')) : null;

  let recovered = 0;
  for (const candidate of candidates) {
    const spaceId = String(candidate.get('id'));
    const runId = String(candidate.get('buildRunId') || '');
    if (!runId) continue;
    const observedWorkerId = candidate.get('buildWorkerId') ?? null;
    let shouldEnqueue = false;

    await app.db.sequelize.transaction(async (transaction: any) => {
      const run = await RunModel.findOne({
        where: { id: runId, engine: 'legacy', status: { [Op.in]: ['queued', 'running'] } },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const space = await SpaceModel.findOne({
        where: {
          id: spaceId,
          status: 'building',
          buildRunId: runId,
          buildWorkerId: observedWorkerId,
          [Op.or]: [{ buildHeartbeatAt: null }, { buildHeartbeatAt: { [Op.lte]: staleBefore } }],
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!space) return;

      if (run?.get('status') === 'queued' && space.get('buildPhase') === 'queued') return;
      if (!run) {
        const existing = await RunModel.findOne({ where: { id: runId }, transaction, lock: transaction.LOCK.UPDATE });
        if (existing) return;
        await RunModel.create(
          {
            id: runId,
            spaceId,
            engine: 'legacy',
            status: 'queued',
            stage: 'queued',
            requesterId: '',
          },
          { transaction },
        );
      } else if (run.get('status') === 'running') {
        await run.update({ status: 'queued', stage: 'queued', startedAt: null }, { transaction });
      }

      await space.update(
        {
          buildPhase: 'queued',
          buildLog: 'Build re-queued after worker restart',
          activeRunId: runId,
          latestRunId: runId,
          buildQueuedAt: new Date(),
          buildStartedAt: null,
          buildHeartbeatAt: null,
          buildWorkerId: null,
        },
        { transaction },
      );
      await PageModel.update(
        { buildLog: 'Build re-queued after worker restart' },
        { where: { spaceId, runId, status: 'pending' }, transaction },
      );
      shouldEnqueue = true;
    });

    if (!shouldEnqueue) continue;
    await enqueueBuild(app, { spaceId, runId, queuedAt: new Date().toISOString() });
    recovered += 1;
  }

  if (recovered) app.log?.info?.(`[plugin-build-guide-block] Re-queued ${recovered} interrupted legacy build(s)`);
}

export async function build(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;
  if (!filterByTk) {
    ctx.throw(400, 'Space id is required');
  }

  const app = ctx.app as Application;
  const body = await withBuildTriggerLock(app, String(filterByTk), async () => {
    const runId = crypto.randomUUID();
    const space = await getAuthorizedBuildSpace(ctx, String(filterByTk));

    if (space.get('status') === 'building') {
      ctx.throw(409, 'A build is already in progress for this space');
    }
    let inputSnapshot: BuildGuideInputDescriptor;
    try {
      inputSnapshot = await createBuildGuideInputDescriptor(space);
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'Error';
      app.log?.warn?.('[plugin-build-guide-block] Could not snapshot guide inputs', { errorName });
      ctx.throw(400, ctx.t('Could not read the configured guide inputs', { ns: 'plugin-build-guide-block' }));
    }

    const engine = space.get('engine') === 'workflow' ? 'workflow' : 'legacy';
    let revision: { id: string | number; key: string } | null = null;
    if (engine === 'workflow') {
      const adapter = (app.pm.get('plugin-workflow-build-guide') || app.pm.get('workflow-build-guide')) as
        | { getActiveRevision?: () => Promise<{ id: string | number; key: string } | null> }
        | undefined;
      if (!adapter?.getActiveRevision) {
        ctx.throw(503, 'Workflow Build Guide adapter is unavailable');
        return;
      }
      revision = await adapter.getActiveRevision();
      if (!revision) {
        ctx.throw(503, 'Workflow Build Guide workflow is not configured');
        return;
      }
    }

    await app.db.sequelize.transaction(async (transaction: any) => {
      const locked = await app.db.getRepository('aiBuildGuideSpaces').findOne({
        ...space.buildFilter,
        filterByTk,
        transaction,
        lock: transaction.LOCK.UPDATE,
        appends: [],
      });
      if (!locked) ctx.throw(404, 'Space not found');
      if (locked.get('status') === 'building') ctx.throw(409, 'A build is already in progress for this space');
      const lockedEngine = locked.get('engine') === 'workflow' ? 'workflow' : 'legacy';
      if (lockedEngine !== engine) ctx.throw(409, 'Build settings changed; try again');

      await app.db.getRepository('aiBuildGuideRuns').create({
        values: {
          id: runId,
          spaceId: String(filterByTk),
          engine,
          requesterId: String((ctx as any).state?.currentUser?.id ?? ''),
          ...(revision ? { workflowKey: revision.key, workflowRevisionId: String(revision.id) } : {}),
          status: 'queued',
          stage: 'queued',
        },
        transaction,
      });
      await app.db
        .getCollection('aiBuildGuideRunArtifacts')
        .model.create(
          { id: crypto.randomUUID(), runId, artifactKey: 'input', payload: inputSnapshot },
          { transaction },
        );
      await locked.update(
        {
          status: 'building',
          buildPhase: 'queued',
          buildLog: 'Build queued',
          published:
            locked.get('published') === true ||
            locked.get('status') === 'completed' ||
            Boolean(locked.get('publishedRunId') || locked.get('generatedHtml') || locked.get('generatedMarkdown')),
          buildRunId: runId,
          activeRunId: runId,
          latestRunId: runId,
          buildQueuedAt: new Date(),
          buildStartedAt: null,
          buildHeartbeatAt: null,
          buildWorkerId: null,
        },
        { transaction },
      );
    });

    if (engine === 'legacy') {
      await enqueueBuild(app, {
        spaceId: String(filterByTk),
        runId,
        userId: (ctx as any).state?.currentUser?.id ?? null,
        queuedAt: new Date().toISOString(),
      });
    }

    return { status: 'building', runId };
  });

  ctx.body = body;
  await next();
}
