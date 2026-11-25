/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { useSystemSettings } from '@nocobase/client';
import { AIChatResize } from '../shared/AIChatResize';
import { useT } from './locale';

export const HelpVisibilityProvider: React.FC<React.PropsWithChildren<{}>> = (props) => {
  const systemSettings = useSystemSettings();
  const t = useT();
  const showHelp = systemSettings?.data?.data?.options?.showHelp !== false;
  const enableAIChatResize = systemSettings?.data?.data?.options?.enableAIChatResize === true;

  return (
    <AIChatResize enabled={enableAIChatResize} label={t('Resize AI chat')}>
      {!showHelp && (
        <style>{`
          div:has(> [data-testid="help-button"]) {
            display: none !important;
          }
        `}</style>
      )}
      {props.children}
    </AIChatResize>
  );
};

export default HelpVisibilityProvider;
