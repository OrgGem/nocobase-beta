import React from 'react';
import { Select } from 'antd';
import { useRequest, useCompile } from '@nocobase/client';

export const SkillsSelect: React.FC<any> = (props) => {
  const compile = useCompile();
  const { data, loading } = useRequest({
    url: 'aiTools:list',
  });

  const options = React.useMemo(() => {
    const d = data as any;
    if (!d?.data) return [];
    
    // NocoBase aiTools:list returns a flat array of tools, not groups.
    const tools = d.data as any[];
    
    // NocoBase built-in grouping style
    const generalTools = tools.filter(t => t.scope === 'GENERAL');
    const customTools = tools.filter(t => t.scope === 'CUSTOM');
    const otherTools = tools.filter(t => t.scope !== 'GENERAL' && t.scope !== 'CUSTOM');

    const result = [];
    
    if (generalTools.length > 0) {
      result.push({
        label: compile('{{t("General skills")}}'),
        options: generalTools.map(t => ({
          label: compile(t.introduction?.title || t.definition?.name),
          value: t.definition?.name,
        }))
      });
    }

    if (customTools.length > 0) {
      result.push({
        label: compile('{{t("Custom skills")}}'),
        options: customTools.map(t => ({
          label: compile(t.introduction?.title || t.definition?.name),
          value: t.definition?.name,
        }))
      });
    }
    
    if (otherTools.length > 0) {
      result.push({
        label: compile('{{t("Other skills")}}'),
        options: otherTools.map(t => ({
          label: compile(t.introduction?.title || t.definition?.name),
          value: t.definition?.name,
        }))
      });
    }

    return result;
  }, [data, compile]);

  return (
    <Select
      mode="multiple"
      loading={loading}
      options={options}
      placeholder="Select skills for sub-agent..."
      style={{ width: '100%' }}
      showSearch
      filterOption={(input, option) =>
        (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase()) ||
        (option?.value ?? '').toString().toLowerCase().includes(input.toLowerCase())
      }
      {...props}
    />
  );
};
