// SPDX-License-Identifier: Apache-2.0

import { LLMProviderOptions } from '@nocobase/plugin-ai/client';
import { ProviderSettingsForm } from './ProviderSettings';
import { ModelSettingsForm } from './ModelSettings';
import { formatModelLabel } from './formatModelLabel';

export const customLLMProviderOptions: LLMProviderOptions = {
  components: {
    ProviderSettingsForm,
    ModelSettingsForm,
  },
  formatModelLabel,
};
