import {describe, expect, test} from 'vitest';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.js';
import {Database} from '../../../zqlite/src/db.js';
import {listIndexes, listTables} from './lite-tables.js';
import type {LiteIndexSpec, LiteTableSpec} from './specs.js';

describe('lite/tables', () => {
  type Case = {
    name: string;
    setupQuery: string;
    expectedResult: LiteTableSpec[];
  };

  const cases: Case[] = [
    {
      name: 'No tables',
      setupQuery: ``,
      expectedResult: [],
    },
    {
      name: 'zero.clients',
      setupQuery: `
      CREATE TABLE "zero.clients" (
        "clientID" VARCHAR (180) PRIMARY KEY,
        "lastMutationID" BIGINT
      );
      `,
      expectedResult: [
        {
          name: 'zero.clients',
          columns: {
            clientID: {
              pos: 1,
              dataType: 'VARCHAR (180)',
              characterMaximumLength: null,
              notNull: false,
              dflt: null,
            },
            lastMutationID: {
              pos: 2,
              dataType: 'BIGINT',
              characterMaximumLength: null,
              notNull: false,
              dflt: null,
            },
          },
          primaryKey: ['clientID'],
        },
      ],
    },
    {
      name: 'types and array types',
      setupQuery: `
      CREATE TABLE users (
        user_id INTEGER PRIMARY KEY,
        handle text DEFAULT 'foo',
        address text[],
        bigint BIGINT DEFAULT '2147483648',
        bool_array BOOL[],
        real_array REAL[],
        int_array INTEGER[] DEFAULT '{1, 2, 3}',
        json_val JSONB
      );
      `,
      expectedResult: [
        {
          name: 'users',
          columns: {
            ['user_id']: {
              pos: 1,
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
              dflt: null,
            },
            handle: {
              pos: 2,
              characterMaximumLength: null,
              dataType: 'TEXT',
              notNull: false,
              dflt: "'foo'",
            },
            address: {
              pos: 3,
              characterMaximumLength: null,
              dataType: 'text[]',
              notNull: false,
              dflt: null,
            },
            bigint: {
              pos: 4,
              characterMaximumLength: null,
              dataType: 'BIGINT',
              notNull: false,
              dflt: "'2147483648'",
            },
            ['bool_array']: {
              pos: 5,
              characterMaximumLength: null,
              dataType: 'BOOL[]',
              notNull: false,
              dflt: null,
            },
            ['real_array']: {
              pos: 6,
              characterMaximumLength: null,
              dataType: 'REAL[]',
              notNull: false,
              dflt: null,
            },
            ['int_array']: {
              pos: 7,
              dataType: 'INTEGER[]',
              characterMaximumLength: null,
              notNull: false,
              dflt: "'{1, 2, 3}'",
            },
            ['json_val']: {
              pos: 8,
              dataType: 'JSONB',
              characterMaximumLength: null,
              notNull: false,
              dflt: null,
            },
          },
          primaryKey: ['user_id'],
        },
      ],
    },
    {
      name: 'primary key columns',
      setupQuery: `
      CREATE TABLE issues (
        issue_id INTEGER,
        description TEXT,
        org_id INTEGER NOT NULL,
        component_id INTEGER,
        PRIMARY KEY (org_id, component_id, issue_id)
      );
      `,
      expectedResult: [
        {
          name: 'issues',
          columns: {
            ['issue_id']: {
              pos: 1,
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
              dflt: null,
            },
            ['description']: {
              pos: 2,
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: false,
              dflt: null,
            },
            ['org_id']: {
              pos: 3,
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: true,
              dflt: null,
            },
            ['component_id']: {
              pos: 4,
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
              dflt: null,
            },
          },
          primaryKey: ['org_id', 'component_id', 'issue_id'],
        },
      ],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const db = new Database(createSilentLogContext(), ':memory:');
      db.exec(c.setupQuery);

      const tables = listTables(db);
      expect(tables).toEqual(c.expectedResult);
    });
  }
});

describe('lite/indexes', () => {
  type Case = {
    name: string;
    setupQuery: string;
    expectedResult: LiteIndexSpec[];
  };

  const cases: Case[] = [
    {
      name: 'no indexes',
      setupQuery: `
    CREATE TABLE "zero.clients" (
      "clientID" VARCHAR (180) PRIMARY KEY,
      "lastMutationID" BIGINT
    );
    `,
      expectedResult: [],
    },
    {
      name: 'unique',
      setupQuery: `
    CREATE TABLE users (
      userID VARCHAR (180) PRIMARY KEY,
      handle TEXT UNIQUE
    );
    `,
      expectedResult: [
        {
          name: 'sqlite_autoindex_users_2',
          tableName: 'users',
          unique: true,
          columns: {handle: 'ASC'},
        },
      ],
    },
    {
      name: 'multiple columns',
      setupQuery: `
    CREATE TABLE users (
      userID VARCHAR (180) PRIMARY KEY,
      first TEXT,
      last TEXT,
      handle TEXT UNIQUE
    );
    CREATE INDEX full_name ON users (last desc, first);
    `,
      expectedResult: [
        {
          name: 'full_name',
          tableName: 'users',
          unique: false,
          columns: {
            last: 'DESC',
            first: 'ASC',
          },
        },
        {
          name: 'sqlite_autoindex_users_2',
          tableName: 'users',
          unique: true,
          columns: {handle: 'ASC'},
        },
      ],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const db = new Database(createSilentLogContext(), ':memory:');
      db.exec(c.setupQuery);

      const tables = listIndexes(db);
      expect(tables).toEqual(c.expectedResult);
    });
  }
});
