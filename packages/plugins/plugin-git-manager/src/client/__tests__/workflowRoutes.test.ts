/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { reviewApprovalHref, workflowHref } from '../workflowRoutes';

type RouteWindow = Window & {
  __nocobase_modern_client_prefix__?: string;
  __nocobase_public_path__?: string;
};

const routeWindow = window as RouteWindow;
const createApp = (publicPath: string, basename?: string) =>
  ({
    getPublicPath: () => publicPath,
    router: { getBasename: () => basename },
  }) as unknown as Parameters<typeof workflowHref>[0];

describe('Git review workflow route resolution', () => {
  let originalPath: string;
  let originalPublicPath: string | undefined;
  let originalModernPrefix: string | undefined;

  beforeEach(() => {
    originalPath = window.location.pathname;
    originalPublicPath = routeWindow.__nocobase_public_path__;
    originalModernPrefix = routeWindow.__nocobase_modern_client_prefix__;
  });

  afterEach(() => {
    window.history.replaceState({}, '', originalPath);
    if (originalPublicPath === undefined) delete routeWindow.__nocobase_public_path__;
    else routeWindow.__nocobase_public_path__ = originalPublicPath;
    if (originalModernPrefix === undefined) delete routeWindow.__nocobase_modern_client_prefix__;
    else routeWindow.__nocobase_modern_client_prefix__ = originalModernPrefix;
  });

  it('keeps workflow links in the legacy shell and sends approval tasks through the modern prefix', () => {
    routeWindow.__nocobase_modern_client_prefix__ = 'v3-custom';
    routeWindow.__nocobase_public_path__ = '/tenant/app/v3-custom/';
    window.history.replaceState({}, '', '/tenant/app/admin/settings/workflow');
    const app = createApp('/tenant/app/v3-custom/');

    expect(workflowHref(app, 'workflow', 'flow/42')).toBe('/tenant/app/admin/settings/workflow/workflows/flow%2F42');
    expect(workflowHref(app, 'execution', 73)).toBe('/tenant/app/admin/settings/workflow/executions/73');
    expect(reviewApprovalHref(app)).toBe('/tenant/app/v3-custom/admin/workflow/tasks/git-review-approval/pending');
  });

  it('uses the effective modern basename and custom modern prefix for v2 workflow links', () => {
    routeWindow.__nocobase_modern_client_prefix__ = 'ops-ui';
    routeWindow.__nocobase_public_path__ = '/org/portal/ops-ui/';
    window.history.replaceState({}, '', '/org/portal/ops-ui/admin/workflow');
    const app = createApp('/org/portal/ops-ui/', '/org/portal/ops-ui/');

    expect(workflowHref(app, 'workflow', 'review flow')).toBe(
      '/org/portal/ops-ui/admin/workflow/workflows/review%20flow',
    );
    expect(reviewApprovalHref(app)).toBe('/org/portal/ops-ui/admin/workflow/tasks/git-review-approval/pending');
  });
});
