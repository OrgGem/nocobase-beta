// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { LoopSettings } from '../skill-hub/components/LoopSettings';

const LoopSettingsPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
    <LoopSettings />
  </div>
);

export default LoopSettingsPage;
