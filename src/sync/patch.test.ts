import {LogContext} from '@rocicorp/logger';
import {expect} from '@esm-bundle/chai';
import * as dag from '../dag/mod.js';
import * as db from '../db/mod.js';
import type {JSONValue} from '../json.js';
import {ChainBuilder} from '../db/test-helpers.js';
import {apply} from './patch.js';
import {assertPatchOperations} from '../puller.js';

suite('patch', () => {
  const t = async (dd31: boolean) => {
    const clientID = 'client-id';
    const store = new dag.TestStore();
    const lc = new LogContext();

    type Case = {
      name: string;
      patch: JSONValue;
      expErr?: string | undefined;
      // Note: the test inserts "key" => "value" into the map prior to
      // calling apply() so we can check if top-level removes work.
      expMap?: Map<string, string> | undefined;
    };
    const cases: Case[] = [
      {
        name: 'put',
        patch: [{op: 'put', key: 'foo', value: 'bar'}],
        expErr: undefined,
        expMap: new Map([
          ['key', 'value'],
          ['foo', 'bar'],
        ]),
      },
      {
        name: 'del',
        patch: [{op: 'del', key: 'key'}],
        expErr: undefined,
        expMap: new Map(),
      },
      {
        name: 'replace',
        patch: [{op: 'put', key: 'key', value: 'newvalue'}],
        expErr: undefined,
        expMap: new Map([['key', 'newvalue']]),
      },
      {
        name: 'put empty key',
        patch: [{op: 'put', key: '', value: 'empty'}],
        expErr: undefined,
        expMap: new Map([
          ['key', 'value'],
          ['', 'empty'],
        ]),
      },
      {
        name: 'put/replace empty key',
        patch: [
          {op: 'put', key: '', value: 'empty'},
          {op: 'put', key: '', value: 'changed'},
        ],
        expErr: undefined,
        expMap: new Map([
          ['key', 'value'],
          ['', 'changed'],
        ]),
      },
      {
        name: 'put/remove empty key',
        patch: [
          {op: 'put', key: '', value: 'empty'},
          {op: 'del', key: ''},
        ],
        expErr: undefined,
        expMap: new Map([['key', 'value']]),
      },
      {
        name: 'top-level clear',
        patch: [{op: 'clear'}],
        expErr: undefined,
        expMap: new Map(),
      },
      {
        name: 'compound ops',
        patch: [
          {op: 'put', key: 'foo', value: 'bar'},
          {op: 'put', key: 'key', value: 'newvalue'},
          {op: 'put', key: 'baz', value: 'baz'},
        ],
        expErr: undefined,
        expMap: new Map([
          ['foo', 'bar'],
          ['key', 'newvalue'],
          ['baz', 'baz'],
        ]),
      },
      {
        name: 'no escaping 1',
        patch: [{op: 'put', key: '~1', value: 'bar'}],
        expErr: undefined,
        expMap: new Map([
          ['key', 'value'],
          ['~1', 'bar'],
        ]),
      },
      {
        name: 'no escaping 2',
        patch: [{op: 'put', key: '~0', value: 'bar'}],
        expErr: undefined,
        expMap: new Map([
          ['key', 'value'],
          ['~0', 'bar'],
        ]),
      },
      {
        name: 'no escaping 3',
        patch: [{op: 'put', key: '/', value: 'bar'}],
        expErr: undefined,
        expMap: new Map([
          ['key', 'value'],
          ['/', 'bar'],
        ]),
      },
      {
        name: 'invalid op',
        patch: [{op: 'BOOM', key: 'key'}],
        expErr:
          'unknown patch op `BOOM`, expected one of `put`, `del`, `clear`',
        expMap: undefined,
      },
      {
        name: 'invalid key',
        patch: [{op: 'put', key: 42, value: true}],
        expErr: 'Invalid type: number `42`, expected string',
        expMap: undefined,
      },
      {
        name: 'missing value',
        patch: [{op: 'put', key: 'k'}],
        // expErr: 'missing field `value`',
        expErr: 'Invalid type: undefined, expected JSON value',
        expMap: undefined,
      },
      {
        name: 'missing key for del',
        patch: [{op: 'del'}],
        // expErr: 'missing field `key`',
        expErr: 'Invalid type: undefined, expected string',
        expMap: undefined,
      },
      {
        name: 'make sure we do not apply parts of the patch',
        patch: [{op: 'put', key: 'k', value: 42}, {op: 'del'}],
        // expErr: 'missing field `key`',
        expErr: 'Invalid type: undefined, expected string',
        expMap: new Map([['key', 'value']]),
      },
    ];

    for (const c of cases) {
      const b = new ChainBuilder(store, undefined, dd31);
      await b.addGenesis(clientID);
      await store.withWrite(async dagWrite => {
        let dbWrite;
        if (dd31) {
          dbWrite = await db.newWriteSnapshotDD31(
            db.whenceHash(b.chain[0].chunk.hash),
            {[clientID]: 1},
            'cookie',
            dagWrite,
            db.readIndexesForWrite(b.chain[0], dagWrite),
            clientID,
          );
        } else {
          dbWrite = await db.newWriteSnapshotSDD(
            db.whenceHash(b.chain[0].chunk.hash),
            1,
            'cookie',
            dagWrite,
            db.readIndexesForWrite(b.chain[0], dagWrite),
            clientID,
          );
        }
        await dbWrite.put(lc, 'key', 'value');

        const ops = c.patch;

        let err;
        try {
          assertPatchOperations(ops);
          await apply(lc, dbWrite, ops);
        } catch (e) {
          err = e;
        }
        if (c.expErr) {
          expect(err).to.be.instanceOf(Error);
          expect((err as Error).message).to.equal(c.expErr);
        }

        if (c.expMap !== undefined) {
          for (const [k, v] of c.expMap) {
            expect(v).to.deep.equal(await dbWrite.get(k));
          }
          if (c.expMap.size === 0) {
            expect(await dbWrite.has('key')).to.be.false;
          }
        }
      });
    }
  };

  test('dd31', () => t(true));
  test('sdd', () => t(false));
});
