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
import { act, cleanup, render } from '@testing-library/react';
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
