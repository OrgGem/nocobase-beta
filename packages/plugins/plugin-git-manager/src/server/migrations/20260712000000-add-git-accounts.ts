import { Migration } from '@nocobase/server';
import { DataTypes, QueryTypes } from 'sequelize';

interface LegacyRepositoryCredential {
  id: number;
  repoUrl: string | null;
  username: string | null;
  pat: string;
}

interface AccountCredential {
  id: number;
  username: string;
  pat: string;
}

export default class AddGitAccountsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const sequelize = (this as any).db.sequelize;
    const tablePrefix = (this as any).db.options?.tablePrefix || '';
    const repoTable = `${tablePrefix}gitRepositories`;
    const accountsTable = `${tablePrefix}gitAccounts`;

    const quoteTable = (tableName: string) => queryInterface.queryGenerator.quoteTable(tableName);
    const quoteIdentifier = (identifier: string) => queryInterface.queryGenerator.quoteIdentifier(identifier);
    const quotedRepoTable = quoteTable(repoTable);
    const quotedAccountsTable = quoteTable(accountsTable);

    const repoInfo = await queryInterface.describeTable(repoTable).catch(() => null);
    if (!repoInfo) return;

    // 1. Create gitAccounts table
    const accountsExists = await queryInterface.describeTable(accountsTable).catch(() => null);
    if (!accountsExists) {
      await queryInterface.createTable(accountsTable, {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        name: { type: DataTypes.STRING, allowNull: false },
        provider: { type: DataTypes.STRING, allowNull: false, defaultValue: 'gitlab' },
        baseUrl: { type: DataTypes.STRING, allowNull: true },
        username: { type: DataTypes.STRING, allowNull: false },
        pat: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      });
    }

    // 2. Add gitAccountId column to gitRepositories
    if (!repoInfo.gitAccountId) {
      await queryInterface.addColumn(repoTable, 'gitAccountId', {
        type: DataTypes.BIGINT,
        allowNull: true,
      });
    }

    // 3. Migrate existing data: deduplicate by (host, username, pat)
    if (repoInfo.username && repoInfo.pat) {
      const rows = (await sequelize.query(
        `SELECT ${quoteIdentifier('id')}, ${quoteIdentifier('repoUrl')}, ${quoteIdentifier(
          'username',
        )}, ${quoteIdentifier('pat')}
         FROM ${quotedRepoTable}
         WHERE ${quoteIdentifier('pat')} IS NOT NULL AND ${quoteIdentifier('pat')} != ''`,
        { type: QueryTypes.SELECT },
      )) as LegacyRepositoryCredential[];

      if (rows.length > 0) {
        const now = new Date();

        // Group by host + username + pat to deduplicate
        const groups = new Map<string, { host: string; username: string; pat: string; repoIds: number[] }>();
        for (const row of rows) {
          let host = '';
          try {
            host = row.repoUrl ? new URL(row.repoUrl).host : '';
          } catch {
            /* keep empty */
          }
          const username = row.username || '';
          const key = `${host}::${username}::${row.pat}`;
          if (!groups.has(key)) {
            groups.set(key, { host, username, pat: row.pat, repoIds: [] });
          }
          const group = groups.get(key);
          if (group) group.repoIds.push(row.id);
        }

        for (const [, group] of groups) {
          const name = group.host ? `${group.host} (${group.username})` : `${group.username}`;
          const baseUrl = group.host ? `https://${group.host}` : null;

          const provider = group.host.toLowerCase().includes('github') ? 'github' : 'gitlab';
          const accountsRepository = (this as any).db.getRepository('gitAccounts');
          const existingAccount = await accountsRepository.findOne({
            filter: { provider, baseUrl, username: group.username, pat: group.pat },
          });
          const account =
            existingAccount ||
            (await accountsRepository.create({
              values: {
                name,
                provider,
                baseUrl,
                username: group.username,
                pat: group.pat,
                createdAt: now,
                updatedAt: now,
              },
            }));
          const accountId = account.get('id') as number;

          if (accountId) {
            for (const repoId of group.repoIds) {
              await sequelize.query(
                `UPDATE ${quotedRepoTable}
                 SET ${quoteIdentifier('gitAccountId')} = :accountId
                 WHERE ${quoteIdentifier('id')} = :repoId`,
                { replacements: { accountId, repoId } },
              );
            }
          }
        }
      }
    }

    // 4. Remove old username and pat columns
    if (repoInfo.username) {
      await queryInterface.removeColumn(repoTable, 'username');
    }
    if (repoInfo.pat) {
      await queryInterface.removeColumn(repoTable, 'pat');
    }
  }

  async down() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const sequelize = (this as any).db.sequelize;
    const tablePrefix = (this as any).db.options?.tablePrefix || '';
    const repoTable = `${tablePrefix}gitRepositories`;
    const accountsTable = `${tablePrefix}gitAccounts`;

    const quoteTable = (tableName: string) => queryInterface.queryGenerator.quoteTable(tableName);
    const quoteIdentifier = (identifier: string) => queryInterface.queryGenerator.quoteIdentifier(identifier);
    const quotedRepoTable = quoteTable(repoTable);
    const quotedAccountsTable = quoteTable(accountsTable);

    const repoInfo = await queryInterface.describeTable(repoTable).catch(() => null);
    if (!repoInfo) return;

    // Restore username and pat columns
    if (!repoInfo.username) {
      await queryInterface.addColumn(repoTable, 'username', {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }
    if (!repoInfo.pat) {
      await queryInterface.addColumn(repoTable, 'pat', {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }

    const accountsExists = await queryInterface.describeTable(accountsTable).catch(() => null);
    if (repoInfo.gitAccountId && accountsExists) {
      const credentials = (await sequelize.query(
        `SELECT r.${quoteIdentifier('id')} AS ${quoteIdentifier('id')},
                a.${quoteIdentifier('username')} AS ${quoteIdentifier('username')},
                a.${quoteIdentifier('pat')} AS ${quoteIdentifier('pat')}
         FROM ${quotedRepoTable} r
         INNER JOIN ${quotedAccountsTable} a
           ON r.${quoteIdentifier('gitAccountId')} = a.${quoteIdentifier('id')}`,
        { type: QueryTypes.SELECT },
      )) as AccountCredential[];

      for (const credential of credentials) {
        await sequelize.query(
          `UPDATE ${quotedRepoTable}
           SET ${quoteIdentifier('username')} = :username, ${quoteIdentifier('pat')} = :pat
           WHERE ${quoteIdentifier('id')} = :id`,
          { replacements: credential },
        );
      }
    }

    // Drop gitAccountId column
    if (repoInfo.gitAccountId) {
      await queryInterface.removeColumn(repoTable, 'gitAccountId');
    }

    // Drop gitAccounts table
    if (accountsExists) {
      await queryInterface.dropTable(accountsTable);
    }
  }
}
