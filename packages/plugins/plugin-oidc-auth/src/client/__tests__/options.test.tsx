/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createForm, type Field } from '@formily/core';
import { FormProvider } from '@formily/react';
import { Checkbox, FormItem, Input, Select } from '@formily/antd-v5';
import { SchemaComponentOptions } from '@nocobase/client';
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Options } from '../Options';

vi.mock('../locale', () => ({ useOidcTranslation: () => ({ t: (key: string) => key }), lang: (key: string) => key }));
vi.mock('@nocobase/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nocobase/client')>()),
  useApp: () => ({ getApiUrl: (path: string) => `https://app.example.test/api/${path}` }),
}));
afterEach(cleanup);

it('uses conditional secret validation in the legacy settings form', async () => {
  const form = createForm({
    initialValues: {
      oidc: {
        issuer: 'https://idp.example.com',
        clientId: 'public-client',
        tokenEndpointAuthMethod: 'none',
        providerProfile: 'nocobase',
      },
    },
  });
  render(
    <FormProvider form={form}>
      <SchemaComponentOptions components={{ Input, Select, Checkbox, FormItem }}>
        <Options />
      </SchemaComponentOptions>
    </FormProvider>,
  );
  await waitFor(() => expect(form.query('oidc.clientSecret').take()).toBeDefined());
  const secret = form.query('oidc.clientSecret').take() as Field;
  expect(form.values.oidc.providerProfile).toBe('nocobase');
  expect(secret.required).toBe(false);
  await act(async () => {
    await expect(form.validate()).resolves.toBeUndefined();
  });
  await act(async () => form.setValuesIn('oidc.tokenEndpointAuthMethod', 'client_secret_basic'));
  await waitFor(() => expect(secret.required).toBe(true));
  await act(async () => {
    await expect(form.validate()).rejects.toBeDefined();
  });
  await act(async () => form.setValuesIn('oidc.clientSecret', 'test-secret'));
  await act(async () => {
    await expect(form.validate()).resolves.toBeUndefined();
  });
});
