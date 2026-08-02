import React from 'react';
import { Alert, Card, Descriptions, Divider, Space, Typography } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { DockerCommand } from '../components/DockerCommand';
import { registryApi } from '../api';
import { useT } from '../locale';
import { type DockerRegistryPageProps, useDockerRegistryPermissions } from '../permissions';
import { externalImageReference } from '../registry-access';

export default function RegistryGuidePage({ permissions }: DockerRegistryPageProps) {
  const ctx = useFlowContext();
  const t = useT();
  const aclPermissions = useDockerRegistryPermissions();
  const { canRead } = permissions ?? aclPermissions;
  const { data: settings, loading } = useRequest(() => registryApi.getPublicSettings(ctx), { ready: canRead });
  const host = settings?.publicRegistryHost?.trim();
  const image = externalImageReference(host, 'team/my-app', 'latest');

  if (!canRead) {
    return <Alert type="error" showIcon message={t('You do not have permission to browse this Registry.')} />;
  }

  return (
    <Card title={t('Docker Registry guide')} loading={loading} style={{ maxWidth: 920 }}>
      <Space direction="vertical" size="large" style={{ display: 'flex' }}>
        <Alert
          type="info"
          showIcon
          message={t(
            'Registry 3 still exposes the Docker Distribution HTTP API at /v2/. The plugin detects media types and capabilities instead of guessing the Registry runtime version.',
          )}
        />
        <section>
          <Typography.Title level={4}>{t('Current configuration')}</Typography.Title>
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label={t('External Registry host (optional)')}>
              {host || t('Not exposed (private mode)')}
            </Descriptions.Item>
            <Descriptions.Item label={t('Maximum transfer size (MB)')}>
              {settings?.maxTransferSizeMb ?? '-'}
            </Descriptions.Item>
          </Descriptions>
        </section>
        <section>
          <Typography.Title level={4}>{t('Push and pull images')}</Typography.Title>
          {image && host ? (
            <Space direction="vertical" style={{ display: 'flex' }}>
              <DockerCommand command={`docker login ${host}`} />
              <DockerCommand command={`docker tag my-app:latest ${image}`} />
              <DockerCommand command={`docker push ${image}`} />
              <DockerCommand command={`docker pull ${image}`} />
              <DockerCommand command={`docker run ${image}`} />
            </Space>
          ) : (
            <Alert
              type="success"
              showIcon
              message={t('Private Registry mode')}
              description={t(
                'The Registry is reachable only by NocoBase. Use Upload and Download in this UI; external docker pull and docker push commands are intentionally unavailable.',
              )}
            />
          )}
        </section>
        <section>
          <Typography.Title level={4}>{t('Upload and download archives in the UI')}</Typography.Title>
          <Typography.Paragraph>
            {t(
              'Use Upload image on the Registry page to import either a Docker save tar or an OCI image-layout tar. Leave destination repository and tag blank to detect them from archive metadata. Manual values override detected values. Archives with multiple references require an explicit choice. The server verifies paths, sizes and SHA-256 digests before pushing blobs and manifests.',
            )}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            {t(
              'Each upload accepts one root image. Multi-platform images remain supported when represented by one root OCI index.',
            )}
          </Typography.Paragraph>
          <Typography.Paragraph>
            {t(
              'On a repository page, choose Download and select Docker save tar for docker load, or OCI image-layout tar for OCI tooling and exact multi-platform manifest preservation.',
            )}
          </Typography.Paragraph>
          <DockerCommand command="docker load -i team-my-app-latest.docker.tar" />
        </section>
        <Divider />
        <section>
          <Typography.Title level={4}>{t('Private Docker network')}</Typography.Title>
          <DockerCommand command="docker network create nocobase-private" />
          <Typography.Paragraph type="secondary">
            {t(
              'Run NocoBase and the Registry on the same private Docker network. Do not publish Registry port 5000 to the host.',
            )}
          </Typography.Paragraph>
        </section>
        <section>
          <Typography.Title level={4}>{t('Run Registry 2')}</Typography.Title>
          <DockerCommand command="docker run -d --name registry-v2 --network nocobase-private -e REGISTRY_STORAGE_DELETE_ENABLED=true registry:2" />
        </section>
        <section>
          <Typography.Title level={4}>{t('Run Registry 3')}</Typography.Title>
          <DockerCommand command="docker run -d --name registry-v3 --network nocobase-private -e REGISTRY_STORAGE_DELETE_ENABLED=true registry:3" />
          <Typography.Paragraph type="secondary">
            {t(
              'Registry 3 uses /etc/distribution/config.yml as its default configuration path. Registry 2 commonly uses /etc/docker/registry/config.yml.',
            )}
          </Typography.Paragraph>
        </section>
        <section>
          <Typography.Title level={4}>{t('NocoBase permissions')}</Typography.Title>
          <Typography.Paragraph>
            {t(
              'Grant read for catalog and image details, download for archive export, upload for importing archives, and delete only to operators who may remove shared manifest digests. Manage is the union of all actions plus Settings.',
            )}
          </Typography.Paragraph>
          <Typography.Paragraph code>
            pm.docker-registry-ui.read · pm.docker-registry-ui.download · pm.docker-registry-ui.upload ·
            pm.docker-registry-ui.delete · pm.docker-registry-ui.settings · pm.docker-registry-ui.manage
          </Typography.Paragraph>
        </section>
        <section>
          <Typography.Title level={4}>{t('Delete behavior')}</Typography.Title>
          <Typography.Paragraph>
            {t(
              'The plugin resolves a tag to Docker-Content-Digest, then deletes the manifest by digest. Enable delete in both this plugin and the Registry configuration. Run Registry garbage collection separately to reclaim unreferenced storage.',
            )}
          </Typography.Paragraph>
          <Typography.Paragraph>
            {t(
              'Registry v2/v3 has no portable delete-repository endpoint. The plugin deletes each unique manifest digest; the catalog entry may remain until registry cleanup.',
            )}
          </Typography.Paragraph>
        </section>
        <section>
          <Typography.Title level={4}>{t('OCI artifacts and Registry 3')}</Typography.Title>
          <Typography.Paragraph>
            {t(
              'When the Registry supports the OCI Referrers API, image details also show related signatures, attestations and SBOM artifacts. Registry 2 instances without this API continue to work and simply hide that section.',
            )}
          </Typography.Paragraph>
        </section>
        <section>
          <Typography.Title level={4}>{t('Troubleshooting')}</Typography.Title>
          <Typography.Paragraph>
            {t(
              'A 401 response can mean the Registry is reachable but requires authentication. Check the credential mode and test connection result before treating it as a network failure.',
            )}
          </Typography.Paragraph>
          <Typography.Paragraph>
            {t(
              'For OCI images and multi-architecture tags, open the image detail page and choose a platform descriptor before inspecting layers.',
            )}
          </Typography.Paragraph>
        </section>
      </Space>
    </Card>
  );
}
