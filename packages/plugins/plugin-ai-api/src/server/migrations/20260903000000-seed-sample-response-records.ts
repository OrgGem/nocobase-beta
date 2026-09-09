/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

const SAMPLE_IDS = ['resp_sample_welcome', 'resp_sample_followup'];

export default class SeedSampleResponseRecord extends Migration {
  on = 'afterSync' as const;

  async up() {
    const collection = this.db.getCollection('aiApiResponseRecords');
    if (!collection || !(await collection.existsInDb())) return;

    // Never seed demo content in production unless the operator opts in explicitly.
    if (process.env.NODE_ENV === 'production' && process.env.AI_API_SEED_SAMPLE_RESPONSES !== 'true') {
      this.app.logger.info(
        '[ai-api] Skipped sample response records in production (set AI_API_SEED_SAMPLE_RESPONSES=true to enable).',
      );
      return;
    }

    const rootUser = await this.db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    if (!rootUser) {
      this.app.logger.warn('[ai-api] Skipped sample response records because no root user exists.');
      return;
    }
    const repository = this.db.getRepository('aiApiResponseRecords');

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const firstOutput = {
      id: SAMPLE_IDS[0],
      object: 'response',
      created_at: now,
      completed_at: now,
      status: 'completed',
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model: 'sample/gpt-4',
      output: [
        {
          id: 'msg_sample_welcome',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Hello! Welcome to the NocoBase AI API. How can I help you today?',
              annotations: [],
            },
          ],
        },
      ],
      output_text: 'Hello! Welcome to the NocoBase AI API. How can I help you today?',
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: null,
      service_tier: 'default',
      temperature: null,
      text: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      truncation: 'disabled',
      usage: {
        input_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 35,
      },
      metadata: { sample: 'true', purpose: 'documentation' },
    };

    const firstValues = {
      responseId: SAMPLE_IDS[0],
      userId: rootUser.get('id'),
      model: firstOutput.model,
      input: 'Hello! I am testing the Responses API.',
      output: firstOutput,
      previousResponseId: null,
      metadata: firstOutput.metadata,
      expiresAt,
    };

    const secondOutput = {
      ...firstOutput,
      id: SAMPLE_IDS[1],
      created_at: now + 60,
      completed_at: now + 60,
      output: [
        {
          id: 'msg_sample_followup',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'I can help with questions, code, data analysis, and more.',
              annotations: [],
            },
          ],
        },
      ],
      output_text: 'I can help with questions, code, data analysis, and more.',
      previous_response_id: SAMPLE_IDS[0],
      usage: {
        input_tokens: 25,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 15,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 40,
      },
    };
    const secondValues = {
      responseId: SAMPLE_IDS[1],
      userId: rootUser.get('id'),
      model: secondOutput.model,
      input: 'What can you help me with?',
      output: secondOutput,
      previousResponseId: SAMPLE_IDS[0],
      metadata: secondOutput.metadata,
      expiresAt,
    };

    // Create each missing sample independently inside one transaction, so a rerun after a
    // partial failure still seeds the remaining record without duplicating the existing one.
    const candidates = [firstValues, secondValues];
    await this.db.sequelize.transaction(async (transaction) => {
      for (const values of candidates) {
        const exists = await repository.findOne({ filter: { responseId: values.responseId }, transaction });
        if (!exists) {
          await repository.create({ values, transaction });
        }
      }
    });
    this.app.logger.info('[ai-api] Seeded sample Responses API records for the root user.');
  }

  async down() {
    const repository = this.db.getRepository('aiApiResponseRecords');
    const records = await repository.find({ filter: { responseId: { $in: SAMPLE_IDS } } });
    for (const record of records) {
      const metadata = record.get('metadata');
      // Only remove records we actually seeded — a user-owned record may reuse a sample id.
      if (metadata && typeof metadata === 'object' && (metadata as Record<string, unknown>).sample === 'true') {
        await repository.destroy({ filterByTk: record.get('id') });
      }
    }
  }
}
