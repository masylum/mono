import {expect, test} from 'vitest';
import type {ExperimentalNoIndexDiff} from '../../../replicache/src/mod.js';
import {assert} from '../../../shared/src/asserts.js';
import {Catch} from '../../../zql/src/ivm/catch.js';
import {Join} from '../../../zql/src/ivm/join.js';
import {MemorySource} from '../../../zql/src/ivm/memory-source.js';
import {MemoryStorage} from '../../../zql/src/ivm/memory-storage.js';
import {type AddQuery, ZeroContext} from './context.js';
import {ENTITIES_KEY_PREFIX} from './keys.js';

const testBatchViewUpdates = (applyViewUpdates: () => void) =>
  applyViewUpdates();

test('getSource', () => {
  const schemas = {
    users: {
      tableName: 'users',
      columns: {
        id: {type: 'string'},
        name: {type: 'string'},
      },
      primaryKey: ['id'],
    },
    userStates: {
      tableName: 'userStates',
      columns: {
        userID: {type: 'string'},
        stateCode: {type: 'string'},
      },
      primaryKey: ['userID', 'stateCode'],
    },
  } as const;

  const context = new ZeroContext(
    schemas,
    null as unknown as AddQuery,
    testBatchViewUpdates,
  );

  const source = context.getSource('users');
  assert(source instanceof MemorySource);
  expect(source.getSchemaInfo()).toMatchInlineSnapshot(`
    {
      "columns": {
        "id": {
          "optional": false,
          "type": "string",
        },
        "name": {
          "optional": false,
          "type": "string",
        },
      },
      "primaryKey": [
        "id",
      ],
      "tableName": "users",
    }
  `);

  // Calling again should cache first value.
  expect(context.getSource('users')).toBe(source);

  expect(context.getSource('nonexistent')).toBeUndefined();

  // Should work for other table too.
  const source2 = context.getSource('userStates');
  expect((source2 as MemorySource).getSchemaInfo()).toMatchInlineSnapshot(`
    {
      "columns": {
        "stateCode": {
          "optional": false,
          "type": "string",
        },
        "userID": {
          "optional": false,
          "type": "string",
        },
      },
      "primaryKey": [
        "userID",
        "stateCode",
      ],
      "tableName": "userStates",
    }
  `);
});

test('processChanges', () => {
  const schemas = {
    t1: {
      tableName: 't1',
      columns: {
        id: {type: 'string'},
        name: {type: 'string'},
      },
      primaryKey: ['id'],
    } as const,
  };

  const context = new ZeroContext(
    schemas,
    null as unknown as AddQuery,
    testBatchViewUpdates,
  );
  const out = new Catch(
    context.getSource('t1')!.connect([
      ['name', 'desc'],
      ['id', 'desc'],
    ]),
  );

  context.processChanges([
    {
      key: `${ENTITIES_KEY_PREFIX}t1/e1`,
      op: 'add',
      newValue: {id: 'e1', name: 'name1'},
    },
    {
      key: `${ENTITIES_KEY_PREFIX}t1/e2`,
      op: 'add',
      newValue: {id: 'e2', name: 'name2'},
    },
    {
      key: `${ENTITIES_KEY_PREFIX}t1/e1`,
      op: 'change',
      oldValue: {id: 'e1', name: 'name1'},
      newValue: {id: 'e1', name: 'name1.1'},
    },
  ]);

  expect(out.pushes).toEqual([
    {type: 'add', node: {row: {id: 'e1', name: 'name1'}, relationships: {}}},
    {type: 'add', node: {row: {id: 'e2', name: 'name2'}, relationships: {}}},
    {
      type: 'edit',
      oldRow: {id: 'e1', name: 'name1'},
      row: {id: 'e1', name: 'name1.1'},
    },
  ]);

  expect(out.fetch({})).toEqual([
    {row: {id: 'e2', name: 'name2'}, relationships: {}},
    {row: {id: 'e1', name: 'name1.1'}, relationships: {}},
  ]);
});

test('processChanges wraps source updates with batchViewUpdates', () => {
  const schemas = {
    t1: {
      tableName: 't1',
      columns: {
        id: {type: 'string'},
        name: {type: 'string'},
      },
      primaryKey: ['id'],
    } as const,
  };
  let batchViewUpdatesCalls = 0;
  const batchViewUpdates = (applyViewUpdates: () => void) => {
    batchViewUpdatesCalls++;
    expect(out.pushes).toEqual([]);
    applyViewUpdates();
    expect(out.pushes).toEqual([
      {type: 'add', node: {row: {id: 'e1', name: 'name1'}, relationships: {}}},
      {type: 'add', node: {row: {id: 'e2', name: 'name2'}, relationships: {}}},
      {
        type: 'edit',
        oldRow: {id: 'e1', name: 'name1'},
        row: {id: 'e1', name: 'name1.1'},
      },
    ]);
  };
  const context = new ZeroContext(
    schemas,
    null as unknown as AddQuery,
    batchViewUpdates,
  );
  const out = new Catch(
    context.getSource('t1')!.connect([
      ['name', 'desc'],
      ['id', 'desc'],
    ]),
  );

  expect(batchViewUpdatesCalls).toBe(0);
  context.processChanges([
    {
      key: `${ENTITIES_KEY_PREFIX}t1/e1`,
      op: 'add',
      newValue: {id: 'e1', name: 'name1'},
    },
    {
      key: `${ENTITIES_KEY_PREFIX}t1/e2`,
      op: 'add',
      newValue: {id: 'e2', name: 'name2'},
    },
    {
      key: `${ENTITIES_KEY_PREFIX}t1/e1`,
      op: 'change',
      oldValue: {id: 'e1', name: 'name1'},
      newValue: {id: 'e1', name: 'name1.1'},
    },
  ]);
  expect(batchViewUpdatesCalls).toBe(1);
});

test('transactions', () => {
  const schemas = {
    server: {
      tableName: 'server',
      columns: {
        id: {type: 'string'},
      },
      primaryKey: ['id'],
    },
    flair: {
      tableName: 'flair',
      columns: {
        id: {type: 'string'},
        serverID: {type: 'string'},
        description: {type: 'string'},
      },
      primaryKey: ['id'],
    },
  } as const;

  const context = new ZeroContext(
    schemas,
    null as unknown as AddQuery,
    testBatchViewUpdates,
  );
  const servers = context.getSource('server')!;
  const flair = context.getSource('flair')!;
  const join = new Join({
    parent: servers.connect([['id', 'asc']]),
    child: flair.connect([['id', 'asc']]),
    storage: new MemoryStorage(),
    parentKey: ['id'],
    childKey: ['serverID'],
    hidden: false,
    relationshipName: 'flair',
    system: 'client',
  });
  const out = new Catch(join);

  const changes: ExperimentalNoIndexDiff = [
    {
      key: `${ENTITIES_KEY_PREFIX}server/s1`,
      op: 'add',
      newValue: {id: 's1', name: 'joanna'},
    },
    {
      key: `${ENTITIES_KEY_PREFIX}server/s2`,
      op: 'add',
      newValue: {id: 's2', name: 'brian'},
    },
    ...new Array(15).fill(0).map((_, i) => ({
      key: `${ENTITIES_KEY_PREFIX}flair/f${i}`,
      op: 'add' as const,
      newValue: {id: `f${i}`, serverID: 's1', description: `desc${i}`},
    })),
    ...new Array(37).fill(0).map((_, i) => ({
      key: `${ENTITIES_KEY_PREFIX}flair/f${15 + i}`,
      op: 'add' as const,
      newValue: {
        id: `f${15 + i}`,
        serverID: 's2',
        description: `desc${15 + i}`,
      },
    })),
  ];

  let transactions = 0;

  const remove = context.onTransactionCommit(() => {
    ++transactions;
  });
  remove();

  context.onTransactionCommit(() => {
    ++transactions;
  });

  context.processChanges(changes);

  expect(transactions).toEqual(1);
  const result = out.fetch({});
  expect(result).length(2);
  expect(result[0].row).toEqual({id: 's1', name: 'joanna'});
  expect(result[0].relationships.flair).length(15);
  expect(result[1].row).toEqual({id: 's2', name: 'brian'});
  expect(result[1].relationships.flair).length(37);
});

test('batchViewUpdates errors if applyViewUpdates is not called', () => {
  const schemas = {
    t1: {
      tableName: 't1',
      columns: {
        id: {type: 'string'},
        name: {type: 'string'},
      },
      primaryKey: ['id'],
    } as const,
  };
  let batchViewUpdatesCalls = 0;
  const batchViewUpdates = (_applyViewUpdates: () => void) => {
    batchViewUpdatesCalls++;
  };
  const context = new ZeroContext(
    schemas,
    null as unknown as AddQuery,
    batchViewUpdates,
  );

  expect(batchViewUpdatesCalls).toEqual(0);
  expect(() => context.batchViewUpdates(() => {})).toThrowError();
  expect(batchViewUpdatesCalls).toEqual(1);
});

test('batchViewUpdates returns value', () => {
  const schemas = {
    t1: {
      tableName: 't1',
      columns: {
        id: {type: 'string'},
        name: {type: 'string'},
      },
      primaryKey: ['id'],
    } as const,
  };
  let batchViewUpdatesCalls = 0;
  const batchViewUpdates = (applyViewUpdates: () => void) => {
    applyViewUpdates();
    batchViewUpdatesCalls++;
  };
  const context = new ZeroContext(
    schemas,
    null as unknown as AddQuery,
    batchViewUpdates,
  );

  expect(batchViewUpdatesCalls).toEqual(0);
  expect(context.batchViewUpdates(() => 'test value')).toEqual('test value');
  expect(batchViewUpdatesCalls).toEqual(1);
});
