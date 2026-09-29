/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { MenuProps } from 'antd';
import type React from 'react';

export enum ModelRenderMode {
  ReactElement = 'reactElement',
  RenderFunction = 'renderFunction',
}

export type SortableModelLike = {
  sortIndex?: number | null;
};

export function getStableSortIndex(item: SortableModelLike, fallbackIndex: number) {
  return typeof item?.sortIndex === 'number' && Number.isFinite(item.sortIndex) ? item.sortIndex : fallbackIndex + 1;
}

export function sortByStableSortIndex<T extends SortableModelLike>(items: T[]) {
  return items
    .map((item, index) => ({
      item,
      index,
      sortIndex: getStableSortIndex(item, index),
    }))
    .sort((a, b) => a.sortIndex - b.sortIndex || a.index - b.index)
    .map(({ item }) => item);
}

type BaseMenuItem = NonNullable<MenuProps['items']>[number];
type MenuBaseItem = Omit<Exclude<BaseMenuItem, null>, 'key' | 'children'>;

export type FlowModelExtraMenuItem = MenuBaseItem & {
  key: React.Key;
  group?: string;
  sort?: number;
  label?: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  children?: FlowModelExtraMenuItem[];
};

export type FlowModelExtraMenuItemInput = Omit<FlowModelExtraMenuItem, 'key' | 'children'> & {
  key?: React.Key;
  children?: FlowModelExtraMenuItemInput[];
};

export type ExtraMenuItemEntry<TModel = any> = {
  group?: string;
  sort?: number;
  matcher?: (model: TModel) => boolean;
  keyPrefix?: string;
  items:
    | FlowModelExtraMenuItemInput[]
    | ((
        model: TModel,
        t: (k: string, opt?: any) => string,
      ) => FlowModelExtraMenuItemInput[] | Promise<FlowModelExtraMenuItemInput[]>);
};

export const sortExtraMenuItems = (items: FlowModelExtraMenuItem[]) => {
  return [...items].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
};

export const isFlowModelExtraMenuItem = (item: FlowModelExtraMenuItem | null): item is FlowModelExtraMenuItem => {
  return item !== null;
};

export const normalizeExtraMenuItem = (
  item: FlowModelExtraMenuItemInput,
  {
    group,
    sort,
    prefix,
    path,
  }: {
    group: string;
    sort: number;
    prefix: string;
    path: string;
  },
): FlowModelExtraMenuItem | null => {
  if (!item) {
    return null;
  }

  const normalizedGroup = item.group || group;
  const normalizedSort = typeof item.sort === 'number' ? item.sort : sort;
  const normalizedChildren = sortExtraMenuItems(
    (item.children || [])
      .map((child, index) =>
        normalizeExtraMenuItem(child, {
          group: normalizedGroup,
          sort: normalizedSort,
          prefix,
          path: path + '-' + index,
        }),
      )
      .filter(isFlowModelExtraMenuItem),
  );

  return {
    ...item,
    key: item.key ?? prefix + '-' + normalizedGroup + '-' + path,
    group: normalizedGroup,
    sort: normalizedSort,
    children: normalizedChildren.length ? normalizedChildren : undefined,
  };
};
