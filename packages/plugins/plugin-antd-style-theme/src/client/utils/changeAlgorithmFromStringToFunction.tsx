/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { theme } from 'antd';
import _ from 'lodash';
import type { StoredThemeItem, ThemeConfig, ThemeItem } from '../../types';

const ALGORITHM_MAP = {
  defaultAlgorithm: theme.defaultAlgorithm,
  darkAlgorithm: theme.darkAlgorithm,
  compactAlgorithm: theme.compactAlgorithm,
};

function resolveAlgorithm(name: string): ThemeConfig['algorithm'] | undefined {
  return Object.prototype.hasOwnProperty.call(ALGORITHM_MAP, name)
    ? ALGORITHM_MAP[name as keyof typeof ALGORITHM_MAP]
    : undefined;
}

/**
 * 把算法函数由字符串转换为函数
 * 注: 之所以要保存为字符串, 是因为 JSON 无法保存函数
 */
export function changeAlgorithmFromStringToFunction(themeConfig: StoredThemeItem | ThemeItem): ThemeItem {
  const cloned = _.cloneDeep(themeConfig);
  const rawAlgorithm = cloned.config?.algorithm;
  if (!cloned.config || !rawAlgorithm) {
    return cloned as ThemeItem;
  }
  if (typeof rawAlgorithm === 'string') {
    cloned.config.algorithm = resolveAlgorithm(rawAlgorithm);
  } else if (Array.isArray(rawAlgorithm)) {
    const resolved = rawAlgorithm.flatMap((item) => {
      if (typeof item === 'string') {
        const fn = resolveAlgorithm(item);
        return fn ? [fn as NonNullable<ThemeConfig['algorithm']>] : [];
      }
      return [item];
    });
    (cloned.config as ThemeConfig).algorithm = resolved as ThemeConfig['algorithm'];
  }
  return cloned as ThemeItem;
}
