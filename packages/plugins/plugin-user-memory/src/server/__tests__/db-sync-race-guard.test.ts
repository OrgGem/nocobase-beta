import { describe, expect, it } from 'vitest';
import {
  isDuplicateUserMemoryProfilesUserIdIndexError,
  isUserMemoryProfilesUserIdIndex,
} from '../utils/db-sync-race-guard';

describe('db sync race guard', () => {
  it('matches the user memory profile userId index by generated index name', () => {
    expect(
      isUserMemoryProfilesUserIdIndex('user_memory_profiles', ['user_id'], {
        name: 'user_memory_profiles_user_id',
      }),
    ).toBe(true);
  });

  it('matches the user memory profile userId index by table and field', () => {
    expect(isUserMemoryProfilesUserIdIndex({ tableName: 'userMemoryProfiles' }, ['userId'])).toBe(true);
  });

  it('does not match unrelated indexes', () => {
    expect(isUserMemoryProfilesUserIdIndex('user_memory_sync_logs', ['user_id'])).toBe(false);
    expect(isUserMemoryProfilesUserIdIndex('user_memory_profiles', ['status'])).toBe(false);
  });

  it('recognizes PostgreSQL duplicate-index errors for the target index', () => {
    expect(
      isDuplicateUserMemoryProfilesUserIdIndexError({
        original: {
          code: '42P07',
          message: 'relation "user_memory_profiles_user_id" already exists',
        },
      }),
    ).toBe(true);
  });

  it('does not swallow duplicate errors for other indexes', () => {
    expect(
      isDuplicateUserMemoryProfilesUserIdIndexError({
        original: {
          code: '42P07',
          message: 'relation "some_other_index" already exists',
        },
      }),
    ).toBe(false);
  });
});
