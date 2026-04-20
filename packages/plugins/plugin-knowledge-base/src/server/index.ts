/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

// @ts-ignore
import { name } from '../../package.json';
export { default } from './plugin';
export { PluginKnowledgeBaseServer } from './plugin';
export const namespace = name;

// Public extension API types — import these in dependent plugins
export type { RagSearchStrategy, RagSearchResult, RagSearchOptions } from './providers/external-rag';
export { EXTERNAL_RAG_KB_TYPE, EXTERNAL_HTTP_RAG_PROVIDER } from './providers/external-rag';
