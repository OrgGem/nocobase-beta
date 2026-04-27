import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Tree, Empty, Spin, Typography, Select, Space, Breadcrumb, Input, theme } from 'antd';
import {
  FileOutlined,
  FileTextOutlined,
  CodeOutlined,
  FileImageOutlined,
  FileMarkdownOutlined,
  Html5Outlined,
} from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useGitManager } from '../context/GitManagerContext';
import { useT } from '../locale';

const { Text } = Typography;
const { Search } = Input;
const { useToken } = theme;

const FILE_ICONS: Record<string, React.ReactNode> = {
  ts: <CodeOutlined style={{ color: '#3178c6' }} />,
  tsx: <CodeOutlined style={{ color: '#3178c6' }} />,
  js: <CodeOutlined style={{ color: '#f7df1e' }} />,
  jsx: <CodeOutlined style={{ color: '#f7df1e' }} />,
  json: <CodeOutlined style={{ color: '#5b5b5b' }} />,
  md: <FileMarkdownOutlined style={{ color: '#083fa1' }} />,
  html: <Html5Outlined style={{ color: '#e34c26' }} />,
  css: <FileTextOutlined style={{ color: '#563d7c' }} />,
  py: <CodeOutlined style={{ color: '#3572A5' }} />,
  png: <FileImageOutlined style={{ color: '#a85e32' }} />,
  jpg: <FileImageOutlined style={{ color: '#a85e32' }} />,
  svg: <FileImageOutlined style={{ color: '#ffb13b' }} />,
};

function getFileIcon(name: string, type: string) {
  if (type === 'tree') return undefined; // use default folder icons
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return FILE_ICONS[ext] || <FileOutlined />;
}

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', html: 'html', css: 'css', scss: 'scss',
    py: 'python', sh: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql',
    xml: 'xml', java: 'java', go: 'go', rs: 'rust', rb: 'ruby',
  };
  return map[ext] || 'text';
}

interface TreeNode {
  key: string;
  title: React.ReactNode;
  icon: React.ReactNode;
  isLeaf: boolean;
  children?: TreeNode[];
  filePath: string;
  fileType: string;
}

export const FileExplorer: React.FC = () => {
  const t = useT();
  const { token } = useToken();
  const api = useAPIClient();
  const { selectedRepo, branches: branchList, currentBranch, refreshBranches } = useGitManager();
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [currentRef, setCurrentRef] = useState('HEAD');
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [contentLoading, setContentLoading] = useState(false);

  const loadTree = useCallback(
    async (treePath = '', ref = currentRef) => {
      if (!selectedRepo) return [];
      const { data } = await api.request({
        url: 'gitManager:fileTree',
        params: { repositoryId: selectedRepo.id, ref, treePath },
      });
      const responseData = data?.data || data || [];
      const list = Array.isArray(responseData) ? responseData : (Array.isArray(responseData?.data) ? responseData.data : []);
      
      return list.map((item: any) => ({
        key: item.path,
        title: (
          <Text style={{ fontSize: 13 }}>
            {item.name}
            {item.type === 'blob' && item.size > 0 && (
              <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                {item.size > 1024 ? `${(item.size / 1024).toFixed(1)}KB` : `${item.size}B`}
              </Text>
            )}
          </Text>
        ),
        icon: getFileIcon(item.name, item.type),
        isLeaf: item.type === 'blob',
        filePath: item.path,
        fileType: item.type,
      }));
    },
    [api, selectedRepo, currentRef],
  );

  const loadRoot = useCallback(async () => {
    setLoading(true);
    try {
      const nodes = await loadTree('', currentRef);
      setTreeData(nodes);
    } finally {
      setLoading(false);
    }
  }, [loadTree, currentRef]);

  useEffect(() => {
    if (selectedRepo?.status === 'connected') {
      refreshBranches();
      setFileContent(null);
      setSelectedFile(null);
    } else {
      setTreeData([]);
    }
  }, [selectedRepo]);

  // Sync currentRef when branch data arrives
  useEffect(() => {
    if (currentBranch && currentRef === 'HEAD') {
      setCurrentRef(currentBranch);
    }
  }, [currentBranch]);

  useEffect(() => {
    if (selectedRepo?.status === 'connected') {
      loadRoot();
    }
  }, [currentRef, selectedRepo]);

  const onLoadData = async (node: any) => {
    if (node.children) return;
    const children = await loadTree(node.filePath, currentRef);
    setTreeData((prev) => updateTreeData(prev, node.key, children));
  };

  const onSelect = async (_: any, info: any) => {
    const node = info.node;
    if (!node.isLeaf) return;
    setContentLoading(true);
    setSelectedFile(node.filePath);
    try {
      const { data } = await api.request({
        url: 'gitManager:fileContent',
        params: { repositoryId: selectedRepo.id, ref: currentRef, filePath: node.filePath },
      });
      const responseData = data?.data?.data || data?.data;
      setFileContent(responseData?.content || '');
    } catch {
      setFileContent('// Failed to load file content');
    } finally {
      setContentLoading(false);
    }
  };

  // Debounce search text by 300ms
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedSearch(searchText), 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchText]);

  if (!selectedRepo) {
    return <Empty description={t('No repository selected')} />;
  }

  if (selectedRepo.status !== 'connected') {
    return <Empty description={t('Repository not cloned yet')} />;
  }

  const filteredTree = debouncedSearch ? filterTree(treeData, debouncedSearch.toLowerCase()) : treeData;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 280px)', gap: 0 }}>
      {/* Left sidebar - file tree */}
      <div
        style={{
          width: 320,
          minWidth: 280,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          flexDirection: 'column',
          background: token.colorBgContainer,
        }}
      >
        <div style={{ padding: '8px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            <Select
              size="small"
              style={{ width: '100%' }}
              value={currentRef}
              onChange={(val) => {
                setCurrentRef(val);
                setFileContent(null);
                setSelectedFile(null);
              }}
              options={branchList.map((b) => ({ label: b, value: b }))}
              placeholder="Branch"
            />
            <Search
              size="small"
              placeholder="Filter files..."
              allowClear
              onChange={(e) => setSearchText(e.target.value)}
            />
          </Space>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
          ) : (
            <Tree
              showIcon
              treeData={filteredTree}
              loadData={onLoadData}
              onSelect={onSelect}
              selectedKeys={selectedFile ? [selectedFile] : []}
              style={{ fontSize: 13 }}
              blockNode
            />
          )}
        </div>
      </div>

      {/* Right panel - file content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: token.colorBgLayout }}>
        {selectedFile ? (
          <>
            <div
              style={{
                padding: '6px 16px',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Breadcrumb
                items={selectedFile.split('/').map((part, i, arr) => ({
                  title: i === arr.length - 1 ? <Text strong>{part}</Text> : part,
                }))}
              />
              <Text type="secondary" style={{ marginLeft: 'auto', fontSize: 12 }}>
                {getLanguage(selectedFile)}
              </Text>
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              {contentLoading ? (
                <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
              ) : (
                <pre
                  style={{
                    margin: 0,
                    padding: 16,
                    fontSize: 13,
                    lineHeight: 1.6,
                    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    background: token.colorBgContainer,
                    minHeight: '100%',
                  }}
                >
                  {(fileContent || '').split('\n').map((line, i) => (
                    <div key={i} style={{ display: 'flex' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 50,
                          textAlign: 'right',
                          paddingRight: 16,
                          color: token.colorTextQuaternary,
                          userSelect: 'none',
                          flexShrink: 0,
                        }}
                      >
                        {i + 1}
                      </span>
                      <span style={{ flex: 1 }}>{line || ' '}</span>
                    </div>
                  ))}
                </pre>
              )}
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Text type="secondary">Select a file to view its content</Text>
          </div>
        )}
      </div>
    </div>
  );
};

function updateTreeData(list: TreeNode[], key: string, children: TreeNode[]): TreeNode[] {
  return list.map((node) => {
    if (node.key === key) {
      return { ...node, children };
    }
    if (node.children) {
      return { ...node, children: updateTreeData(node.children, key, children) };
    }
    return node;
  });
}

function filterTree(nodes: TreeNode[], text: string): TreeNode[] {
  return nodes
    .map((node) => {
      if (node.children) {
        const filtered = filterTree(node.children, text);
        if (filtered.length > 0) return { ...node, children: filtered };
      }
      const name = (node.filePath || '').toLowerCase();
      if (name.includes(text)) return node;
      return null;
    })
    .filter(Boolean) as TreeNode[];
}
