import type { JSONType } from "../../src/protocol/json.js";
import type { Mutation } from "../../src/protocol/push.js";
import type { ClientMutation } from "../../src/types/client-mutation.js";
import type {
  ClientID,
  ClientState,
  Socket,
} from "../../src/types/client-state.js";
import type { NullableVersion } from "../../src/types/version.js";
import type { Logger, LogLevel } from "./logger.js";

export function client(
  id: ClientID,
  socket: Socket = new Mocket(),
  clockBehindByMs = 1,
  ...mutations: Mutation[]
): [ClientID, ClientState] {
  return [id, { clockBehindByMs, pending: mutations, socket }] as [
    string,
    ClientState
  ];
}

export function mutation(
  id: number,
  name = "foo",
  args: JSONType = [],
  timestamp = 1
): Mutation {
  return {
    id,
    name,
    args,
    timestamp,
  };
}

export function clientMutation(
  clientID: ClientID,
  id: number,
  name = "foo",
  args: JSONType = [],
  timestamp = 1
): ClientMutation {
  return {
    clientID,
    ...mutation(id, name, args, timestamp),
  };
}

export class Mocket extends EventTarget implements Socket {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  accept(): void {}
  log: string[][] = [];
  send(data: string): void {
    this.log.push(["send", data]);
  }
  close(): void {
    this.log.push(["close"]);
  }
  onclose: undefined;
  onmessage: undefined;
  readyState = 1;
}

export function clientRecord(
  baseCookie: NullableVersion = null,
  lastMutationID = 1
) {
  return {
    baseCookie,
    lastMutationID,
  };
}

export function userValue(value: JSONType, version = 1, deleted = false) {
  return {
    value,
    version,
    deleted,
  };
}

export function fail(s: string): never {
  throw new Error(s);
}

export class TestLogger implements Logger {
  messages: [LogLevel, ...unknown[]][] = [];

  log(level: LogLevel, ...args: unknown[]): void {
    this.messages.push([level, ...args]);
  }
}
