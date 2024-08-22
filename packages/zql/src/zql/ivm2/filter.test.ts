import {expect, test} from 'vitest';
import {MemorySource} from './memory-source.js';
import {Filter} from './filter.js';
import {Catch} from './catch.js';

test('basics', () => {
  const ms = new MemorySource({a: 'number', b: 'string'}, ['a']);
  ms.push({type: 'add', row: {a: 3, b: 'foo'}});
  ms.push({type: 'add', row: {a: 2, b: 'bar'}});
  ms.push({type: 'add', row: {a: 1, b: 'foo'}});

  const filter = new Filter(ms, row => row.b === 'foo');
  ms.addOutput(filter, [['a', 'asc']]);

  const out = new Catch(filter);
  filter.setOutput(out);

  expect(out.hydrate()).toEqual([
    {row: {a: 1, b: 'foo'}, relationships: {}},
    {row: {a: 3, b: 'foo'}, relationships: {}},
  ]);

  ms.push({type: 'add', row: {a: 4, b: 'bar'}});
  ms.push({type: 'add', row: {a: 5, b: 'foo'}});
  ms.push({type: 'remove', row: {a: 3, b: 'foo'}});
  ms.push({type: 'remove', row: {a: 2, b: 'bar'}});

  expect(out.pushes).toEqual([
    {
      type: 'add',
      node: {row: {a: 5, b: 'foo'}, relationships: {}},
    },
    {
      type: 'remove',
      node: {row: {a: 3, b: 'foo'}, relationships: {}},
    },
  ]);

  expect(out.dehydrate({})).toEqual([
    {
      row: {a: 1, b: 'foo'},
      relationships: {},
    },
    {
      row: {a: 5, b: 'foo'},
      relationships: {},
    },
  ]);
});
