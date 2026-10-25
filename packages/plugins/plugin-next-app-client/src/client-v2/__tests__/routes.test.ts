/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { findLandingRoute, hubLink, permissionIds } from '../routes';
import { projectHubRoutes } from '../../server/projectRoutes';

describe('Hub routing and permissions', () => {
  it('keeps nested groups and links while intersecting page access with Desktop permissions', () => {
    const routes = projectHubRoutes(
      [
        {
          id: '10',
          type: 'group',
          children: [
            { id: '11', type: 'flowPage', schemaUid: 'allowed', title: 'Hub name' },
            { id: '12', type: 'flowPage', schemaUid: 'denied' },
            { id: '13', type: 'link', options: { url: 'https://example.com' } },
          ],
        },
      ],
      [
        {
          id: '100',
          type: 'flowPage',
          schemaUid: 'allowed',
          title: 'Desktop name',
          children: [{ id: '101', type: 'tabs' }],
        },
      ],
    );
    expect(routes[0].children).toEqual([
      expect.objectContaining({
        id: '100',
        nextAppRouteId: '11',
        title: 'Hub name',
        children: [{ id: '101', type: 'tabs' }],
      }),
      expect.objectContaining({ id: '13', type: 'link' }),
    ]);
  });
  it('never passes an unrecognized standalone page through the no-desktop-uid path', () => {
    expect(projectHubRoutes([{ id: '1', type: 'flowPage' }], [])).toEqual([]);
  });
  it('selects visible modern pages recursively, skipping legacy and hidden branches', () => {
    expect(
      findLandingRoute([
        { type: 'page', schemaUid: 'legacy' },
        { type: 'group', hideInMenu: true, children: [{ type: 'flowPage', schemaUid: 'hidden' }] },
        { type: 'group', children: [{ type: 'flowPage', schemaUid: 'modern' }] },
      ])?.schemaUid,
    ).toBe('modern');
  });
  it('keeps internal links under the active Hub and rejects executable URLs', () => {
    expect(hubLink('/admin/page/tab/tab1', 'sales')).toBe('/hub/sales/page/tab/tab1');
    expect(hubLink('page', 'sales')).toBe('/hub/sales/page');
    expect(hubLink('https://example.com', 'sales')).toBe('https://example.com');
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '//other.com', '/\\other.com'])
      expect(hubLink(url, 'sales')).toBeUndefined();
  });
  it('grants every ancestor and removes only empty ancestor branches without rounding IDs', () => {
    const routes = [
      {
        id: '90071992547409931',
        type: 'group',
        children: [
          {
            id: '90071992547409932',
            parentId: '90071992547409931',
            children: [
              { id: '90071992547409933', parentId: '90071992547409932' },
              { id: '90071992547409934', parentId: '90071992547409932' },
            ],
          },
        ],
      },
    ];
    const selected = permissionIds(routes, '90071992547409933', [], true);
    expect(new Set(selected)).toEqual(new Set(['90071992547409931', '90071992547409932', '90071992547409933']));
    const second = permissionIds(routes, '90071992547409934', selected, true);
    expect(permissionIds(routes, '90071992547409933', second, false)).toContain('90071992547409931');
    expect(permissionIds(routes, '90071992547409933', selected, false)).toEqual([]);
    expect(permissionIds(routes, '90071992547409931', second, false)).toEqual([]);
  });
});
