import React from 'react';
import { Select } from 'antd';
import { useAIEmployees } from './AIEmployeesContext';

/**
 * Reusable Select component for AI Employees.
 * P3 FIX: Uses shared AIEmployeesContext instead of making its own API call.
 */
export const AIEmployeeSelect: React.FC<{
  value?: string;
  onChange?: (value: string) => void;
  exclude?: string; // username to exclude (prevent self-reference)
  placeholder?: string;
}> = ({ value, onChange, exclude, placeholder = 'Select AI Employee...' }) => {
  const { employees, loading } = useAIEmployees();

  const options = React.useMemo(() => {
    return employees
      .filter((emp) => !exclude || emp.username !== exclude)
      .map((emp) => ({
        label: emp.nickname,
        value: emp.username,
        description: emp.about,
      }));
  }, [employees, exclude]);

  return (
    <Select
      loading={loading}
      options={options}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      showSearch
      filterOption={(input, option) =>
        (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase()) ||
        (option?.value ?? '').toString().toLowerCase().includes(input.toLowerCase())
      }
      optionRender={(option) => (
        <div>
          <div style={{ fontWeight: 500 }}>{option.label}</div>
          {option.data.description && <div style={{ fontSize: 12, color: '#888' }}>{option.data.description}</div>}
        </div>
      )}
    />
  );
};
