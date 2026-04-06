/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * DocPixie Config — Collection Definition (Singleton)
 *
 * Plugin configuration stored as a single row.
 * Uses NocoBase LLM service references instead of raw endpoint/apiKey.
 */
import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'docpixie_config',
  title: 'DocPixie Configuration',
  fields: [
    { type: 'bigInt', name: 'id', primaryKey: true, autoIncrement: true },
    /**
     * Reference to a row in `llmServices` collection (text model).
     * This is the name field of the llmService, e.g. "my-openai-service".
     */
    { type: 'string', name: 'llmServiceName', length: 100 },
    /**
     * Reference to a row in `llmServices` collection (vision model).
     * Can be the same as llmServiceName for a model that supports both.
     */
    { type: 'string', name: 'visionLlmServiceName', length: 100 },
    /** Analysis strategy: vision, ocr_only, hybrid */
    { type: 'string', name: 'analysisStrategy', length: 20, defaultValue: 'hybrid' },
    /** OCR provider: external_api or none */
    { type: 'string', name: 'ocrProvider', length: 20, defaultValue: 'none' },
    /** URL for external OCR API */
    { type: 'string', name: 'ocrApiEndpoint', length: 500 },
    /** API key for external OCR */
    { type: 'string', name: 'ocrApiKey', length: 500 },
    /** Max pages the LLM may analyze per task */
    { type: 'integer', name: 'maxPagesPerTask', defaultValue: 5 },
    /** Max tasks the adaptive planner may create per query */
    { type: 'integer', name: 'maxTasksPerPlan', defaultValue: 4 },
  ],
});
