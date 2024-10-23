import {LogContext} from '@rocicorp/logger';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {createSilentLogContext} from '../../../../../shared/src/logging-test-utils.js';
import {Queue} from '../../../../../shared/src/queue.js';
import type {Database} from '../../../../../zqlite/src/db.js';
import {listIndexes, listTables} from '../../../db/lite-tables.js';
import type {LiteIndexSpec, LiteTableSpec} from '../../../db/specs.js';
import {
  dropReplicationSlot,
  getConnectionURI,
  testDBs,
} from '../../../test/db.js';
import {DbFile} from '../../../test/lite.js';
import type {PostgresDB} from '../../../types/pg.js';
import type {Source} from '../../../types/streams.js';
import type {MessageProcessor} from '../../replicator/incremental-sync.js';
import {createMessageProcessor} from '../../replicator/test-utils.js';
import type {DownstreamChange} from '../change-streamer.js';
import type {DataChange} from '../schema/change.js';
import {initializeChangeSource} from './change-source.js';
import {replicationSlot} from './initial-sync.js';

const SHARD_ID = 'change_source_schema_change_test_id';

/**
 * End-to-mid test. This covers:
 *
 * - Executing a DDL statement on upstream postgres.
 * - Verifying the resulting Change messages in the ChangeStream.
 * - Applying the changes to the replica with a MessageProcessor
 * - Verifying the resulting SQLite schema on the replica.
 */
describe('change-source/pg/schema-changes', () => {
  let lc: LogContext;
  let upstream: PostgresDB;
  let replicaDbFile: DbFile;
  let replica: Database;
  let changes: Source<DownstreamChange>;
  let downstream: Queue<DownstreamChange>;
  let replicator: MessageProcessor;

  beforeAll(async () => {
    lc = createSilentLogContext();
    upstream = await testDBs.create(
      'change_source_schema_change_test_upstream',
    );
    replicaDbFile = new DbFile('change_source_schema_change_test_replica');
    replica = replicaDbFile.connect(lc);

    const upstreamURI = getConnectionURI(upstream);
    await upstream.unsafe(`
    CREATE TABLE foo(
      id TEXT PRIMARY KEY,
      int INT4,
      big BIGINT,
      flt FLOAT8,
      bool BOOLEAN,
      timea TIMESTAMPTZ,
      timeb TIMESTAMPTZ,
      date DATE,
      time TIME
    );

    CREATE SCHEMA test;

    CREATE PUBLICATION zero_some_public FOR TABLE foo (id, int);
    CREATE PUBLICATION zero_all_test FOR TABLES IN SCHEMA test;
    `);

    const source = (
      await initializeChangeSource(
        lc,
        upstreamURI,
        {id: SHARD_ID, publications: ['zero_some_public', 'zero_all_test']},
        replicaDbFile.path,
      )
    ).changeSource;
    const stream = await source.startStream('00');

    changes = stream.changes;
    downstream = drainToQueue(changes);
    replicator = createMessageProcessor(replica);
  });

  afterAll(async () => {
    changes.cancel();
    await dropReplicationSlot(upstream, replicationSlot(SHARD_ID));
    await testDBs.drop(upstream);
    await replicaDbFile.unlink();
  });

  function drainToQueue(
    sub: Source<DownstreamChange>,
  ): Queue<DownstreamChange> {
    const queue = new Queue<DownstreamChange>();
    void (async () => {
      for await (const msg of sub) {
        void queue.enqueue(msg);
      }
    })();
    return queue;
  }

  async function nextTransaction(): Promise<DataChange[]> {
    const data: DataChange[] = [];
    for (;;) {
      const change = await downstream.dequeue();
      replicator.processMessage(lc, change);

      switch (change[0]) {
        case 'begin':
          break;
        case 'data':
          data.push(change[1]);
          break;
        case 'commit':
          return data;
        default:
          change satisfies never;
      }
    }
  }

  test.each([
    [
      'create table',
      'CREATE TABLE test.bar (id INT8 PRIMARY KEY);',
      [{tag: 'create-table'}],
      [
        {
          name: 'test.bar',
          columns: {
            id: {
              characterMaximumLength: null,
              dataType: 'int8',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 2,
            },
          },
          primaryKey: ['id'],
        },
      ],
      [],
    ],
    [
      'add column',
      'ALTER TABLE test.bar ADD name INT8;',
      [{tag: 'add-column'}],
      [
        {
          columns: {
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 2,
            },
            id: {
              characterMaximumLength: null,
              dataType: 'int8',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            name: {
              characterMaximumLength: null,
              dataType: 'int8',
              dflt: null,
              notNull: false,
              pos: 3,
            },
          },
          name: 'test.bar',
          primaryKey: ['id'],
        },
      ],
      [],
    ],
    [
      'rename column',
      'ALTER TABLE test.bar RENAME name TO handle;',
      [{tag: 'update-column'}],
      [
        {
          columns: {
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 2,
            },
            id: {
              characterMaximumLength: null,
              dataType: 'int8',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            handle: {
              characterMaximumLength: null,
              dataType: 'int8',
              dflt: null,
              notNull: false,
              pos: 3,
            },
          },
          name: 'test.bar',
          primaryKey: ['id'],
        },
      ],
      [],
    ],
    [
      'change column data type',
      'ALTER TABLE test.bar ALTER handle TYPE TEXT;',
      [{tag: 'update-column'}],
      [
        {
          columns: {
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 2,
            },
            id: {
              characterMaximumLength: null,
              dataType: 'int8',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            handle: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: false,
              pos: 3,
            },
          },
          name: 'test.bar',
          primaryKey: ['id'],
        },
      ],
      [],
    ],
    [
      'add unique column to automatically generate index',
      'ALTER TABLE test.bar ADD username TEXT UNIQUE;',
      [{tag: 'add-column'}, {tag: 'create-index'}],
      [
        {
          columns: {
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 2,
            },
            id: {
              characterMaximumLength: null,
              dataType: 'int8',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            handle: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: false,
              pos: 3,
            },
            username: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: false,
              pos: 4,
            },
          },
          name: 'test.bar',
          primaryKey: ['id'],
        },
      ],
      [
        {
          name: 'test.bar_username_key',
          tableName: 'test.bar',
          columns: {username: 'ASC'},
          unique: true,
        },
      ],
    ],
    [
      'rename unique column with associated index',
      'ALTER TABLE test.bar RENAME username TO login;',
      [{tag: 'update-column'}],
      [
        {
          columns: {
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 2,
            },
            id: {
              characterMaximumLength: null,
              dataType: 'int8',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            handle: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: false,
              pos: 3,
            },
            login: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: false,
              pos: 4,
            },
          },
          name: 'test.bar',
          primaryKey: ['id'],
        },
      ],
      [
        {
          name: 'test.bar_username_key',
          tableName: 'test.bar',
          columns: {login: 'ASC'},
          unique: true,
        },
      ],
    ],
    [
      // SqliteError: error in index test.bar_username_key after drop column: no such column: \"login\"
      // https://sqlite.org/forum/forumpost/2e62dba69f?t=c&hist
      // TODO: In order to support re-typing columns that are indexed,
      // we would need to drop and re-create related indexes when doing the copy-rename-column dance.
      'DISABLED: retype unique column with associated index',
      'ALTER TABLE test.bar ALTER login TYPE VARCHAR(180);',
      [{tag: 'update-column'}],
      [
        {
          columns: {
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 2,
            },
            id: {
              characterMaximumLength: null,
              dataType: 'int8',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            handle: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: false,
              pos: 3,
            },
            login: {
              characterMaximumLength: null,
              dataType: 'varchar',
              dflt: null,
              notNull: false,
              pos: 4,
            },
          },
          name: 'test.bar',
          primaryKey: ['id'],
        },
      ],
      [
        {
          name: 'test.bar_username_key',
          tableName: 'test.bar',
          columns: {login: 'ASC'},
          unique: true,
        },
      ],
    ],
    [
      'drop column with index',
      'ALTER TABLE test.bar DROP login;',
      [{tag: 'drop-index'}, {tag: 'drop-column'}],
      [
        {
          columns: {
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 2,
            },
            id: {
              characterMaximumLength: null,
              dataType: 'int8',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            handle: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: false,
              pos: 3,
            },
          },
          name: 'test.bar',
          primaryKey: ['id'],
        },
      ],
      [],
    ],
    [
      'add unpublished column',
      'ALTER TABLE foo ADD "newInt" INT4;',
      [], // no DDL event published
      [
        // the view of "foo" is unchanged.
        {
          name: 'foo',
          columns: {
            id: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            int: {
              characterMaximumLength: null,
              dataType: 'int4',
              dflt: null,
              notNull: false,
              pos: 2,
            },
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 3,
            },
          },
          primaryKey: ['id'],
        },
      ],
      [],
    ],
    [
      'alter publication add and drop column',
      'ALTER PUBLICATION zero_some_public SET TABLE foo (id, "newInt");',
      [
        // Since it is an ALTER PUBLICATION command, we should correctly get
        // a drop and an add, and not a rename.
        {
          tag: 'drop-column',
          table: {schema: 'public', name: 'foo'},
          column: 'int',
        },
        {
          tag: 'add-column',
          table: {schema: 'public', name: 'foo'},
        },
      ],
      [
        {
          name: 'foo',
          columns: {
            id: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 2,
            },
            newInt: {
              characterMaximumLength: null,
              dataType: 'int4',
              dflt: null,
              notNull: false,
              pos: 3,
            },
          },
          primaryKey: ['id'],
        },
      ],
      [],
    ],
    [
      'alter publication add multiple columns',
      'ALTER PUBLICATION zero_some_public SET TABLE foo (id, "newInt", int, flt);',
      [
        {
          tag: 'add-column',
          table: {schema: 'public', name: 'foo'},
        },
        {
          tag: 'add-column',
          table: {schema: 'public', name: 'foo'},
        },
      ],
      [
        {
          name: 'foo',
          columns: {
            id: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 2,
            },
            newInt: {
              characterMaximumLength: null,
              dataType: 'int4',
              dflt: null,
              notNull: false,
              pos: 3,
            },
            flt: {
              characterMaximumLength: null,
              dataType: 'float8',
              dflt: null,
              notNull: false,
              pos: 4,
            },
            int: {
              characterMaximumLength: null,
              dataType: 'int4',
              dflt: null,
              notNull: false,
              pos: 5,
            },
          },
          primaryKey: ['id'],
        },
      ],
      [],
    ],
    [
      'create unpublished table with indexes',
      'CREATE TABLE public.boo (id INT8 PRIMARY KEY, name TEXT UNIQUE);',
      [],
      [],
      [],
    ],
    [
      'alter publication introduces table with indexes and changes columns',
      'ALTER PUBLICATION zero_some_public SET TABLE foo (id, flt), boo;',
      [
        {tag: 'drop-column'},
        {tag: 'drop-column'},
        {tag: 'create-table'},
        {tag: 'create-index'},
      ],
      [
        {
          name: 'foo',
          columns: {
            id: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 2,
            },
            flt: {
              characterMaximumLength: null,
              dataType: 'float8',
              dflt: null,
              notNull: false,
              pos: 3,
            },
          },
          primaryKey: ['id'],
        },
        {
          name: 'boo',
          columns: {
            id: {
              characterMaximumLength: null,
              dataType: 'int8',
              dflt: null,
              notNull: true,
              pos: 1,
            },
            name: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: false,
              pos: 2,
            },
            ['_0_version']: {
              characterMaximumLength: null,
              dataType: 'TEXT',
              dflt: null,
              notNull: true,
              pos: 3,
            },
          },
          primaryKey: ['id'],
        },
      ],
      [
        {
          name: 'boo_name_key',
          tableName: 'boo',
          columns: {name: 'ASC'},
          unique: true,
        },
      ],
    ],
    [
      'create index',
      'CREATE INDEX foo_flt ON foo (flt DESC);',
      [{tag: 'create-index'}],
      [],
      [
        {
          name: 'foo_flt',
          tableName: 'foo',
          columns: {flt: 'DESC'},
          unique: false,
        },
      ],
    ],
    [
      'drop index',
      'DROP INDEX foo_flt;',
      [
        {
          tag: 'drop-index',
          id: {schema: 'public', name: 'foo_flt'},
        },
      ],
      [],
      [],
    ],
    [
      'remove table (with indexes) from publication',
      `ALTER PUBLICATION zero_some_public DROP TABLE boo`,
      [
        {
          tag: 'drop-index',
          id: {schema: 'public', name: 'boo_name_key'},
        },
        {
          tag: 'drop-table',
          id: {schema: 'public', name: 'boo'},
        },
      ],
      [],
      [],
    ],
  ] satisfies [
    name: string,
    statements: string,
    changes: Partial<DataChange>[],
    expectedTables: LiteTableSpec[],
    expectedIndexes: LiteIndexSpec[],
  ][])('%s', async (name, stmts, changes, expectedTables, expectedIndexes) => {
    if (name.startsWith('DISABLED: ')) {
      lc.info?.('skipping test:', name);
      return;
    }
    await upstream.unsafe(stmts);
    const transaction = await nextTransaction();
    expect(transaction.length).toBe(changes.length);

    transaction.forEach((change, i) => {
      expect(change).toMatchObject(changes[i]);
    });

    const tables = listTables(replica);
    for (const table of expectedTables) {
      expect(tables).toContainEqual(table);
    }
    const indexes = listIndexes(replica);
    for (const index of expectedIndexes) {
      expect(indexes).toContainEqual(index);
    }
  });
});