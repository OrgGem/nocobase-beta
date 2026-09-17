/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { buildRedirectPath } from '../buildRedirectPath';

describe('buildRedirectPath', () => {
  describe('main app', () => {
    it('falls back to /app when target is missing', () => {
      expect(buildRedirectPath({ appPublicPath: '/nocobase' })).toBe('/nocobase/app');
      expect(buildRedirectPath({ appPublicPath: '/nocobase', target: null })).toBe('/nocobase/app');
      expect(buildRedirectPath({ appPublicPath: '/nocobase', target: '' })).toBe('/nocobase/app');
    });

    it('normalizes legacy /admin segments to /app and prepends prefix', () => {
      expect(buildRedirectPath({ appPublicPath: '/nocobase', target: '/app/abc' })).toBe('/nocobase/app/abc');
      expect(buildRedirectPath({ appPublicPath: '/nocobase', target: '/app' })).toBe('/nocobase/app');
    });

    it('does NOT double-prepend when v2-style target already starts with appPublicPath', () => {
      expect(buildRedirectPath({ appPublicPath: '/nocobase', target: '/nocobase/v2/admin/abc' })).toBe(
        '/nocobase/v2/app/abc',
      );
      expect(buildRedirectPath({ appPublicPath: '/nocobase', target: '/nocobase/admin' })).toBe('/nocobase/app');
    });

    it('treats target equal to appPublicPath as already v2-shaped', () => {
      expect(buildRedirectPath({ appPublicPath: '/nocobase', target: '/nocobase' })).toBe('/nocobase');
    });

    it('only matches a prefix followed by `/` so siblings are not confused', () => {
      expect(buildRedirectPath({ appPublicPath: '/nocobase', target: '/nocobasenull' })).toBe('/nocobase/nocobasenull');
    });

    it('normalises trailing slashes on appPublicPath', () => {
      expect(buildRedirectPath({ appPublicPath: '/nocobase/', target: '/app/abc' })).toBe('/nocobase/app/abc');
      expect(buildRedirectPath({ appPublicPath: '/nocobase///', target: '/app/abc' })).toBe('/nocobase/app/abc');
      expect(buildRedirectPath({ appPublicPath: '/nocobase/', target: '/nocobase/v2/admin' })).toBe(
        '/nocobase/v2/app',
      );
    });

    it('handles an empty appPublicPath (root-mounted deployment)', () => {
      expect(buildRedirectPath({ appPublicPath: '', target: '/app' })).toBe('/app');
      expect(buildRedirectPath({ appPublicPath: undefined, target: '/app' })).toBe('/app');
      expect(buildRedirectPath({ appPublicPath: '', target: '/v2/admin/abc' })).toBe('/v2/app/abc');
    });

    it('keeps query strings and hashes intact', () => {
      expect(buildRedirectPath({ appPublicPath: '/nocobase', target: '/app/abc?tab=x#panel' })).toBe(
        '/nocobase/app/abc?tab=x#panel',
      );
      expect(buildRedirectPath({ appPublicPath: '/nocobase', target: '/nocobase/v2/admin?tab=x' })).toBe(
        '/nocobase/v2/app?tab=x',
      );
    });
  });

  describe('sub-app (v1 multi-app mode)', () => {
    it('prepends both appPublicPath and sub-app segment for v1-style target', () => {
      expect(buildRedirectPath({ appPublicPath: '/nocobase', subAppSegment: '/apps/sub', target: '/app/abc' })).toBe(
        '/nocobase/apps/sub/app/abc',
      );
    });

    it('falls back to /app under the full prefix when target is missing', () => {
      expect(buildRedirectPath({ appPublicPath: '/nocobase', subAppSegment: '/apps/sub' })).toBe(
        '/nocobase/apps/sub/app',
      );
    });

    it('does NOT touch a v2-style sub-app target that already starts with appPublicPath', () => {
      expect(
        buildRedirectPath({
          appPublicPath: '/nocobase',
          subAppSegment: '/apps/a_u4940c6p189',
          target: '/nocobase/v2/apps/a_u4940c6p189/admin/al5yj9t81of',
        }),
      ).toBe('/nocobase/v2/apps/a_u4940c6p189/app/al5yj9t81of');
    });

    it('does NOT prepend sub-app segment when target already contains it', () => {
      expect(buildRedirectPath({ appPublicPath: '', subAppSegment: '/apps/sub', target: '/v/apps/sub/admin' })).toBe(
        '/v/apps/sub/app',
      );
      expect(
        buildRedirectPath({ appPublicPath: '', subAppSegment: '/apps/sub', target: '/v/apps/sub/admin?tab=x#panel' }),
      ).toBe('/v/apps/sub/app?tab=x#panel');
    });

    it('does NOT treat query strings containing the sub-app segment as an existing sub-app path', () => {
      expect(
        buildRedirectPath({ appPublicPath: '', subAppSegment: '/apps/sub', target: '/app?next=/apps/sub/foo' }),
      ).toBe('/apps/sub/app?next=/apps/sub/foo');
    });

    it('does NOT touch a v2 main-app target even when a sub-app segment was supplied', () => {
      expect(
        buildRedirectPath({
          appPublicPath: '/nocobase',
          subAppSegment: '/apps/sub',
          target: '/nocobase/v2/admin/abc',
        }),
      ).toBe('/nocobase/v2/app/abc');
    });

    it('normalises trailing slash on sub-app segment', () => {
      expect(buildRedirectPath({ appPublicPath: '/nocobase', subAppSegment: '/apps/sub/', target: '/app/abc' })).toBe(
        '/nocobase/apps/sub/app/abc',
      );
    });
  });
});
