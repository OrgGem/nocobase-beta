// SPDX-License-Identifier: Apache-2.0

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
