/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { EyeOutlined, SettingOutlined } from '@ant-design/icons';
import {
  PoweredBy,
  RemoteSchemaComponent,
  useRequest,
  useAPIClient,
  SchemaComponentOptions,
  FormDialog,
  SchemaComponent,
  useGlobalTheme,
  FormItem,
  Select,
  VariablesProvider,
  useApp,
  ApplicationContext,
  useCompile,
} from '@nocobase/client';
import {
  Breadcrumb,
  Button,
  Dropdown,
  Space,
  Spin,
  Switch,
  message,
  Popover,
  QRCode,
  theme as AntdTheme,
  Tag,
} from 'antd';
import React, { useState } from 'react';
import { useParams } from 'react-router';
import { Link } from 'react-router-dom';
import { FormLayout } from '@formily/antd-v5';
import { useSharedSubmitActionProps } from '../hooks';
import { useSharedFormTranslation, NAMESPACE } from '../locale';

const SharedFormQRCode = () => {
  const [open, setOpen] = useState(false);
  const { t } = useSharedFormTranslation();
  const params = useParams();
  const app = useApp();
  const baseURL = window.location.origin;
  const link = baseURL + app.getHref(`shared-forms/${params.name}`);
  const handleQRCodeOpen = (newOpen: boolean) => {
    setOpen(newOpen);
  };
  return (
    <Popover
      trigger={'hover'}
      open={open}
      onOpenChange={handleQRCodeOpen}
      content={open ? <QRCode value={link} bordered={false} /> : ' '}
    >
      <a>{t('QR code', { ns: NAMESPACE })}</a>
    </Popover>
  );
};

export function AdminSharedFormPage() {
  const params = useParams();
  const { t } = useSharedFormTranslation();
  const { theme } = useGlobalTheme();
  const apiClient = useAPIClient();
  const compile = useCompile();
  const { token } = AntdTheme.useToken();
  const app = useApp();

  const { data, loading, refresh } = useRequest<any>({
    url: `sharedForms:get/${params.name}`,
    params: {
      appends: ['allowedRoles'],
    },
  });

  const { data: rolesData } = useRequest<any>({
    url: 'roles:list',
    params: {
      paginate: false,
      filter: {
        'name.$ne': 'root',
      },
    },
  });

  const { enabled, title, ...others } = data?.data || {};
  const allowedRoles = (data?.data?.allowedRoles || []).map((r: any) => r.name);

  if (loading) {
    return <Spin />;
  }

  const handleEditSharedForm = async (values) => {
    await apiClient.resource('sharedForms').update({
      filterByTk: params.name,
      values: { ...values },
    });
    await refresh();
  };

  const rolesOptions = (rolesData?.data || []).map((role: any) => ({
    label: compile(role.title) || role.name,
    value: role.name,
  }));

  const handleSetRoles = async () => {
    const values = await FormDialog(
      t('Allowed roles') as any,
      () => {
        return (
          <ApplicationContext.Provider value={app}>
            <SchemaComponentOptions components={{ FormItem, Select }}>
              <FormLayout layout={'vertical'}>
                <SchemaComponent
                  schema={{
                    properties: {
                      allowedRoles: {
                        type: 'array',
                        title: t('Allowed roles'),
                        description: t('If empty, all logged in users and root can access', { ns: NAMESPACE }),
                        'x-decorator': 'FormItem',
                        'x-component': 'Select',
                        'x-component-props': {
                          mode: 'multiple',
                          options: '{{rolesOptions}}',
                        },
                      },
                    },
                  }}
                  scope={{ rolesOptions }}
                />
              </FormLayout>
            </SchemaComponentOptions>
          </ApplicationContext.Provider>
        );
      },
      theme,
    ).open({
      initialValues: { allowedRoles },
    });
    await handleEditSharedForm({ allowedRoles: values.allowedRoles.map((name) => ({ name })) });
  };

  const handleCopyLink = () => {
    const baseURL = window.location.origin;
    const link = baseURL + app.getHref(`shared-forms/${params.name}`);
    navigator.clipboard.writeText(link);
    message.success(t('Link copied successfully'));
  };

  return (
    <div style={{ marginTop: '-50px' }}>
      <div
        style={{
          margin: '-24px',
          padding: '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: `${token.colorBgContainer}`,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Breadcrumb
          style={{ marginLeft: '10px' }}
          items={[
            {
              title: <Link to={`/admin/settings/shared-forms`}>{t('Shared forms', { ns: NAMESPACE })}</Link>,
            },
            {
              title: compile(title),
            },
          ]}
        />
        <Space>
          {allowedRoles.length > 0 && (
            <Space size={4}>
              {allowedRoles.map((role) => (
                <Tag key={role} color="blue">
                  {role}
                </Tag>
              ))}
            </Space>
          )}
          <Link target={'_blank'} to={`/shared-forms/${params.name}`}>
            <Button disabled={!enabled} icon={<EyeOutlined />}>
              {t('Open form', { ns: NAMESPACE })}
            </Button>
          </Link>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'enabled',
                  label: (
                    <a
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                      onClick={() => handleEditSharedForm({ enabled: !enabled })}
                    >
                      <span style={{ marginRight: '10px' }}>{t('Enable form', { ns: NAMESPACE })}</span>
                      <Switch size={'small'} checked={enabled} />
                    </a>
                  ),
                },
                {
                  key: 'roles',
                  label: <a onClick={handleSetRoles}>{t('Set allowed roles')}</a>,
                },
                {
                  key: 'divider1',
                  type: 'divider',
                },
                {
                  key: 'copyLink',
                  label: <a onClick={handleCopyLink}>{t('Copy link')}</a>,
                },
                {
                  key: 'qrcode',
                  label: <SharedFormQRCode />,
                },
              ],
            }}
          >
            <Button icon={<SettingOutlined />}>{t('Settings')}</Button>
          </Dropdown>
        </Space>
      </div>
      <div
        style={{
          maxWidth: 800,
          margin: '100px auto',
          position: 'relative',
          zIndex: 0,
        }}
      >
        <VariablesProvider>
          <RemoteSchemaComponent
            uid={params.name}
            scope={{ useCreateActionProps: useSharedSubmitActionProps }}
            components={{ SharedFormMessageProvider: (props) => props.children }}
          />
        </VariablesProvider>
        <PoweredBy />
      </div>
    </div>
  );
}
