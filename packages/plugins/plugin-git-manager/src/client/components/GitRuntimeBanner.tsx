// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Alert, Button, Progress, Space, message } from 'antd';
import { CloudDownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useGitManager } from '../context/GitManagerContext';
import { useT } from '../locale';
import { clusterPackageInstallerHref } from '../workflowRoutes';

export const GitRuntimeBanner: React.FC = () => {
  const t = useT();
  const app = useApp();
  const { gitRuntime, installingGit, installGitViaCluster, refreshRuntimeStatus } = useGitManager();

  if (!gitRuntime?.checked || gitRuntime.gitAvailable) {
    return null;
  }

  const { clusterManager } = gitRuntime;
  const isInstalling = clusterManager.status === 'running' || installingGit;

  const handleInstall = async () => {
    const ok = await installGitViaCluster();
    if (ok) {
      message.info(t('Git installation dispatched via Cluster Manager'));
    } else {
      message.error(t('Failed to start Git installation via Cluster Manager'));
    }
  };

  return (
    <div role="status" aria-live="polite" style={{ marginBottom: 16 }}>
      {isInstalling ? (
        <Alert
          type="info"
          showIcon
          message={t('Installing Git via Cluster Manager...')}
          description={
            <div>
              <div>
                {t(
                  'Local Git operations will unlock automatically as soon as Cluster Manager finishes installing git on this node.',
                )}
              </div>
              {clusterManager.progressPercent > 0 && (
                <Progress
                  percent={clusterManager.progressPercent}
                  size="small"
                  style={{ marginTop: 8, maxWidth: 360 }}
                />
              )}
            </div>
          }
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => refreshRuntimeStatus()}>
              {t('Refresh')}
            </Button>
          }
        />
      ) : (
        <Alert
          type="warning"
          showIcon
          message={t('Git CLI is not installed on this node yet')}
          description={
            clusterManager.available
              ? t(
                  'Git is managed separately via Cluster Manager. Install git now to enable File Explorer, Commit History, Operations, and Clone.',
                )
              : t('Install git in the app/worker container or set GIT_BINARY_PATH to use local repository features.')
          }
          action={
            clusterManager.available ? (
              <Space wrap>
                <Button
                  type="primary"
                  size="small"
                  icon={<CloudDownloadOutlined />}
                  loading={installingGit}
                  onClick={handleInstall}
                >
                  {t('Install Git via Cluster Manager')}
                </Button>
                <a href={clusterPackageInstallerHref(app)}>{t('Open Cluster Package Installer')}</a>
              </Space>
            ) : (
              <Button size="small" icon={<ReloadOutlined />} onClick={() => refreshRuntimeStatus()}>
                {t('Refresh')}
              </Button>
            )
          }
        />
      )}
    </div>
  );
};
