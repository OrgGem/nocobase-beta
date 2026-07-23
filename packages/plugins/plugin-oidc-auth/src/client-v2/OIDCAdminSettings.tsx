import { Checkbox, Form, Input, Select, Tabs } from 'antd';
import React from 'react';
import { useT } from './locale';

export default function OIDCAdminSettings() {
  const t = useT();
  return (
    <Tabs
      items={[
        {
          key: 'basic',
          label: t('Basic configuration'),
          forceRender: true,
          children: (
            <>
              <Form.Item name={['options', 'oidc', 'issuer']} label={t('Issuer')} rules={[{ required: true }]}>
                <Input placeholder="https://idp.example.com" />
              </Form.Item>
              <Form.Item name={['options', 'oidc', 'clientId']} label={t('Client ID')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item
                name={['options', 'oidc', 'clientSecret']}
                label={t('Client Secret')}
                rules={[{ required: true }]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Form.Item
                name={['options', 'oidc', 'tokenEndpointAuthMethod']}
                label={t('Token endpoint authentication')}
                initialValue="client_secret_basic"
              >
                <Select
                  options={['client_secret_basic', 'client_secret_post'].map((value) => ({ value, label: value }))}
                />
              </Form.Item>
              <Form.Item name={['options', 'oidc', 'scope']} label={t('scope')} initialValue="openid profile email">
                <Input />
              </Form.Item>
              <Form.Item
                name={['options', 'oidc', 'redirectUri']}
                label={t('Redirect URI')}
                extra={t('Leave blank to derive it from the current NocoBase URL.')}
              >
                <Input />
              </Form.Item>
            </>
          ),
        },
        {
          key: 'users',
          label: t('User provisioning'),
          forceRender: true,
          children: (
            <>
              <Form.Item
                name={['options', 'public', 'autoSignup']}
                label={t('Sign up automatically when the user does not exist')}
                valuePropName="checked"
                initialValue
              >
                <Checkbox />
              </Form.Item>
              <Form.Item
                name={['options', 'oidc', 'userBindField']}
                label={t('Use this field to bind the user')}
                initialValue="email"
              >
                <Select
                  options={[
                    { value: 'email', label: t('Email') },
                    { value: 'none', label: t('Do not bind existing users') },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name={['options', 'oidc', 'bindExistingUserByEmail']}
                label={t('Bind existing users by email')}
                valuePropName="checked"
                initialValue
              >
                <Checkbox />
              </Form.Item>
              <Form.Item
                name={['options', 'oidc', 'trustedEmailDomains']}
                label={t('Trusted email domains')}
                extra={t('Optional comma-separated domains, for example example.com, subsidiary.com')}
              >
                <Input />
              </Form.Item>
            </>
          ),
        },
        {
          key: 'advanced',
          label: t('Advanced configuration'),
          forceRender: true,
          children: (
            <>
              <Form.Item
                name={['options', 'oidc', 'autoLoginRedirect']}
                label={t('Automatic redirect to issuer login')}
                valuePropName="checked"
              >
                <Checkbox />
              </Form.Item>
              <Form.Item name={['options', 'oidc', 'logout']} label={t('RP-initiated logout')} valuePropName="checked">
                <Checkbox />
              </Form.Item>
              <Form.Item
                name={['options', 'oidc', 'postLogoutRedirectUri']}
                label={t('Post logout redirect URI')}
                extra={t('This URI must be registered at the identity provider.')}
              >
                <Input />
              </Form.Item>
            </>
          ),
        },
      ]}
    />
  );
}
