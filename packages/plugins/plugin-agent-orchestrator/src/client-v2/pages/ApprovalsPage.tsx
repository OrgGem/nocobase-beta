// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { ApprovalsTab } from '../components/ApprovalsTab';

const ApprovalsPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
    <ApprovalsTab />
  </div>
);

export default ApprovalsPage;
