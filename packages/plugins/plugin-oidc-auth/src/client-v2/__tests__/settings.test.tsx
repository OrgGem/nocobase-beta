/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { Form, type FormInstance } from 'antd';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import OIDCAdminSettings from '../OIDCAdminSettings';

vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
afterEach(cleanup);

it('preserves advanced and future OIDC options through the host form save contract', async () => {
  const original = {
    oidc: {
      issuer: 'https://idp.example.com',
      clientId: 'client',
      clientSecret: 'test-secret',
      fieldMap: [{ source: 'department', target: 'department' }],
      idTokenSignedResponseAlg: 'ES256',
      http: true,
      port: 8443,
      requireVerifiedEmail: true,
      futureOption: { enabled: true },
    },
    public: { autoSignup: false, existingOption: 'preserve' },
  };
  let form: FormInstance<{ options: typeof original }>;
  function Harness() {
    [form] = Form.useForm();
    return (
      <Form form={form} initialValues={{ options: original }}>
        <OIDCAdminSettings />
      </Form>
    );
  }
  render(<Harness />);
  await act(async () => {
    form.setFieldValue(['options', 'oidc', 'issuer'], 'https://new-idp.example.com');
    const values = await form.validateFields();
    const saved = { ...original, ...values.options };
    expect(saved.oidc).toEqual({
      ...original.oidc,
      issuer: 'https://new-idp.example.com',
      tokenEndpointAuthMethod: 'client_secret_basic',
      scope: 'openid profile email',
      userBindField: 'email',
      bindExistingUserByEmail: true,
    });
    expect(saved.public).toEqual(original.public);
  });
});

it('requires a secret only for confidential clients and can switch authentication methods', async () => {
  let form: FormInstance;
  function Harness() {
    [form] = Form.useForm();
    return (
      <Form
        form={form}
        initialValues={{
          options: {
            oidc: {
              issuer: 'https://idp.example.com',
              clientId: 'public-client',
              tokenEndpointAuthMethod: 'none',
            },
          },
        }}
      >
        <OIDCAdminSettings />
      </Form>
    );
  }
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('Client Secret').closest('.ant-form-item-hidden')).not.toBeNull());
  await act(async () => {
    await expect(form.validateFields()).resolves.toMatchObject({
      options: { oidc: { tokenEndpointAuthMethod: 'none' } },
    });
  });
  for (const method of ['client_secret_basic', 'client_secret_post']) {
    await act(async () => form.setFieldValue(['options', 'oidc', 'tokenEndpointAuthMethod'], method));
    await act(async () => {
      await expect(form.validateFields()).rejects.toMatchObject({
        errorFields: [expect.objectContaining({ name: ['options', 'oidc', 'clientSecret'] })],
      });
    });
  }
  await act(async () => form.setFieldValue(['options', 'oidc', 'clientSecret'], 'test-secret'));
  await act(async () => {
    await expect(form.validateFields()).resolves.toBeDefined();
  });
});
