/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { useApp } from '@nocobase/client-v2';
import OidcClientsPageView from './shared/OidcClientsPage';
import { useT } from './locale';

export default function OidcClientsPage() {
  return <OidcClientsPageView api={useApp().apiClient} t={useT()} />;
}
