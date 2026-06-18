/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useGlobalTheme } from '@nocobase/client-v2';
import { App } from 'antd';
import React, { useMemo } from 'react';
import { createStyles } from '../theme-compat';
import InitializeTheme from './InitializeTheme';
import { ThemeEditorProvider } from './ThemeEditorProvider';
import ThemeList from './ThemeList';
import { ThemeListProvider } from './ThemeListProvider';
import CustomTheme from './theme-editor';

const useStyles = createStyles(({ css, token }) => {
  return {
    editor: css`
      overflow: hidden;
      border-left: 1px solid ${token.colorBorderSecondary};
      animation: 0.1s ease-out 0s 1 slideInFromRight;
      @keyframes slideInFromRight {
        0% {
          transform: translateX(100%);
        }
        100% {
          transform: translateX(0);
        }
      }
    `,
  };
});

const ThemeListPageContent: React.FC = () => {
  const [open, setOpen] = React.useState(false);
  const { setTheme } = useGlobalTheme();
  const { styles } = useStyles();

  const contentStyle = useMemo(() => {
    return open
      ? { transform: 'rotate(0)', flexGrow: 1, width: 0, height: '100%' }
      : { flexGrow: 1, width: 0, height: '100%' };
  }, [open]);

  return (
    <ThemeListProvider>
      <InitializeTheme>
        <ThemeEditorProvider open={open} setOpen={setOpen}>
          <div style={{ display: 'flex', overflow: 'hidden', height: '100%' }}>
            <div style={contentStyle}>
              <ThemeList />
            </div>
            {open ? (
              <div className={styles.editor}>
                <CustomTheme onThemeChange={setTheme} />
              </div>
            ) : null}
          </div>
        </ThemeEditorProvider>
      </InitializeTheme>
    </ThemeListProvider>
  );
};

const ThemeListPage: React.FC = () => {
  return (
    <App>
      <ThemeListPageContent />
    </App>
  );
};

ThemeListPage.displayName = 'ThemeListPage';

export default ThemeListPage;
