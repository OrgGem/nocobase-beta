/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { css } from '@emotion/css';
import { useField } from '@formily/react';
import {
  ACLCustomContext,
  CollectionManager,
  DataSource,
  DataSourceApplicationProvider,
  DataSourceManager,
  GlobalThemeProvider,
  PoweredBy,
  SchemaComponent,
  SchemaComponentContext,
  useApp,
  useCompile,
  useRequest,
  VariablesProvider,
} from '@nocobase/client';
import { Spin } from 'antd';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useSharedSubmitActionProps } from '../hooks';
import { UnEnabledFormPlaceholder, UnFoundFormPlaceholder, AccessDeniedPlaceholder } from './UnEnabledFormPlaceholder';

class SharedDataSource extends DataSource {
  async getDataSource() {
    return {};
  }
}

function SharedFormDataProvider(props) {
  const { dataSource } = props;
  const app = useApp();
  const [dataSourceManager, collectionManager] = useMemo(() => {
    const dataSourceManager = new DataSourceManager({}, app);
    const dataSourceInstance = dataSourceManager.addDataSource(SharedDataSource, dataSource);
    const collectionManager = new CollectionManager([], dataSourceInstance);
    return [dataSourceManager, collectionManager];
  }, [app, dataSource]);
  return (
    <div>
      <DataSourceApplicationProvider
        dataSource={dataSource.key}
        dataSourceManager={dataSourceManager}
        instance={collectionManager}
      >
        {props.children}
      </DataSourceApplicationProvider>
    </div>
  );
}

function SharedFormAPIProvider({ children, formKey }) {
  const app = useApp();

  useEffect(() => {
    const interceptor = app.apiClient.axios.interceptors.request.use((config) => {
      if (config.headers) {
        config.headers['X-Shared-Form-Key'] = formKey || '';
      }
      return config;
    });

    return () => {
      app.apiClient.axios.interceptors.request.eject(interceptor);
    };
  }, [app.apiClient.axios.interceptors.request, formKey]);

  return <>{children}</>;
}

function useTitle(data) {
  const compile = useCompile();
  useEffect(() => {
    if (!data) return;
    document.title = compile(data?.data?.title);
  }, [data]);
}

export const SharedFormMessageContext = createContext<any>({});
export const PageBackgroundColor = '#f5f5f5';

const SharedFormMessageProvider = ({ children }) => {
  const [showMessage, setShowMessage] = useState(false);
  const field = useField();

  const toggleFieldVisibility = (fieldName, visible) => {
    field.form.query(fieldName).take((f) => {
      if (f) {
        f.visible = visible;
        f.hidden = !visible;
      }
    });
  };

  useEffect(() => {
    toggleFieldVisibility('success', showMessage);
    toggleFieldVisibility('form', !showMessage);
    if (!showMessage) {
      field.form.query('promptMessage').take((f) => {
        if (f) {
          f.visible = false;
          f.hidden = true;
        }
      });
    }
  }, [showMessage]);

  return (
    <SharedFormMessageContext.Provider value={{ showMessage, setShowMessage }}>
      {children}
    </SharedFormMessageContext.Provider>
  );
};

function InternalSharedForm() {
  const params = useParams();
  const app = useApp();
  const { error, data, loading } = useRequest<any>(
    {
      url: `sharedForms:getMeta/${params.name}`,
    },
    {
      onError(err) {
        // If 401, redirect to login with return URL
        if (err?.['response']?.status === 401) {
          const redirectPath = app.getHref(`shared-forms/${params.name}`);
          const signInPath = app.getHref('signin');
          window.location.href = `${signInPath}?redirect=${redirectPath}`;
        }
      },
    },
  );
  const ctx = useContext(SchemaComponentContext);

  useTitle(data);

  if (loading) {
    return <Spin />;
  }

  // 401 - redirect to login (handled in onError, show loading while redirecting)
  if (error?.['response']?.status === 401) {
    return <Spin />;
  }

  // 403 - access denied
  if (error?.['response']?.status === 403) {
    return <AccessDeniedPlaceholder />;
  }

  // 500 - form not found
  if (error?.['response']?.status === 500) {
    return <UnFoundFormPlaceholder />;
  }

  if (!data?.data) {
    return <UnEnabledFormPlaceholder />;
  }

  return (
    <ACLCustomContext.Provider value={{ allowAll: true }}>
      <SharedFormAPIProvider formKey={params.name}>
        <div
          style={{
            minHeight: '100vh',
            background: PageBackgroundColor,
            height: '100%',
            overflow: 'auto',
          }}
        >
          <div
            style={{
              maxWidth: 800,
              margin: '0 auto',
              position: 'relative',
              zIndex: 0,
            }}
            className={css`
              @media (min-width: 1025px) {
                padding-top: 10vh;
              }
              padding-top: 0px;
            `}
          >
            <SharedFormDataProvider dataSource={data?.data?.dataSource}>
              <SchemaComponentContext.Provider value={{ ...ctx, designable: false }}>
                <SchemaComponent
                  schema={data?.data?.schema}
                  scope={{
                    useCreateActionProps: useSharedSubmitActionProps,
                  }}
                  components={{ SharedFormMessageProvider: SharedFormMessageProvider }}
                />
              </SchemaComponentContext.Provider>
            </SharedFormDataProvider>
            <div style={{ marginBottom: '20px' }}>
              <PoweredBy />
            </div>
          </div>
        </div>
      </SharedFormAPIProvider>
    </ACLCustomContext.Provider>
  );
}

export function SharedFormPage() {
  const Provider = GlobalThemeProvider as any;
  return (
    <Provider
      theme={{
        token: {
          marginBlock: 18,
          borderRadiusBlock: 0,
          boxShadowTertiary: 'none',
          fontSize: 14,
        },
      }}
    >
      <VariablesProvider filterVariables={(v) => v.name !== '$nToken'}>
        <InternalSharedForm />
      </VariablesProvider>
    </Provider>
  );
}
