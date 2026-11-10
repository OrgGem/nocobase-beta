/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  getModernClientPrefix,
  getRouteRuntimeVersion,
  getV2EffectiveBasePath,
  stripModernClientPrefix,
} from '@nocobase/client-v2';

type App = Parameters<typeof getV2EffectiveBasePath>[0];

function join(base: string, path: string) {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function legacyBase(app: App) {
  const configured = typeof window === 'undefined' ? undefined : window.__nocobase_public_path__;
  return stripModernClientPrefix(configured || app.getPublicPath());
}

export function workflowHref(app: App, type: 'workflow' | 'execution', id: string | number) {
  const modern = getRouteRuntimeVersion() === 'modern';
  const path = modern
    ? `/admin/workflow/${type === 'workflow' ? 'workflows' : 'executions'}/${encodeURIComponent(String(id))}`
    : `/admin/settings/workflow/${type === 'workflow' ? 'workflows' : 'executions'}/${encodeURIComponent(String(id))}`;
  return join(modern ? getV2EffectiveBasePath(app) : legacyBase(app), path);
}

export function reviewApprovalHref(app: App) {
  const base =
    getRouteRuntimeVersion() === 'modern'
      ? getV2EffectiveBasePath(app)
      : join(legacyBase(app), getModernClientPrefix());
  return join(base, '/admin/workflow/tasks/git-review-approval/pending');
}
