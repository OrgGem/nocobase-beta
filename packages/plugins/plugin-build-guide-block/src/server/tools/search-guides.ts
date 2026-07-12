import { z } from 'zod';

interface RecordReader {
  get?: (key: string) => unknown;
  [key: string]: unknown;
}

interface SearchBuildGuidesArgs {
  action: 'list_spaces' | 'search_pages' | 'read_page';
  query?: string;
  pageId?: string;
  spaceId?: string;
}

interface SearchBuildGuidesContext {
  app: {
    db: {
      getRepository: (name: string) => {
        find: (options: Record<string, unknown>) => Promise<RecordReader[]>;
        findById: (id: string, options?: Record<string, unknown>) => Promise<RecordReader | null>;
      };
    };
    logger: {
      error: (message: string, error?: unknown) => void;
    };
  };
}

type QueryFilter = Record<string, unknown>;

function getValue(record: unknown, key: string) {
  if (!record || typeof record !== 'object') {
    return undefined;
  }

  const reader = record as RecordReader;
  return reader.get?.(key) ?? reader[key];
}

function normalizeQuery(query?: string) {
  return query?.trim();
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

function getSearchTokens(query?: string) {
  const normalized = normalizeSearchText(query || '');
  if (!normalized) {
    return [];
  }

  return Array.from(new Set(normalized.split(' ').filter((token) => token.length >= 2))).slice(0, 8);
}

function createMetadataSearchConditions(query: string) {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = getSearchTokens(query);
  const conditions: Record<string, unknown>[] = [
    { title: { $iLike: `%${query}%` } },
    { goal: { $iLike: `%${query}%` } },
  ];

  if (normalizedQuery) {
    conditions.push({ searchText: { $iLike: `%${normalizedQuery}%` } });
  }
  for (const token of tokens) {
    conditions.push({ searchText: { $iLike: `%${token}%` } });
  }

  return conditions;
}

function createFallbackSearchConditions(query: string) {
  return [
    { title: { $iLike: `%${query}%` } },
    { goal: { $iLike: `%${query}%` } },
    { generatedMarkdown: { $iLike: `%${query}%` } },
  ];
}

function getMetadataValue(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  return (metadata as Record<string, unknown>)[key];
}

function createSnippet(markdown: unknown, query?: string, metadata?: unknown) {
  const summary = getMetadataValue(metadata, 'summary');
  const text =
    typeof markdown === 'string'
      ? markdown.replace(/\s+/g, ' ').trim()
      : typeof summary === 'string'
        ? summary.replace(/\s+/g, ' ').trim()
        : '';
  if (!text) {
    return undefined;
  }

  const keyword = normalizeSearchText(query || '');
  const searchableText = normalizeSearchText(text);
  const index = keyword ? searchableText.indexOf(keyword) : -1;
  const start = index > -1 ? Math.max(0, index - 120) : 0;
  return text.slice(start, start + 320);
}

function getArrayMetadata(metadata: unknown, key: string) {
  const value = getMetadataValue(metadata, key);
  return Array.isArray(value) ? value.map(String) : [];
}

function getMatchedFields(page: RecordReader, query?: string) {
  const tokens = getSearchTokens(query);
  if (!tokens.length) {
    return [];
  }

  const metadata = getValue(page, 'searchMetadata');
  const candidates = {
    title: normalizeSearchText(String(getValue(page, 'title') || '')),
    goal: normalizeSearchText(String(getValue(page, 'goal') || '')),
    headings: normalizeSearchText(getArrayMetadata(metadata, 'headings').join(' ')),
    keywords: normalizeSearchText(getArrayMetadata(metadata, 'keywords').join(' ')),
    sourceHints: normalizeSearchText(getArrayMetadata(metadata, 'sourceHints').join(' ')),
    summary: normalizeSearchText(String(getMetadataValue(metadata, 'summary') || '')),
    content: normalizeSearchText(String(getValue(page, 'generatedMarkdown') || '').slice(0, 4000)),
  };

  return Object.entries(candidates)
    .filter(([, value]) => tokens.some((token) => value.includes(token)))
    .map(([key]) => key);
}

function scorePage(page: RecordReader, query?: string) {
  const normalizedQuery = normalizeSearchText(query || '');
  const tokens = getSearchTokens(query);
  if (!normalizedQuery && !tokens.length) {
    return 0;
  }

  const metadata = getValue(page, 'searchMetadata');
  const title = normalizeSearchText(String(getValue(page, 'title') || ''));
  const goal = normalizeSearchText(String(getValue(page, 'goal') || ''));
  const searchText = String(getValue(page, 'searchText') || '');
  const headings = normalizeSearchText(getArrayMetadata(metadata, 'headings').join(' '));
  const keywords = normalizeSearchText(getArrayMetadata(metadata, 'keywords').join(' '));

  let score = 0;
  if (normalizedQuery && title.includes(normalizedQuery)) score += 100;
  if (normalizedQuery && headings.includes(normalizedQuery)) score += 80;
  if (normalizedQuery && keywords.includes(normalizedQuery)) score += 70;
  if (normalizedQuery && goal.includes(normalizedQuery)) score += 50;
  if (normalizedQuery && searchText.includes(normalizedQuery)) score += 40;

  for (const token of tokens) {
    if (title.includes(token)) score += 12;
    if (headings.includes(token)) score += 10;
    if (keywords.includes(token)) score += 8;
    if (goal.includes(token)) score += 6;
    if (searchText.includes(token)) score += 3;
  }

  return score;
}

export default {
  groupName: 'plugin-build-guide',
  tool: {
    name: 'search_build_guides',
    title: 'Search Build Guides',
    description:
      'Search for available user guides, documentation, or read a specific guide page. Use this to help users find information in the build guide block.',
    execution: 'backend',
    schema: z.object({
      action: z
        .enum(['list_spaces', 'search_pages', 'read_page'])
        .describe(
          'The action to perform: list_spaces (find available guide books), search_pages (search for pages across all or specific spaces), read_page (read the full content of a specific page)',
        ),
      query: z.string().optional().describe('Search keyword for finding spaces or pages. Required for search_pages.'),
      spaceId: z.string().optional().describe('Optional guide space ID to limit search_pages to one guide book.'),
      pageId: z.string().optional().describe('The ID of the page to read. Required for read_page.'),
    }),
    invoke: async (ctx: SearchBuildGuidesContext, args: SearchBuildGuidesArgs) => {
      const { action, pageId, spaceId } = args;
      const query = normalizeQuery(args.query);
      const { db } = ctx.app;

      const spaceRepo = db.getRepository('aiBuildGuideSpaces');
      const pageRepo = db.getRepository('aiBuildGuidePages');

      try {
        if (action === 'list_spaces') {
          const filter: QueryFilter = { status: 'completed' };
          if (query) {
            filter.title = { $iLike: `%${query}%` };
          }
          const spaces = await spaceRepo.find({
            filter,
            fields: ['id', 'title', 'chapterGuidance', 'pageCount'],
            limit: 20,
          });
          return {
            status: 'success',
            content: spaces.map((s) => ({
              id: getValue(s, 'id'),
              title: getValue(s, 'title'),
              description: getValue(s, 'chapterGuidance'),
              pageCount: getValue(s, 'pageCount'),
            })),
          };
        }

        if (action === 'search_pages') {
          const filter: QueryFilter = { status: 'completed' };
          if (spaceId) {
            filter.spaceId = spaceId;
          }
          if (query) {
            filter.$or = createMetadataSearchConditions(query);
          }
          let pages = await pageRepo.find({
            filter,
            fields: ['id', 'title', 'slug', 'goal', 'spaceId', 'generatedMarkdown', 'searchMetadata', 'searchText'],
            limit: 30,
            appends: ['space(id,title,status)'],
          });
          if (query && pages.length === 0) {
            const fallbackFilter: QueryFilter = { status: 'completed' };
            if (spaceId) {
              fallbackFilter.spaceId = spaceId;
            }
            fallbackFilter.$or = createFallbackSearchConditions(query);
            pages = await pageRepo.find({
              filter: fallbackFilter,
              fields: ['id', 'title', 'slug', 'goal', 'spaceId', 'generatedMarkdown', 'searchMetadata', 'searchText'],
              limit: 30,
              appends: ['space(id,title,status)'],
            });
          }
          return {
            status: 'success',
            content: pages
              .filter((p) => getValue(getValue(p, 'space'), 'status') === 'completed')
              .sort((a, b) => scorePage(b, query) - scorePage(a, query))
              .slice(0, 10)
              .map((p) => ({
                id: getValue(p, 'id'),
                title: getValue(p, 'title'),
                slug: getValue(p, 'slug'),
                goal: getValue(p, 'goal'),
                spaceId: getValue(p, 'spaceId'),
                spaceName: getValue(getValue(p, 'space'), 'title'),
                matchedFields: getMatchedFields(p, query),
                metadata: getValue(p, 'searchMetadata'),
                snippet: createSnippet(getValue(p, 'generatedMarkdown'), query, getValue(p, 'searchMetadata')),
              })),
          };
        }

        if (action === 'read_page') {
          if (!pageId) {
            return { status: 'error', content: 'pageId is required for read_page action' };
          }
          const page = await pageRepo.findById(pageId, {
            appends: ['space(id,title,status)'],
          });
          if (!page) {
            return { status: 'error', content: `Page with ID ${pageId} not found.` };
          }
          if (getValue(page, 'status') !== 'completed' || getValue(getValue(page, 'space'), 'status') !== 'completed') {
            return { status: 'error', content: `Page with ID ${pageId} is not completed.` };
          }
          return {
            status: 'success',
            content: {
              id: getValue(page, 'id'),
              title: getValue(page, 'title'),
              slug: getValue(page, 'slug'),
              spaceId: getValue(page, 'spaceId'),
              spaceName: getValue(getValue(page, 'space'), 'title'),
              goal: getValue(page, 'goal'),
              metadata: getValue(page, 'searchMetadata'),
              markdown: getValue(page, 'generatedMarkdown'),
            },
          };
        }

        return { status: 'error', content: 'Invalid action specified' };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.app.logger.error(`[search_build_guides] Error: ${message}`, err);
        return { status: 'error', content: `Tool execution failed: ${message}` };
      }
    },
  },
};
