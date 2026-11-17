/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { theme as antdTheme } from 'antd';
import _ from 'lodash';
import type { StoredAlgorithm, StoredThemeConfig, ThemeConfig } from '../../types';

export function changeAlgorithmFromFunctionToString(
  themeConfig: ThemeConfig | null | undefined,
): StoredThemeConfig | null | undefined {
  if (!themeConfig) {
    return themeConfig;
  }
  const cloned: StoredThemeConfig = _.cloneDeep(themeConfig);

  if (!themeConfig.algorithm) {
    return cloned;
  }
  if (Array.isArray(themeConfig.algorithm)) {
    const encoded = themeConfig.algorithm
      .map((algorithm) => parseAlgorithm(algorithm))
      .filter((item): item is StoredAlgorithm => Boolean(item));
    if (encoded.length > 0) {
      cloned.algorithm = encoded;
    } else {
      delete cloned.algorithm;
    }
  } else {
    const encoded = parseAlgorithm(themeConfig.algorithm);
    if (encoded) {
      cloned.algorithm = encoded;
    } else {
      delete cloned.algorithm;
    }
  }
  return cloned;
}

function parseAlgorithm(algorithm: ThemeConfig['algorithm'] | StoredAlgorithm): StoredAlgorithm | undefined {
  if (typeof algorithm === 'string') {
    return algorithm === 'defaultAlgorithm' || algorithm === 'darkAlgorithm' || algorithm === 'compactAlgorithm'
      ? algorithm
      : undefined;
  }
  if (!algorithm) {
    return undefined;
  }
  if (algorithm === antdTheme.defaultAlgorithm || algorithm.toString() === antdTheme.defaultAlgorithm.toString()) {
    return 'defaultAlgorithm';
  }
  if (algorithm === antdTheme.darkAlgorithm || algorithm.toString() === antdTheme.darkAlgorithm.toString()) {
    return 'darkAlgorithm';
  }
  if (algorithm === antdTheme.compactAlgorithm || algorithm.toString() === antdTheme.compactAlgorithm.toString()) {
    return 'compactAlgorithm';
  }
  return undefined;
}
