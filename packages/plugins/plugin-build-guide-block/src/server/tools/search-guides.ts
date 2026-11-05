/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { z } from 'zod';
import type { Context } from '@nocobase/actions';
import { NoPermissionError } from '@nocobase/acl';

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

function createMetadataSearchConditions(query: string, operator: '$iLike' | '$like') {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = getSearchTokens(query);
  const conditions: Record<string, unknown>[] = [
    { title: { [operator]: `%${query}%` } },
    { goal: { [operator]: `%${query}%` } },
  ];

  if (normalizedQuery) {
    conditions.push({ searchText: { [operator]: `%${normalizedQuery}%` } });
  }
  for (const token of tokens) {
    conditions.push({ searchText: { [operator]: `%${token}%` } });
  }

  return conditions;
}

function createFallbackSearchConditions(query: string, operator: '$iLike' | '$like') {
  return [
    { title: { [operator]: `%${query}%` } },
    { goal: { [operator]: `%${query}%` } },
    { generatedMarkdown: { [operator]: `%${query}%` } },
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

async function readPermission(ctx: Context, resourceName: string, actionName: 'list' | 'get', fields: string[]) {
  const dataSource = ctx.app.dataSourceManager.get('main');
  const mainContext = Object.create(ctx);
  Object.defineProperties(mainContext, {
    dataSource: { value: dataSource },
    db: { value: ctx.app.db },
    database: { value: ctx.app.db },
  });
  const resolved = await dataSource.acl.resolveActionParams(mainContext, {
    resourceName,
    actionName,
    params: {},
  });
  const allowed: string[] | undefined = resolved.parsedParams?.fields;
  const except: string[] = resolved.parsedParams?.except || [];
  if (!resolved.can || fields.some((field) => (allowed && !allowed.includes(field)) || except.includes(field))) {
    throw new NoPermissionError('Guide access denied.');
  }
  return resolved.mergedParams;
}

function scopedFilter(scope: QueryFilter | undefined, filter: QueryFilter): QueryFilter {
  return scope ? { $and: [scope, filter] } : filter;
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
    invoke: async (ctx: Context, args: SearchBuildGuidesArgs) => {
      const { action, pageId, spaceId } = args;
      const query = normalizeQuery(args.query);
      const db = ctx.app.db;
      const operator = db.sequelize.getDialect() === 'postgres' ? '$iLike' : '$like';
      const spaceRepo = db.getRepository('aiBuildGuideSpaces');
      const pageRepo = db.getRepository('aiBuildGuidePages');
      const t = (key: string) => ctx.t(key, { ns: 'plugin-build-guide-block' });
      try {
        if (!ctx.state?.currentUser?.id && !ctx.auth?.user?.id) throw new NoPermissionError('Guide access denied.');
        if (action === 'list_spaces') {
          const fields = ['id', 'title', 'chapterGuidance', 'pageCount'];
          const permission = await readPermission(ctx, 'aiBuildGuideSpaces', 'list', fields);
          const filter: QueryFilter = { status: 'completed' };
          if (query) filter.title = { [operator]: `%${query}%` };
          const spaces = await spaceRepo.find({
            ...permission,
            filter: scopedFilter(permission.filter, filter),
            fields,
            appends: [],
            limit: 20,
          });
          return {
            status: 'success',
            content: spaces.map((space) => ({
              id: space.get('id'),
              title: space.get('title'),
              description: space.get('chapterGuidance'),
              pageCount: space.get('pageCount'),
            })),
          };
        }

        if (action === 'search_pages' || action === 'read_page') {
          const readAction = action === 'read_page' ? 'get' : 'list';
          const fields = [
            'id',
            'title',
            'slug',
            'goal',
            'spaceId',
            'generatedMarkdown',
            'searchMetadata',
            'searchText',
          ];
          const permission = await readPermission(ctx, 'aiBuildGuidePages', readAction, fields);
          const spacePermission = await readPermission(ctx, 'aiBuildGuideSpaces', readAction, ['id', 'title']);
          const filter: QueryFilter = { status: 'completed', ...(spaceId ? { spaceId } : {}) };
          if (action === 'read_page') {
            if (!pageId) return { status: 'error', content: t('Page ID is required.') };
            const page = await pageRepo.findOne({
              ...permission,
              filterByTk: pageId,
              filter: scopedFilter(permission.filter, filter),
              fields,
              appends: [],
            });
            const space =
              page?.get('spaceId') &&
              (await spaceRepo.findOne({
                ...spacePermission,
                filterByTk: page.get('spaceId'),
                filter: scopedFilter(spacePermission.filter, { status: 'completed' }),
                fields: ['id', 'title'],
                appends: [],
              }));
            if (!page || !space) return { status: 'error', content: t('User Guide not found') };
            return {
              status: 'success',
              content: {
                id: page.get('id'),
                title: page.get('title'),
                slug: page.get('slug'),
                spaceId: page.get('spaceId'),
                spaceName: space.get('title'),
                goal: page.get('goal'),
                metadata: page.get('searchMetadata'),
                markdown: page.get('generatedMarkdown'),
              },
            };
          }
          if (query) filter.$or = createMetadataSearchConditions(query, operator);
          let pages = await pageRepo.find({
            ...permission,
            filter: scopedFilter(permission.filter, filter),
            fields,
            appends: [],
            limit: 30,
          });
          if (query && pages.length === 0) {
            pages = await pageRepo.find({
              ...permission,
              filter: scopedFilter(permission.filter, {
                ...filter,
                $or: createFallbackSearchConditions(query, operator),
              }),
              fields,
              appends: [],
              limit: 30,
            });
          }
          const spaces = pages.length
            ? await spaceRepo.find({
                ...spacePermission,
                filter: scopedFilter(spacePermission.filter, {
                  status: 'completed',
                  id: { $in: pages.map((page) => page.get('spaceId')) },
                }),
                fields: ['id', 'title'],
                appends: [],
                pagination: false,
              })
            : [];
          const visibleSpaces = new Map(spaces.map((space) => [String(space.get('id')), space.get('title')]));
          return {
            status: 'success',
            content: pages
              .filter((page) => visibleSpaces.has(String(page.get('spaceId'))))
              .sort((a, b) => scorePage(b, query) - scorePage(a, query))
              .slice(0, 10)
              .map((page) => ({
                id: page.get('id'),
                title: page.get('title'),
                slug: page.get('slug'),
                goal: page.get('goal'),
                spaceId: page.get('spaceId'),
                spaceName: visibleSpaces.get(String(page.get('spaceId'))),
                matchedFields: getMatchedFields(page, query),
                metadata: page.get('searchMetadata'),
                snippet: createSnippet(page.get('generatedMarkdown'), query, page.get('searchMetadata')),
              })),
          };
        }
        return { status: 'error', content: t('Invalid guide action.') };
      } catch (error: unknown) {
        if (error instanceof NoPermissionError) return { status: 'error', content: t('Guide access denied.') };
        ctx.app.logger.error('[search_build_guides] Tool execution failed', error);
        return { status: 'error', content: t('Guide search failed.') };
      }
    },
  },
};
