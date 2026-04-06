/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { SharedFormPermissions } from './SharedFormPermissions';

interface Props {
  TabLayout: React.FC<{ children?: React.ReactNode }>;
  activeRole: any;
}

export function SharedFormsPermissionTab({ TabLayout, activeRole }: Props) {
  return (
    <TabLayout>
      <SharedFormPermissions role={activeRole} />
    </TabLayout>
  );
}
