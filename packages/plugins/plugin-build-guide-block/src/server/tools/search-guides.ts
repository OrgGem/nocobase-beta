import { z } from 'zod';

function getValue(record: any, key: string) {
  return record?.get?.(key) ?? record?.[key];
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
      pageId: z.string().optional().describe('The ID of the page to read. Required for read_page.'),
    }),
    invoke: async (args: { action: string; query?: string; pageId?: string }, ctx: any) => {
      const { action, query, pageId } = args;
      const { db } = ctx.app;

      const spaceRepo = db.getRepository('aiBuildGuideSpaces');
      const pageRepo = db.getRepository('aiBuildGuidePages');

      try {
        if (action === 'list_spaces') {
          const filter: any = { status: 'completed' };
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
            content: spaces.map((s: any) => ({
              id: getValue(s, 'id'),
              title: getValue(s, 'title'),
              description: getValue(s, 'chapterGuidance'),
              pageCount: getValue(s, 'pageCount'),
            })),
          };
        }

        if (action === 'search_pages') {
          const filter: any = { status: 'completed' };
          if (query) {
            filter.$or = [
              { title: { $iLike: `%${query}%` } },
              { goal: { $iLike: `%${query}%` } },
              { generatedMarkdown: { $iLike: `%${query}%` } },
            ];
          }
          const pages = await pageRepo.find({
            filter,
            fields: ['id', 'title', 'slug', 'goal', 'spaceId'],
            limit: 10,
            appends: ['space(id,title,status)'],
          });
          return {
            status: 'success',
            content: pages
              .filter((p: any) => getValue(getValue(p, 'space'), 'status') === 'completed')
              .map((p: any) => ({
                id: getValue(p, 'id'),
                title: getValue(p, 'title'),
                goal: getValue(p, 'goal'),
                spaceName: getValue(getValue(p, 'space'), 'title'),
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
              spaceName: getValue(getValue(page, 'space'), 'title'),
              goal: getValue(page, 'goal'),
              markdown: getValue(page, 'generatedMarkdown'),
            },
          };
        }

        return { status: 'error', content: 'Invalid action specified' };
      } catch (err: any) {
        ctx.app.logger.error(`[search_build_guides] Error: ${err.message}`, err);
        return { status: 'error', content: `Tool execution failed: ${err.message}` };
      }
    },
  },
};
