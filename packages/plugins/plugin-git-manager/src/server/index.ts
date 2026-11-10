/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export { default } from './plugin';
export { PluginGitManagerServer } from './plugin';
export { GitReviewService } from './services/review-service';
export type { ReviewAdmission } from './services/review-service';
export { hasRepositoryAccess } from './repository-access';
