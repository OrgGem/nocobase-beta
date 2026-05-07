import { z } from 'zod';

export default {
  groupName: 'plugin-build-guide',
  tool: {
    name: 'search_build_guides',
    title: 'Search Build Guides',
    description: 'Search for available user guides, documentation, or read a specific guide page. Use this to help users find information in the build guide block.',
    execution: 'backend',
    schema: z.object({
      action: z.enum(['list_spaces', 'search_pages', 'read_page']).describe('The action to perform: list_spaces (find available guide books), search_pages (search for pages across all or specific spaces), read_page (read the full content of a specific page)'),
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
          const spaces = await spaceRepo.find({
            filter: query ? { title: { $iLike: `%${query}%` } } : {},
            fields: ['id', 'title', 'chapterGuidance', 'pageCount'],
            limit: 20,
          });
          return {
            status: 'success',
            content: spaces.map((s: any) => ({
              id: s.id,
              title: s.title,
              description: s.chapterGuidance,
              pageCount: s.pageCount,
            })),
          };
        }

        if (action === 'search_pages') {
          const pages = await pageRepo.find({
            filter: query
              ? {
                  $or: [
                    { title: { $iLike: `%${query}%` } },
                    { goal: { $iLike: `%${query}%` } },
                    { generatedMarkdown: { $iLike: `%${query}%` } },
                  ],
                }
              : {},
            fields: ['id', 'title', 'slug', 'goal', 'spaceId'],
            limit: 10,
            appends: ['space(id,title)'],
          });
          return {
            status: 'success',
            content: pages.map((p: any) => ({
              id: p.id,
              title: p.title,
              goal: p.goal,
              spaceName: p.space?.title,
            })),
          };
        }

        if (action === 'read_page') {
          if (!pageId) {
            return { status: 'error', content: 'pageId is required for read_page action' };
          }
          const page = await pageRepo.findById(pageId, {
            appends: ['space(id,title)'],
          });
          if (!page) {
            return { status: 'error', content: `Page with ID ${pageId} not found.` };
          }
          return {
            status: 'success',
            content: {
              id: page.id,
              title: page.title,
              spaceName: page.space?.title,
              goal: page.goal,
              markdown: page.generatedMarkdown,
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
