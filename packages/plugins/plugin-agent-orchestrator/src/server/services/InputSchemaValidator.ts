import Ajv from 'ajv';
import { parseJsonText } from '../skill-hub/utils/json-fields';

type JsonSchema = Record<string, unknown> | boolean;

const ajv = new Ajv({
  allErrors: true,
  jsonPointers: true,
});

function parseSchema(value: unknown): JsonSchema | null {
  if (value === undefined || value === null || value === '') return null;
  const schema = parseJsonText<unknown>(value, undefined);
  if (typeof schema === 'boolean') return schema;
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  throw new Error('Input Schema must be a valid JSON Schema object.');
}

export function validateInputSchemaDefinition(value: unknown): void {
  const schema = parseSchema(value);
  if (schema === null) return;
  try {
    ajv.compile(schema);
  } catch (error) {
    throw new Error(`Invalid Input Schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateSkillInput(schemaValue: unknown, input: unknown): void {
  const schema = parseSchema(schemaValue);
  if (schema === null) return;

  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(`Invalid Input Schema: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (validate(input)) return;
  throw new Error(`Skill input validation failed: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
}
