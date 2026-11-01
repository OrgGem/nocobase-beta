import { CloseOutlined } from '@ant-design/icons';
import { connect, mapReadPretty } from '@formily/react';
import { Icon, icons } from '@nocobase/client-v2';
import { Button, Empty, Flex, Input, Popover, Radio, Space } from 'antd';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getIconGroup, ICON_GROUPS } from '../icons';

interface IconPickerProps {
  value?: string;
  onChange?: (value: string | null) => void;
  onChangeComplete?: (value: string | null) => void;
  disabled?: boolean;
  suffix?: React.ReactNode;
  iconSize?: number;
  searchable?: boolean;
}

export function NativeIconPicker({
  value,
  onChange,
  onChangeComplete,
  disabled,
  suffix,
  iconSize = 20,
  searchable = true,
}: IconPickerProps) {
  const { t } = useTranslation(['plugin-antd-style-theme', 'client']);
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState('Outlined');
  const [search, setSearch] = useState('');
  const available = [...icons.keys()];
  const groups = ICON_GROUPS.filter((name) => available.some((key) => getIconGroup(key) === name));
  const filtered = available.filter(
    (key) => getIconGroup(key) === group && key.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const select = (key: string | null) => {
    onChange?.(key);
    onChangeComplete?.(key);
    setOpen(false);
  };
  return (
    <Space.Compact>
      <Popover
        trigger="click"
        placement="bottom"
        open={!disabled && open}
        onOpenChange={setOpen}
        content={
          <Flex vertical gap="small" style={{ width: 420, maxWidth: '80vw' }}>
            {searchable && (
              <Input.Search
                allowClear
                aria-label={t('Search icons')}
                placeholder={t('Search icons')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
            <Radio.Group
              size="small"
              optionType="button"
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              options={groups.map((name) => ({ label: t(name), value: name }))}
            />
            <Flex wrap gap="small" style={{ maxHeight: 280, overflowY: 'auto' }}>
              {filtered.length ? (
                filtered.map((key) => (
                  <Button
                    key={key}
                    type={value?.toLowerCase() === key ? 'primary' : 'text'}
                    title={key}
                    aria-label={key}
                    aria-pressed={value?.toLowerCase() === key}
                    onClick={() => select(key)}
                    icon={<Icon type={key} style={{ fontSize: iconSize }} />}
                  />
                ))
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('No icons')} />
              )}
            </Flex>
          </Flex>
        }
      >
        <Button disabled={disabled} aria-label={t('Select icon')}>
          {value && icons.has(value.toLowerCase()) ? <Icon type={value} /> : t('Select icon')}
          {suffix}
        </Button>
      </Popover>
      {value && !disabled && (
        <Button aria-label={t('Clear icon')} icon={<CloseOutlined />} onClick={() => select(null)} />
      )}
    </Space.Compact>
  );
}

export const IconPicker = connect(
  NativeIconPicker,
  mapReadPretty(({ value }: Pick<IconPickerProps, 'value'>) => (value ? <Icon type={value} /> : null)),
);
