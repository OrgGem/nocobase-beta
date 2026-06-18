/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { theme, Popover } from 'antd';
import { createStyles } from 'antd-style';
import type { CustomToken } from '@nocobase/client-v2';

interface UseTokenResult extends ReturnType<typeof theme.useToken> {
  token: CustomToken;
}

export const useToken = () => {
  return theme.useToken() as UseTokenResult;
};

export { createStyles };
export const StablePopover = Popover;
