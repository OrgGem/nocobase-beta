/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useMemo } from 'react';
import { Icon, hasIcon, useSystemSettings } from '@nocobase/client';
import { AIChatResize } from '../shared/AIChatResize';
import { LeftNavResize } from '../shared/LeftNavResize';
import { SettingsSearchConfigContext, resolveSettingsSearchIcon } from '../shared/SettingsSearchInjector';
import { useT } from './locale';

export const HelpVisibilityProvider: React.FC<React.PropsWithChildren<{}>> = (props) => {
  const systemSettings = useSystemSettings();
  const t = useT();
  const options = systemSettings?.data?.data?.options;
  const showHelp = options?.showHelp !== false;
  const enableAIChatResize = options?.enableAIChatResize === true;
  const enableLeftNavResize = options?.enableLeftNavResize === true;
  const enableSettingsSearch = options?.enableSettingsSearch !== false;
  const searchIcon = resolveSettingsSearchIcon(options?.settingsSearchIcon);
  const searchConfig = useMemo(
    () => ({
      enabled: enableSettingsSearch,
      icon: searchIcon && hasIcon(searchIcon) ? <Icon type={searchIcon} /> : null,
    }),
    [enableSettingsSearch, searchIcon],
  );

  return (
    <SettingsSearchConfigContext.Provider value={searchConfig}>
      <AIChatResize enabled={enableAIChatResize} label={t('Resize AI chat')}>
        <LeftNavResize enabled={enableLeftNavResize} label={t('Resize left navigator')}>
          {!showHelp && (
            <style>{`
              div:has(> [data-testid="help-button"]) {
                display: none !important;
              }
            `}</style>
          )}
          {props.children}
        </LeftNavResize>
      </AIChatResize>
    </SettingsSearchConfigContext.Provider>
  );
};

export default HelpVisibilityProvider;
