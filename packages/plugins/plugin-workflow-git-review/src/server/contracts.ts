/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';

export type ID = string | number;
export type PostMode = 'auto' | 'manual' | 'disabled';
export type ReviewContext = {
  requestId: ID;
  reviewId: ID;
  repositoryId: ID;
  userId: ID;
  targetType: string;
  headSha: string;
  baseSha?: string;
  branch?: string;
  folderPath?: string;
  diff: string;
  coverage: { complete: boolean; limitations: string[] };
  instructions?: string;
  postMode: PostMode;
};

export interface ReviewService {
  claim(requestId: ID, executionId: ID): Promise<boolean>;
  prepareContext(requestId: ID, executionId: ID): Promise<ReviewContext>;
  saveResult(requestId: ID, executionId: ID, markdown: string): Promise<string>;
  markAISettled(requestId: ID, executionId: ID): Promise<void>;
  publish(
    requestId: ID,
    executionId: ID,
    approvedFingerprint: string,
  ): Promise<{ status: 'posted' | 'skipped' | 'in_progress' }>;
  onExecutionStatus(executionId: ID, status: number): Promise<void>;
  reconcile(): Promise<void>;
}

export function reviewService(app: Application): ReviewService {
  const plugin = (app.pm.get('plugin-git-manager') || app.pm.get('git-manager')) as unknown as
    | { reviewService?: ReviewService }
    | undefined;
  if (!plugin?.reviewService) {
    throw new Error('Git Manager review service is unavailable');
  }
  return plugin.reviewService;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
