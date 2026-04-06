/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This program is offered under a commercial license.
 * For more information, see <https://www.nocobase.com/agreement>
 */

import { useFieldSchema } from '@formily/react';
import {
  ACLRolesCheckProvider,
  CurrentAppInfoProvider,
  CurrentPageUidContext,
  CurrentPageUidProvider,
  CurrentRouteProvider,
  CurrentTabUidProvider,
  IsSubPageClosedByPageMenuProvider,
  KeepAlive,
  LayoutContent,
  RemoteCollectionManagerProvider,
  RemoteSchemaComponent,
  RemoteSchemaTemplateManagerProvider,
  useCurrentPageUid,
  useCurrentUserContext,
} from '@nocobase/client';
import { App, Layout, Result } from 'antd';
import copy from 'copy-to-clipboard';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
// @ts-ignore
import pkg from './../../package.json';

export const EmbedAdminLayout = () => {
  return (
    // @ts-ignore
    <Layout style={{ height: '100%', '--nb-header-height': '0px' }}>
      <LayoutContent />
    </Layout>
  );
};

/**
 * Lightweight AdminProvider for embed mode.
 * Skips RoutesRequestProvider (fetches full desktop routes tree),
 * NavigateToDefaultPage, and LegacyRouteCompat which are unnecessary
 * for embedded single-page rendering.
 */
const EmbedAdminProvider = (props: { children: React.ReactNode }) => {
  return (
    <CurrentPageUidProvider>
      <CurrentTabUidProvider>
        <IsSubPageClosedByPageMenuProvider>
          <ACLRolesCheckProvider>
            <RemoteCollectionManagerProvider>
              <CurrentAppInfoProvider>
                <RemoteSchemaTemplateManagerProvider>{props.children}</RemoteSchemaTemplateManagerProvider>
              </CurrentAppInfoProvider>
            </RemoteCollectionManagerProvider>
          </ACLRolesCheckProvider>
        </IsSubPageClosedByPageMenuProvider>
      </CurrentTabUidProvider>
    </CurrentPageUidProvider>
  );
};

export const EmbedLayout = () => {
  const result = useCurrentUserContext();
  const noUser = result.loading === false && !result.data?.data?.id;
  if (noUser) {
    return <NotAuthorized />;
  }
  return (
    <EmbedAdminProvider>
      <EmbedAdminLayout />
    </EmbedAdminProvider>
  );
};

export function EmbedPage() {
  const currentPageUid = useCurrentPageUid();

  return (
    <KeepAlive uid={currentPageUid}>
      {(uid) => (
        <CurrentPageUidContext.Provider value={uid}>
          <CurrentRouteProvider uid={uid}>
            <RemoteSchemaComponent uid={uid} />
          </CurrentRouteProvider>
        </CurrentPageUidContext.Provider>
      )}
    </KeepAlive>
  );
}

export function NotAuthorized() {
  const { t } = useEmbedTranslation();
  return (
    <Result
      status="403"
      title="403"
      subTitle={t('Authorization expired or invalid. Please request a new embed link.')}
    />
  );
}

export function useEmbedTranslation() {
  return useTranslation(pkg.name, { nsMode: 'fallback' });
}

export function useBlockSettingProps() {
  const { name: pageUid } = useParams();
  const fieldSchema = useFieldSchema();
  const { message } = App.useApp();
  const { t } = useEmbedTranslation();
  return {
    title: t('Copy embedded link'),
    onClick: () => {
      const url = window.location.href
        .replace('/admin', '/embed')
        .replace(pageUid, fieldSchema['x-uid'])
        .replace(window.location.search || '', '');
      copy(url);
      message.success(t('Copy successful'));
    },
  };
}
