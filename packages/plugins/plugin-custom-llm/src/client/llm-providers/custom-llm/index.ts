// SPDX-License-Identifier: Apache-2.0

import { LLMProviderOptions } from '@nocobase/plugin-ai/client';
import { ModelSettingsForm, ProviderSettingsForm } from '../../../client-v2/settings';
import { formatModelLabel } from './formatModelLabel';

export const customLLMProviderOptions: LLMProviderOptions = {
  components: {
    ProviderSettingsForm,
    ModelSettingsForm,
  },
  formatModelLabel,
};
