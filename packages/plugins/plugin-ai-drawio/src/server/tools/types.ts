import type { Context } from '@nocobase/actions';
import type { z } from 'zod';

export type DrawioToolResult = {
  status: 'success' | 'error';
  content: string;
};

export type DrawioToolDefinition = {
  groupName: 'drawio';
  tool: {
    name: string;
    title: string;
    description: string;
    execution: 'frontend' | 'backend';
    schema: z.ZodType;
    invoke: (ctx: Context, args: Record<string, unknown>) => Promise<DrawioToolResult>;
  };
};
