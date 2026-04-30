import { Context, Next } from '@nocobase/actions';
import { Repository } from '@nocobase/database';
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

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'a', 'img', 'span', 'strong', 'em', 'code', 'pre', 'blockquote', 'br', 'hr',
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

function clampChapterCount(value: unknown) {
  const count = Number(value);
  if (!Number.isFinite(count)) return DEFAULT_TARGET_CHAPTERS;
  return Math.max(MIN_CHAPTERS, Math.min(MAX_CHAPTERS, Math.round(count)));
}

async function fetchFileContent(app: any, file: any): Promise<string> {
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
  const cleanText = stripFence(rawText);
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

async function buildPageMarkdown(provider: any, space: any, plan: GuidePlan, chapter: GuidePlanItem, documentsText: string) {
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
  return stripFence(toPlainText(response.content));
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

async function runBuild(app: any, db: any, filterByTk: string) {
  const spaceRepo = db.getRepository('aiBuildGuideSpaces') as Repository;
  const pageRepo = db.getRepository('aiBuildGuidePages') as Repository;
  const space = await spaceRepo.findById(filterByTk);

  if (!space) {
    throw new Error('Space not found');
  }

  const { llmService, model } = space.get();
  if (!llmService || !model) {
    throw new Error('LLM Service or model is missing in space configuration');
  }

  await pageRepo.destroy({
    filter: {
      spaceId: filterByTk,
    },
  });

  await spaceRepo.update({
    filterByTk,
    values: {
      buildPhase: 'reading',
      buildLog: 'Reading source documents',
      generatedHtml: null,
      generatedMarkdown: null,
      planJson: null,
      pageCount: 0,
    },
  });

  const documentsText = await readDocuments(app, space);
  const sourceHash = crypto.createHash('sha256').update(documentsText).digest('hex');
  const provider = await getLLMProvider(app, llmService, model);

  await spaceRepo.update({
    filterByTk,
    values: {
      buildPhase: 'planning',
      buildLog: 'Creating guide breakdown plan',
      sourceHash,
    },
  });

  const plan = await buildPlan(provider, space, documentsText);
  await spaceRepo.update({
    filterByTk,
    values: {
      planJson: plan,
      pageCount: plan.chapters.length,
      buildPhase: 'building_pages',
      buildLog: `Plan created with ${plan.chapters.length} chapters`,
    },
  });

  const pageRecords = [];
  for (const [index, chapter] of plan.chapters.entries()) {
    const page = await pageRepo.create({
      values: {
        spaceId: filterByTk,
        sort: index + 1,
        title: chapter.title,
        slug: slugify(chapter.title, `chapter-${index + 1}`),
        goal: chapter.goal,
        planItem: chapter,
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
    await spaceRepo.update({
      filterByTk,
      values: {
        buildPhase: 'building_pages',
        buildLog: `Building chapter ${index + 1}/${pageRecords.length}: ${chapter.title}`,
      },
    });

    try {
      const markdown = await buildPageMarkdown(provider, space, plan, chapter, documentsText);
      const html = await markdownToCleanHtml(markdown);
      await pageRepo.update({
        filterByTk: pageId,
        values: {
          status: 'completed',
          generatedMarkdown: markdown,
          generatedHtml: html,
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
      spaceId: filterByTk,
      status: 'completed',
    },
    sort: ['sort'],
  });
  const combinedMarkdown = completedPages
    .map((page: any) => page.get('generatedMarkdown'))
    .filter(Boolean)
    .join('\n\n---\n\n');
  const combinedHtml = await markdownToCleanHtml(combinedMarkdown);

  await spaceRepo.update({
    filterByTk,
    values: {
      status: 'completed',
      buildPhase: 'completed',
      buildLog: `Built ${completedPages.length} chapters successfully`,
      generatedMarkdown: combinedMarkdown,
      generatedHtml: combinedHtml,
    },
  });
}

export async function build(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;
  const repository = ctx.db.getRepository('aiBuildGuideSpaces') as Repository;

  const space = await repository.findById(filterByTk);

  if (!space) {
    ctx.throw(404, 'Space not found');
  }

  if (space.get('status') === 'building') {
    ctx.throw(409, 'A build is already in progress for this space');
  }

  const app = ctx.app;
  const db = ctx.db;

  try {
    await repository.update({
      filterByTk,
      values: {
        status: 'building',
        buildPhase: 'queued',
        buildLog: 'Build queued',
      },
    });

    runBuild(app, db, filterByTk).catch(async (error) => {
      app.log.error('Build Guide Background Error', error);
      try {
        await repository.update({
          filterByTk,
          values: {
            status: 'error',
            buildPhase: 'error',
            buildLog: error.message || String(error),
          },
        });
      } catch (updateErr) {
        app.log.error('Failed to persist build error status', updateErr);
      }
    });

    ctx.body = { status: 'building' };
  } catch (error: any) {
    app.log.error('Build Guide Error', error);
    await repository.update({
      filterByTk,
      values: {
        status: 'error',
        buildPhase: 'error',
        buildLog: error.message || String(error),
      },
    });
    ctx.throw(500, error.message || 'Error occurred during build');
  }

  await next();
}
