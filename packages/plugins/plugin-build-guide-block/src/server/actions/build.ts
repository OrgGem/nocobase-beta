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
const BUILD_RUN_LOCK_TTL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.BUILD_GUIDE_RUN_LOCK_TTL_MS || '', 10) || 24 * 60 * 60 * 1000,
);
const BUILD_HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  Number.parseInt(process.env.BUILD_GUIDE_HEARTBEAT_MS || '', 10) || 30_000,
);
const BUILD_STALE_MS = Math.max(
  BUILD_HEARTBEAT_INTERVAL_MS * 2,
  Number.parseInt(process.env.BUILD_GUIDE_STALE_MS || '', 10) || 120_000,
);

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

type GuidePlanItem = {
  title: string;
  goal?: string;
  sourceHints?: string[];
};

type GuidePlan = {
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
};

let buildQueueTimer: NodeJS.Timeout | null = null;
let buildQueueKickTimer: NodeJS.Timeout | null = null;
let buildQueueProcessing = false;
let buildQueueWakeHandler: ((message?: any) => Promise<void>) | null = null;

class StaleBuildRunError extends Error {
  constructor(spaceId: string, runId: string) {
    super(`Build run ${runId} for space ${spaceId} is no longer current`);
    this.name = 'StaleBuildRunError';
  }
}

function clampChapterCount(value: unknown) {
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

function unsupportedDocumentMessage(file: any) {
  const filename = file?.filename || file?.name || file?.id || 'document';
  const type = file?.mimetype || resolveExtname(file) || 'unknown type';
  return `[Unsupported document type: ${filename} (${type}). Enable and configure Document Parser to extract this file.]`;
}

async function fetchTextFileContent(app: any, file: any): Promise<string> {
  if (!isTextDocument(file)) {
    return unsupportedDocumentMessage(file);
  }

  const docParserPlugin = getDocumentParserPlugin(app);
  if (docParserPlugin?.fetchFileBuffer) {
    const { buffer } = await docParserPlugin.fetchFileBuffer(createParserContext(app), file);
    return buffer.toString('utf8');
  }

  const fileManager = app.pm.get('file-manager') as PluginFileManagerServer;
  if (!fileManager) return '';
  const url = await fileManager.getFileURL(file);

  try {
    if (url.startsWith('http')) {
      const response = await axios.get(url, { responseType: 'text', timeout: 15000 });
      return response.data;
    }

    let localPath = url;
    if (process.env.APP_PUBLIC_PATH && localPath.startsWith(process.env.APP_PUBLIC_PATH)) {
      localPath = localPath.slice(process.env.APP_PUBLIC_PATH.length);
    }
    localPath = path.join(process.cwd(), localPath);
    return await fs.promises.readFile(localPath, 'utf8');
  } catch (err) {
    app.log.error(`Failed to read file content for document ${file.id}`, err);
    return `[Failed to read document: ${file.filename}]`;
  }
}

async function parseWithDocumentParser(app: any, file: any): Promise<string> {
  const docParserPlugin = getDocumentParserPlugin(app);
  if (!docParserPlugin) return '';

  const parserCtx = createParserContext(app);
  const defaultParser = async () => ({
    placement: 'contentBlocks',
    content: {
      type: 'text',
      text: await fetchTextFileContent(app, file),
    },
  });

  try {
    if (docParserPlugin.parseRouter?.route) {
      const result = await docParserPlugin.parseRouter.route(parserCtx, file, defaultParser);
      const text = extractParsedText(result?.content);
      if (text && !text.startsWith('[Unsupported document type:')) {
        return text;
      }
    }

    if (docParserPlugin.internalParserRegistry?.parse) {
      const result = await docParserPlugin.internalParserRegistry.parse(file, parserCtx);
      if (result?.handled && result?.text?.trim()) {
        return result.text;
      }
    }
  } catch (err) {
    app.log?.warn?.(`[plugin-build-guide-block] Document parser failed for ${file?.filename || file?.id}`, err);
  }

  return '';
}

async function fetchFileContent(app: any, file: any): Promise<string> {
  const parsedText = await parseWithDocumentParser(app, file);
  if (parsedText) return parsedText;
  return fetchTextFileContent(app, file);
}

function toPlainText(value: unknown) {
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

function slugify(text: string, fallback: string) {
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

function createGuideSearchMetadata(params: {
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

function normalizePlan(rawText: string, guideTitle: string, targetChapterCount: number): GuidePlan {
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

async function getLLMProvider(app: any, llmService: string, model: string) {
  const aiPlugin = app.pm.get('ai') as PluginAIServer;
  if (!aiPlugin) {
    throw new Error('Plugin AI is not available');
  }
  const serviceData = await aiPlugin.aiManager.getLLMService({ llmService, model });
  return serviceData.provider;
}

async function buildPlan(provider: any, space: any, documentsText: string): Promise<GuidePlan> {
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

async function buildPageMarkdown(
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

async function markdownToCleanHtml(markdown: string) {
  const renderedHtml = await marked.parse(markdown, { async: true });
  return sanitizeHtml(renderedHtml, SANITIZE_OPTIONS);
}

async function readDocuments(app: any, space: any) {
  const documents = await space.getDocuments();
  if (!documents || documents.length === 0) {
    return '';
  }

  const texts = await Promise.all(
    documents.map(async (doc: any) => {
      const content = await fetchFileContent(app, doc);
      return `--- Document: ${doc.filename || doc.id} ---\n${content}\n`;
    }),
  );
  return texts.join('\n');
}

function getSpaceModel(app: any) {
  return app.db.getModel('aiBuildGuideSpaces');
}

async function updateSpaceForRun(app: any, run: BuildRunContext, values: Record<string, any>, optional = false) {
  const SpaceModel = getSpaceModel(app);
  const [affected] = await SpaceModel.update(values, {
    where: {
      id: run.spaceId,
      buildRunId: run.runId,
    },
  });
  if (!affected && !optional) {
    throw new StaleBuildRunError(run.spaceId, run.runId);
  }
  return affected > 0;
}

async function claimBuildRun(app: any, run: BuildRunContext, workerId: string) {
  const now = new Date();
  const SpaceModel = getSpaceModel(app);
  const [affected] = await SpaceModel.update(
    {
      buildPhase: 'running',
      buildStartedAt: now,
      buildHeartbeatAt: now,
      buildWorkerId: workerId,
    },
    {
      where: {
        id: run.spaceId,
        status: 'building',
        buildPhase: 'queued',
        buildRunId: run.runId,
      },
    },
  );
  return affected > 0;
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

async function runBuild(app: any, db: any, run: BuildRunContext) {
  const spaceRepo = db.getRepository('aiBuildGuideSpaces') as Repository;
  const pageRepo = db.getRepository('aiBuildGuidePages') as Repository;
  const space = await spaceRepo.findById(run.spaceId);

  if (!space) {
    throw new Error('Space not found');
  }

  if (space.get('buildRunId') !== run.runId) {
    throw new StaleBuildRunError(run.spaceId, run.runId);
  }

  const { llmService, model } = space.get();
  if (!llmService || !model) {
    throw new Error('LLM Service or model is missing in space configuration');
  }

  await pageRepo.destroy({
    filter: {
      spaceId: run.spaceId,
    },
  });

  await updateSpaceForRun(app, run, {
    buildPhase: 'reading',
    buildLog: 'Reading source documents',
    generatedHtml: null,
    generatedMarkdown: null,
    planJson: null,
    pageCount: 0,
  });

  const documentsText = await readDocuments(app, space);
  const sourceHash = crypto.createHash('sha256').update(documentsText).digest('hex');
  const provider = await getLLMProvider(app, llmService, model);

  await updateSpaceForRun(app, run, {
    buildPhase: 'planning',
    buildLog: 'Creating guide breakdown plan',
    sourceHash,
  });

  const plan = await buildPlan(provider, space, documentsText);
  await updateSpaceForRun(app, run, {
    planJson: plan,
    pageCount: plan.chapters.length,
    buildPhase: 'building_pages',
    buildLog: `Plan created with ${plan.chapters.length} chapters`,
  });

  const pageRecords = [];
  for (const [index, chapter] of plan.chapters.entries()) {
    const chapterSlug = slugify(chapter.title, `chapter-${index + 1}`);
    const { metadata, searchText } = createGuideSearchMetadata({
      chapter,
      guideTitle: plan.title || space.get('title'),
      slug: chapterSlug,
    });
    const page = await pageRepo.create({
      values: {
        spaceId: run.spaceId,
        sort: index + 1,
        title: chapter.title,
        slug: chapterSlug,
        goal: chapter.goal,
        planItem: chapter,
        searchMetadata: metadata,
        searchText,
        status: 'pending',
      },
    });
    pageRecords.push(page);
  }

  for (const [index, page] of pageRecords.entries()) {
    const chapter = plan.chapters[index];
    const pageId = page.get('id');
    await pageRepo.update({
      filterByTk: pageId,
      values: {
        status: 'building',
        buildLog: 'Building chapter with LLM',
      },
    });
    await updateSpaceForRun(app, run, {
      buildPhase: 'building_pages',
      buildLog: `Building chapter ${index + 1}/${pageRecords.length}: ${chapter.title}`,
    });

    try {
      const markdown = await buildPageMarkdown(provider, space, plan, chapter, documentsText);
      const html = await markdownToCleanHtml(markdown);
      const { metadata, searchText } = createGuideSearchMetadata({
        chapter,
        guideTitle: plan.title || space.get('title'),
        markdown,
        slug: page.get('slug'),
      });
      await pageRepo.update({
        filterByTk: pageId,
        values: {
          status: 'completed',
          generatedMarkdown: markdown,
          generatedHtml: html,
          searchMetadata: metadata,
          searchText,
          buildLog: null,
        },
      });
    } catch (error: any) {
      await pageRepo.update({
        filterByTk: pageId,
        values: {
          status: 'error',
          buildLog: error.message || String(error),
        },
      });
      throw error;
    }
  }

  const completedPages = await pageRepo.find({
    filter: {
      spaceId: run.spaceId,
      status: 'completed',
    },
    sort: ['sort'],
  });
  const combinedMarkdown = completedPages
    .map((page: any) => page.get('generatedMarkdown'))
    .filter(Boolean)
    .join('\n\n---\n\n');
  const combinedHtml = await markdownToCleanHtml(combinedMarkdown);

  await updateSpaceForRun(app, run, {
    status: 'completed',
    buildPhase: 'completed',
    buildLog: `Built ${completedPages.length} chapters successfully`,
    generatedMarkdown: combinedMarkdown,
    generatedHtml: combinedHtml,
    buildHeartbeatAt: new Date(),
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

async function processQueuedBuildsFromDb(app: Application, count: number) {
  const spaceRepo = app.db.getRepository('aiBuildGuideSpaces') as Repository;
  const spaces = await spaceRepo.find({
    filter: {
      status: 'building',
      buildPhase: 'queued',
    },
    sort: ['buildQueuedAt'],
    limit: count,
  });
  const messages = spaces.map(createBuildQueueMessageFromSpace).filter(Boolean) as BuildGuideQueueMessage[];
  await processBuildQueueMessages(app, messages);
}

async function processBuildQueueMessages(app: Application, messages: BuildGuideQueueMessage[]) {
  if (!messages.length) return;
  await Promise.all(messages.map((message) => processQueuedBuild(app, message)));
}

async function markBuildError(app: Application, spaceId: string, runId: string | undefined, error: any) {
  const buildLog = error?.message || String(error);
  let updated = false;
  if (runId) {
    updated = await updateSpaceForRun(
      app,
      { spaceId, runId },
      {
        status: 'error',
        buildPhase: 'error',
        buildLog,
        buildHeartbeatAt: new Date(),
      },
      true,
    );
  } else {
    await app.db.getRepository('aiBuildGuideSpaces').update({
      filterByTk: spaceId,
      values: {
        status: 'error',
        buildPhase: 'error',
        buildLog,
      },
    });
    updated = true;
  }

  if (!updated) {
    return;
  }

  await app.db.getRepository('aiBuildGuidePages').update({
    filter: {
      spaceId,
      status: 'building',
    },
    values: {
      status: 'error',
      buildLog,
    },
  });
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

  await withBuildRunLock(app, spaceId, async () => {
    const run = { spaceId, runId };
    const workerId = getBuildWorkerId(app);
    const claimed = await claimBuildRun(app, run, workerId);
    if (!claimed) {
      app.log?.info?.(`[plugin-build-guide-block] Build ${runId} for space "${spaceId}" was already claimed or stale`);
      return;
    }

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

    const stopHeartbeat = startBuildHeartbeat(app, run);
    try {
      await runBuild(app, app.db, run);
    } catch (error) {
      if (error instanceof StaleBuildRunError) {
        app.log?.info?.(`[plugin-build-guide-block] ${error.message}`);
        return;
      }
      app.log?.error?.('Build Guide Worker Error', error);
      await markBuildError(app, spaceId, runId, error);
    } finally {
      stopHeartbeat();
    }
  });
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
  startBuildGuideQueueProcessor(app);
}

export function unregisterBuildGuideQueue(app: Application) {
  app.eventQueue.unsubscribe(BUILD_GUIDE_QUEUE_CHANNEL);
  stopBuildGuideQueueProcessor(app);
}

async function withBuildTriggerLock<T>(app: Application, spaceId: string, fn: () => Promise<T>) {
  return app.lockManager.runExclusive(`build-guide:trigger:${spaceId}`, fn, BUILD_TRIGGER_LOCK_TTL_MS);
}

async function withBuildRunLock<T>(app: Application, spaceId: string, fn: () => Promise<T>) {
  return app.lockManager.runExclusive(`build-guide:run:${spaceId}`, fn, BUILD_RUN_LOCK_TTL_MS);
}

export async function recoverInterruptedBuilds(app: Application) {
  const spaceRepo = app.db.getRepository('aiBuildGuideSpaces') as Repository;
  const pageRepo = app.db.getRepository('aiBuildGuidePages') as Repository;
  const staleBefore = new Date(Date.now() - BUILD_STALE_MS);
  const spaces = await spaceRepo.find({
    filter: {
      status: 'building',
      $or: [{ buildHeartbeatAt: null }, { buildHeartbeatAt: { $lt: staleBefore } }],
    },
  });

  for (const space of spaces) {
    const spaceId = String(space.get('id'));
    const runId = String(space.get('buildRunId') || crypto.randomUUID());
    const SpaceModel = getSpaceModel(app);
    const [affected] = await SpaceModel.update(
      {
        buildPhase: 'queued',
        buildLog: 'Build re-queued after worker restart',
        buildRunId: runId,
        buildQueuedAt: new Date(),
        buildStartedAt: null,
        buildHeartbeatAt: null,
        buildWorkerId: null,
      },
      {
        where: {
          id: spaceId,
          status: 'building',
          buildRunId: space.get('buildRunId') || null,
        },
      },
    );

    if (!affected) {
      continue;
    }

    await pageRepo.update({
      filter: {
        spaceId,
        status: 'building',
      },
      values: {
        status: 'pending',
        buildLog: 'Build re-queued after worker restart',
      },
    });
    await enqueueBuild(app, {
      spaceId,
      runId,
      queuedAt: new Date().toISOString(),
    });
  }

  if (spaces.length) {
    app.log?.info?.(`[plugin-build-guide-block] Re-queued ${spaces.length} interrupted build(s)`);
  }
}

export async function build(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;
  if (!filterByTk) {
    ctx.throw(400, 'Space id is required');
  }

  const app = ctx.app as Application;
  const repository = ctx.db.getRepository('aiBuildGuideSpaces') as Repository;

  const body = await withBuildTriggerLock(app, String(filterByTk), async () => {
    const runId = crypto.randomUUID();
    const space = await repository.findById(filterByTk);

    if (!space) {
      ctx.throw(404, 'Space not found');
    }

    if (space.get('status') === 'building') {
      ctx.throw(409, 'A build is already in progress for this space');
    }

    await repository.update({
      filterByTk,
      values: {
        status: 'building',
        buildPhase: 'queued',
        buildLog: 'Build queued',
        buildRunId: runId,
        buildQueuedAt: new Date(),
        buildStartedAt: null,
        buildHeartbeatAt: null,
        buildWorkerId: null,
      },
    });

    await enqueueBuild(app, {
      spaceId: String(filterByTk),
      runId,
      userId: (ctx as any).state?.currentUser?.id ?? null,
      queuedAt: new Date().toISOString(),
    });

    return { status: 'building' };
  });

  ctx.body = body;
  await next();
}
