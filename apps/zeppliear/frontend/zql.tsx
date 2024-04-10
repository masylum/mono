import {EntityQuery, makeReplicacheContext} from '@rocicorp/zql/src/index.js';
import type {ReplicacheLike} from '@rocicorp/zql/src/replicache-like.js';
import type {Context} from '@rocicorp/zql/src/zql/context/context.js';
import type {FromSet} from '@rocicorp/zql/src/zql/query/entity-query.js';
import {useEffect, useMemo, useRef, useState} from 'react';

export function useQuery<From extends FromSet, Return>(
  q: EntityQuery<From, Return>,
  dependencies: unknown[] = [],
): Return {
  const [snapshot, setSnapshot] = useState([] as Return);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const statement = useMemo(() => q.prepare(), dependencies);
  const unsubscribe = useRef<() => void>(() => {});

  useEffect(() => {
    let unloaded = false;
    void statement.exec().then(v => {
      if (!unloaded) {
        setSnapshot(v as Return);
        unsubscribe.current = statement.subscribe(v =>
          setSnapshot(v as Return),
        );
      }
    });
    return () => {
      unloaded = true;
      unsubscribe.current();
      statement.destroy();
    };
  }, [statement]);

  return snapshot;
}

const contextsMap = new Map<ReplicacheLike, Context>();

export function getContext(rep: ReplicacheLike): Context {
  const existing = contextsMap.get(rep);
  if (existing) {
    return existing;
  }
  const ctx = makeReplicacheContext(rep);
  contextsMap.set(rep, ctx);
  return ctx;
}

// Cache EntityQuery instances so that we don't create a new one every time
// we call getQuery.
const queriesMap = new WeakMap<
  ReplicacheLike,
  Map<string, EntityQuery<FromSet>>
>();

export function getQuery<From extends FromSet>(
  zero: ReplicacheLike,
  name: string,
): EntityQuery<From> {
  let map = queriesMap.get(zero);
  if (!map) {
    map = new Map();
    queriesMap.set(zero, map);
  }
  const existing = map.get(name);
  if (existing) {
    return existing as EntityQuery<From>;
  }
  const context = getContext(zero);
  const q = new EntityQuery<From>(context, name);
  map.set(name, q as EntityQuery<FromSet>);
  return q;
}
