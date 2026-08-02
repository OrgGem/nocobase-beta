import React from 'react';
import { Alert, Button, Card, Collapse, Divider, Space, Tag, Typography } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';

function apiExamples(apiBaseUrl: string) {
  return [
    {
      title: 'List packages',
      code: `curl '${apiBaseUrl}/skillRegistryPublic:list?limit=20&channel=stable&includeCompatibility=false'`,
    },
    {
      title: 'Search packages',
      code: `curl '${apiBaseUrl}/skillRegistryPublic:list?q=ppt&channel=stable'`,
    },
    {
      title: 'Get package',
      code: `curl '${apiBaseUrl}/skillRegistryPublic:get?package=orggem/gen-doc-ppt-master'`,
    },
    {
      title: 'List versions',
      code: `curl '${apiBaseUrl}/skillRegistryPublic:versions?package=orggem/gen-doc-ppt-master&channel=stable'`,
    },
    {
      title: 'Download artifact',
      code: `curl -L -o skill.zip '${apiBaseUrl}/skillRegistryPublic:download?package=orggem/gen-doc-ppt-master&version=1.0.0'`,
    },
    { title: 'Registry metadata', code: `curl '${apiBaseUrl}/skillRegistryPublic:metadata'` },
  ];
}

function CodeExample({ code, copyLabel, onCopy }: { code: string; copyLabel: string; onCopy: () => void }) {
  return (
    <Space.Compact block>
      <Typography.Text code style={{ flex: 1, padding: 8, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
        {code}
      </Typography.Text>
      <Button aria-label={copyLabel} onClick={onCopy}>
        {copyLabel}
      </Button>
    </Space.Compact>
  );
}

export default function GuidePage() {
  const t = useT();
  const ctx = useFlowContext();
  const configuredApiBaseUrl = ctx.api.axios.defaults.baseURL || '/api';
  const apiBaseUrl = new URL(configuredApiBaseUrl, `${window.location.origin}/`).toString().replace(/\/+$/, '');
  const examples = apiExamples(apiBaseUrl);
  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    ctx.message.success(t('Copied'));
  };

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex', maxWidth: 1100 }}>
      <Alert
        type="info"
        showIcon
        message={t('What is Skill Registry?')}
        description={t('Skill Registry is a versioned, immutable catalog for skills imported from approved sources.')}
      />
      <Card title={t('How the workflow works')}>
        <Typography.Paragraph>
          {t(
            'A source is connected to Git Manager or Skill Hub. Sync discovers SKILL.md files and creates candidates. A ready candidate can be published as an immutable version, then downloaded through the public catalog API.',
          )}
        </Typography.Paragraph>
        <Space wrap>
          {['Source', 'Sync', 'Candidate', 'Publish', 'Catalog API'].map((step, index) => (
            <Tag color="blue" key={step}>
              {index + 1}. {t(step)}
            </Tag>
          ))}
        </Space>
        <Divider />
        <Typography.Paragraph>
          <strong>{t('Instruction-only')}</strong>:{' '}
          {t(
            'Only SKILL.md is packaged; files such as references, models, and binaries are not scanned unless codeFile is declared.',
          )}
        </Typography.Paragraph>
        <Typography.Paragraph>
          <strong>{t('Executable')}</strong>:{' '}
          {t('A declared Python or Node entrypoint is validated and included in the artifact.')}
        </Typography.Paragraph>
      </Card>
      <Card title={t('Public catalog API')}>
        <Typography.Paragraph>
          {t(
            'Enable anonymous access with SKILL_REGISTRY_PUBLIC_ENABLED=true. These endpoints are read-only and do not require an Authorization header.',
          )}
        </Typography.Paragraph>
        <Collapse
          items={examples.map(({ title, code }) => ({
            key: title,
            label: t(title),
            children: <CodeExample code={code} copyLabel={t('Copy')} onCopy={() => copy(code)} />,
          }))}
        />
      </Card>
      <Card title={t('API response and pagination')}>
        <Typography.Paragraph>
          {t(
            'list and versions return records in data plus meta.nextCursor. Send the opaque cursor unchanged with the same filters to fetch the next page. limit accepts 1 through 100 and defaults to 20.',
          )}
        </Typography.Paragraph>
        <Typography.Text code>{'{ "data": [], "meta": { "nextCursor": null } }'}</Typography.Text>
        <Typography.Paragraph>
          {t('Set includeCompatibility=false on list requests to omit compatibility from each row.')}
        </Typography.Paragraph>
        <Typography.Paragraph>
          {t(
            'download returns a ZIP and the X-Skill-Version, X-Artifact-Sha256, and Digest headers. Hash the downloaded bytes and compare the SHA-256 digest before installing.',
          )}
        </Typography.Paragraph>
      </Card>
      <Card title={t('Administration checklist')}>
        <Typography.Paragraph>
          {t(
            'Grant registryExportEnabled on the Git Manager repository, create a source, run Discover or Sync, resolve blocked candidates, and publish a semantic version. A successful sync does not publish a version automatically.',
          )}
        </Typography.Paragraph>
        <Typography.Paragraph>
          {t('Versions stays empty until a candidate is published. A yanked version is no longer downloadable.')}
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}
