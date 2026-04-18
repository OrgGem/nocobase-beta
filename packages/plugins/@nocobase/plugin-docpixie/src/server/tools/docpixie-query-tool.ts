/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import { DocPixieService } from '../services/DocPixieService';

type ToolArgs = {
  query?: string;
  documentIds?: number[];
  strategy?: 'vision' | 'ocr_only' | 'hybrid';
};

export const DOCPIXIE_QUERY_TOOL_NAME = 'docpixie.query.document';

export function createDocPixieQueryTool(service: DocPixieService) {
  return {
    scope: 'CUSTOM' as const,
    execution: 'backend' as const,
    defaultPermission: 'ASK' as const,
    introduction: {
      title: 'DocPixie Document Expert',
      about: 'Phân tích tài liệu bằng adaptive RAG + vision trong phạm vi quyền hiện tại.',
    },
    definition: {
      name: DOCPIXIE_QUERY_TOOL_NAME,
      description: 'Trả lời câu hỏi dựa trên tài liệu DocPixie mà người dùng hiện tại được phép truy cập.',
      schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Câu hỏi của người dùng về tài liệu',
          },
          documentIds: {
            type: 'array',
            items: { type: 'number' },
            description: 'Danh sách ID tài liệu cần giới hạn truy vấn (tuỳ chọn)',
          },
          strategy: {
            type: 'string',
            enum: ['vision', 'ocr_only', 'hybrid'],
            description: 'Chiến lược phân tích tài liệu (tuỳ chọn)',
          },
        },
        required: ['query'],
      },
    },
    invoke: async (ctx: Context, args: ToolArgs) => {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return {
          status: 'error',
          content: 'Missing required field: query.',
        };
      }

      const roleNames = Array.isArray(ctx.state?.currentUser?.roles)
        ? ctx.state.currentUser.roles.map((role: any) => (typeof role === 'string' ? role : role?.name)).filter(Boolean)
        : [];

      try {
        const result = await service.queryByScope({
          userId: ctx.state?.currentUser?.id,
          roleNames,
          query,
          documentIds: Array.isArray(args?.documentIds) ? args.documentIds : undefined,
          strategy: args?.strategy,
        });

        // Tinh gọn kết quả để tránh làm quá tải context window của AI Employee
        const safeContent = {
          answer: result.answer,
          sources: result.sourcePages?.map(p => `Doc: ${p.documentName}, Page: ${p.pageNumber}`)
        };

        return {
          status: 'success',
          content: JSON.stringify(safeContent),
        };
      } catch (error: any) {
        ctx.log?.error?.(error, {
          module: 'docpixie',
          subModule: 'toolCalling',
          toolName: DOCPIXIE_QUERY_TOOL_NAME,
        });

        return {
          status: 'error',
          content: `DocPixie tool failed: ${error?.message || String(error)}`,
        };
      }
    },
  };
}
