// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { HarnessProfilesTab } from '../components/HarnessProfilesTab';

const HarnessProfilesPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
    <HarnessProfilesTab />
  </div>
);

export default HarnessProfilesPage;
