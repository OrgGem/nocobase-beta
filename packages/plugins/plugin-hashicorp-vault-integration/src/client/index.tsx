import { Plugin, useAPIClient } from '@nocobase/client';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
// Shared `$vault` registration, defined once in client-v2 and imported back
// here via the allowed v1 -> v2 direction.
import { fetchExposedKeys, registerVaultProperty } from '../client-v2/registerVaultProperty';

const NAMESPACE = 'plugin-hashicorp-vault-integration';
const SETTINGS_KEY = 'hashicorp-vault';
const SETTINGS_ACL = 'pm.plugin-hashicorp-vault-integration';

export class PluginHashicorpVaultIntegrationClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      title: this.t('HashiCorp Vault'),
      icon: 'SafetyOutlined',
      aclSnippet: SETTINGS_ACL,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.connections`, {
      title: this.t('Connections'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('../client-v2/components/VaultConnections'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.mappings`, {
      title: this.t('Secret Mappings'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('../client-v2/components/VaultSecretMappings'),
    });

    this.app.registerVariable({
      name: '$vault',
      useOption() {
        const api = useAPIClient();
        const { t } = useTranslation(NAMESPACE);
        const [keys, setKeys] = useState<string[]>([]);
        const [loading, setLoading] = useState(true);

        useEffect(() => {
          fetchExposedKeys(api)
            .then((list) => {
              setKeys(list);
              setLoading(false);
            })
            .catch(() => setLoading(false));
        }, [api]);

        const option = useMemo(
          () => ({
            label: t('Vault secrets'),
            value: '$vault',
            children: keys.map((key) => ({ label: key, value: key })),
          }),
          [keys, t],
        );

        return useMemo(() => ({ option, visible: !loading && keys.length > 0 }), [option, loading, keys]);
      },
      useCtx() {
        const api = useAPIClient();
        return useMemo(() => {
          return async ({ variableName }: { variableName: string }) => {
            const key = variableName.replace('$vault.', '');
            const res = (await api.request({ url: 'vault:resolve', params: { variableKey: key } })) as {
              data?: { data?: { value?: string } };
            };
            return res?.data?.data?.value;
          };
        }, [api]);
      },
    });

    // Also expose `$vault` on the v1 flow-engine context so v2 UI rendered in
    // the v1 runtime (e.g. workflow config drawers) can resolve it.
    registerVaultProperty(this.app.flowEngine.context, this.app.apiClient, (key) => this.t(key));
  }
}

export default PluginHashicorpVaultIntegrationClient;
