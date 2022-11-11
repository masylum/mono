/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { jest, afterEach, beforeEach, test, expect } from "@jest/globals";
import { encodeHeaderValue } from "../util/headers.js";
import { Mocket, TestLogSink } from "../util/test-utils.js";
import { USER_DATA_HEADER_NAME } from "./auth.js";
import {
  createTestDurableObjectNamespace,
  TestDurableObjectId,
  TestDurableObjectState,
  TestDurableObjectStub,
} from "./do-test-utils.js";
import { BaseAuthDO, ConnectionRecord } from "./auth-do.js";
import { createAuthAPIHeaders } from "./auth-api-headers.js";
import {
  type RoomRecord,
  roomRecordByRoomID as getRoomRecordOriginal,
  roomRecordByObjectID as getRoomRecordByObjectIDOriginal,
  RoomStatus,
} from "./rooms.js";
import { DurableStorage } from "../storage/durable-storage.js";
import { roomRecordsPath, roomStatusByRoomIDPath } from "./auth-do-routes.js";

const TEST_AUTH_API_KEY = "TEST_REFLECT_AUTH_API_KEY_TEST";
const { authDO } = getMiniflareBindings();
const authDOID = authDO.idFromName("auth");

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function isAuthRequest(request: Request) {
  return request.url.indexOf("/api/auth/") !== -1;
}

function newCreateRoomRequest(roomID: string) {
  return new Request(`https://test.roci.dev/createRoom`, {
    method: "post",
    headers: createAuthAPIHeaders(TEST_AUTH_API_KEY),
    body: JSON.stringify({
      roomID,
    }),
  });
}

async function createCreateRoomTestFixture() {
  const testRoomID = "testRoomID1";

  const testRequest = newCreateRoomRequest(testRoomID);

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);

  const roomDOcreateRoomCounts = new Map<
    string, // objectIDString
    number
  >();
  let roomNum = 0;
  const testRoomDO: DurableObjectNamespace = {
    ...createTestDurableObjectNamespace(),
    idFromName: () => {
      throw "should not be called";
    },
    newUniqueId: () => {
      return new TestDurableObjectId("unique-room-do-" + roomNum++);
    },
    get: (id: DurableObjectId) => {
      const objectIDString = id.toString();

      return new TestDurableObjectStub(id, async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/createRoom") {
          const count = roomDOcreateRoomCounts.get(objectIDString) || 0;
          roomDOcreateRoomCounts.set(objectIDString, count + 1);
          return new Response();
        }
        return new Response("", { status: 200 });
      });
    },
  };

  return {
    testRoomID,
    testRequest,
    testRoomDO,
    state,
    roomDOcreateRoomCounts,
  };
}

test("createRoom creates a room and doesn't allow it to be re-created", async () => {
  const { testRoomID, testRequest, testRoomDO, state, roomDOcreateRoomCounts } =
    await createCreateRoomTestFixture();

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async () => {
      throw "should not be called";
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });

  // Create the room for the first time.
  const response = await authDO.fetch(testRequest);

  expect(roomDOcreateRoomCounts.size).toEqual(1);
  const rr = await getRoomRecord(state.storage, testRoomID);
  expect(rr).not.toBeUndefined();
  const roomRecord = rr as RoomRecord;
  expect(roomRecord.objectIDString).toEqual("unique-room-do-0");
  expect(roomDOcreateRoomCounts.get(roomRecord.objectIDString)).toEqual(1);
  expect(response.status).toEqual(200);

  // Attempt to create the room again.
  const response2 = await authDO.fetch(testRequest);
  expect(response2.status).toEqual(400);
  expect(roomDOcreateRoomCounts.size).toEqual(1);
});

// Tiny wrappers that hide the conversion from raw DO storage to DurableStorage.
async function getRoomRecord(storage: DurableObjectStorage, roomID: string) {
  return getRoomRecordOriginal(new DurableStorage(storage, false), roomID);
}

async function getRoomRecordByObjectID(
  storage: DurableObjectStorage,
  objectID: DurableObjectId
) {
  return getRoomRecordByObjectIDOriginal(
    new DurableStorage(storage, false),
    objectID
  );
}

test("createRoom returns 401 if authApiKey is wrong", async () => {
  const { testRoomID, testRequest, testRoomDO, state, roomDOcreateRoomCounts } =
    await createCreateRoomTestFixture();

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async () => {
      throw "should not be called";
    },
    authApiKey: "SOME OTHER API KEY",
    logSink: new TestLogSink(),
    logLevel: "debug",
  });

  const response = await authDO.fetch(testRequest);

  expect(response.status).toEqual(401);
  expect(roomDOcreateRoomCounts.size).toEqual(0);
  const rr = await getRoomRecord(state.storage, testRoomID);
  expect(rr).toBeUndefined();
});

test("createRoom returns 500 if roomDO createRoom fails", async () => {
  const { testRoomID, testRequest, testRoomDO, state } =
    await createCreateRoomTestFixture();

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async () => {
      throw "should not be called";
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });

  // Override the roomDO to return a 500.
  testRoomDO.get = (id: DurableObjectId) => {
    return new TestDurableObjectStub(id, async () => {
      return new Response("", { status: 500 });
    });
  };

  const response = await authDO.fetch(testRequest);

  expect(response.status).toEqual(500);
  const rr = await getRoomRecord(state.storage, testRoomID);
  expect(rr).toBeUndefined();
});

function newRoomStatusByRoomIDRequest(roomID: string) {
  const path = roomStatusByRoomIDPath.replace(":roomID", roomID);
  return new Request(`https://test.roci.dev${path}`, {
    method: "get",
    headers: createAuthAPIHeaders(TEST_AUTH_API_KEY),
  });
}

test("roomStatusByRoomID returns status for a room that exists", async () => {
  const { testRoomID, testRequest, testRoomDO, state } =
    await createCreateRoomTestFixture();

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async () => {
      throw "should not be called";
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });

  const response = await authDO.fetch(testRequest);
  expect(response.status).toEqual(200);

  const statusRequest = newRoomStatusByRoomIDRequest(testRoomID);
  const statusResponse = await authDO.fetch(statusRequest);
  expect(statusResponse.status).toEqual(200);
  expect(await statusResponse.json()).toMatchObject({
    status: RoomStatus.Open,
  });
});

test("roomStatusByRoomID returns unknown for a room that does not exist", async () => {
  const { testRoomDO, state } = await createCreateRoomTestFixture();

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async () => {
      throw "should not be called";
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });

  const statusRequest = newRoomStatusByRoomIDRequest("no-such-room");
  const statusResponse = await authDO.fetch(statusRequest);
  expect(statusResponse.status).toEqual(200);
  expect(await statusResponse.json()).toMatchObject({
    status: RoomStatus.Unknown,
  });
});

test("roomStatusByRoomID requires authApiKey", async () => {
  const { testRoomDO, state } = await createCreateRoomTestFixture();

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async () => {
      throw "should not be called";
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });

  const path = roomStatusByRoomIDPath.replace(":roomID", "abc123");
  const statusRequest = new Request(`https://test.roci.dev${path}`, {
    method: "get",
    // No auth header.
  });

  const statusResponse = await authDO.fetch(statusRequest);
  expect(statusResponse.status).toEqual(401);
});

function newRoomRecordsRequest() {
  return new Request(`https://test.roci.dev${roomRecordsPath}`, {
    method: "get",
    headers: createAuthAPIHeaders(TEST_AUTH_API_KEY),
  });
}

test("roomRecords returns empty array if no rooms exist", async () => {
  const { testRoomDO, state } = await createCreateRoomTestFixture();

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async () => {
      throw "should not be called";
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });

  const roomRecordsRequest = newRoomRecordsRequest();
  const roomRecordsResponse = await authDO.fetch(roomRecordsRequest);
  expect(roomRecordsResponse.status).toEqual(200);
  const gotRecords = await roomRecordsResponse.json();
  expect(gotRecords).toEqual([]);
});

test("roomRecords returns rooms that exists", async () => {
  const { testRoomDO, state } = await createCreateRoomTestFixture();

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async () => {
      throw "should not be called";
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });
  await createRoom(authDO, "1");
  await createRoom(authDO, "2");
  await createRoom(authDO, "3");

  const roomRecordsRequest = newRoomRecordsRequest();
  const roomRecordsResponse = await authDO.fetch(roomRecordsRequest);
  expect(roomRecordsResponse.status).toEqual(200);
  const gotRecords = await roomRecordsResponse.json();
  expect(gotRecords).toMatchObject([
    { roomID: "1" },
    { roomID: "2" },
    { roomID: "3" },
  ]);
});

test("roomRecords requires authApiKey", async () => {
  const { testRoomDO, state } = await createCreateRoomTestFixture();

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async () => {
      throw "should not be called";
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });
  await createRoom(authDO, "1");

  const roomRecordsRequest = new Request(
    `https://test.roci.dev${roomRecordsPath}`,
    {
      method: "get",
      // No auth header.
    }
  );
  const roomRecordsResponse = await authDO.fetch(roomRecordsRequest);
  expect(roomRecordsResponse.status).toEqual(401);
});

function createConnectTestFixture(
  options: {
    testUserID?: string;
    testRoomID?: string;
    testClientID?: string;
  } = {}
) {
  const {
    testUserID = "testUserID1",
    testRoomID = "testRoomID1",
    testClientID = "testClientID1",
  } = options;
  const encodedTestAuth = "test%20auth%20token%20value%20%25%20encoded";
  const testAuth = "test auth token value % encoded";

  const headers = new Headers();
  headers.set("Sec-WebSocket-Protocol", encodedTestAuth);
  const testRequest = new Request(
    `ws://test.roci.dev/connect?roomID=${testRoomID}&clientID=${testClientID}`,
    {
      headers,
    }
  );

  const mocket = new Mocket();

  let numRooms = 0;
  const testRoomDO: DurableObjectNamespace = {
    ...createTestDurableObjectNamespace(),
    idFromName: () => {
      throw "should not be called";
    },
    newUniqueId: () => {
      return new TestDurableObjectId("room-do-" + numRooms++);
    },
    get: (id: DurableObjectId) => {
      expect(id.toString()).toEqual("room-do-0");
      return new TestDurableObjectStub(id, async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/createRoom") {
          return new Response();
        }
        expect(request.url).toEqual(testRequest.url);
        expect(request.headers.get(USER_DATA_HEADER_NAME)).toEqual(
          encodeHeaderValue(JSON.stringify({ userID: testUserID }))
        );
        expect(request.headers.get("Sec-WebSocket-Protocol")).toEqual(
          encodedTestAuth
        );
        return new Response(null, { status: 101, webSocket: mocket });
      });
    },
  };

  return {
    testAuth,
    testUserID,
    testRoomID,
    testClientID,
    testRequest,
    testRoomDO,
    mocket,
    encodedTestAuth,
  };
}

function createRoomDOThatThrowsIfFetchIsCalled(): DurableObjectNamespace {
  return {
    ...createTestDurableObjectNamespace(),
    get: (id: DurableObjectId) => {
      return new TestDurableObjectStub(id, async (request: Request) => {
        throw new Error("Unexpected call to Room DO fetch " + request.url);
      });
    },
  };
}

test("connect won't connect to a room that doesn't exist", async () => {
  const { testAuth, testUserID, testRoomID, testRequest, testRoomDO } =
    createConnectTestFixture();

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);
  const logSink = new TestLogSink();
  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (auth, roomID) => {
      expect(auth).toEqual(testAuth);
      expect(roomID).toEqual(testRoomID);
      return { userID: testUserID };
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink,
    logLevel: "debug",
  });
  // Note: no room created.

  const testTime = 1010101;
  jest.setSystemTime(testTime);
  const response = await authDO.fetch(testRequest);

  expect(response.status).toEqual(404);
  expect((await storage.list({ prefix: "connection/" })).size).toEqual(0);
});

test("connect calls authHandler and sends resolved UserData in header to Room DO", async () => {
  const {
    testAuth,
    testUserID,
    testRoomID,
    testRequest,
    testRoomDO,
    mocket,
    encodedTestAuth,
  } = createConnectTestFixture();

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);
  const logSink = new TestLogSink();
  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (auth, roomID) => {
      expect(auth).toEqual(testAuth);
      expect(roomID).toEqual(testRoomID);
      return { userID: testUserID };
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink,
    logLevel: "debug",
  });
  await createRoom(authDO, testRoomID);

  const testTime = 1010101;
  jest.setSystemTime(testTime);
  const response = await authDO.fetch(testRequest);

  expect(response.status).toEqual(101);
  expect(response.webSocket).toBe(mocket);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toEqual(
    encodedTestAuth
  );
  expect((await storage.list({ prefix: "connection/" })).size).toEqual(1);
  const connectionRecord = (await storage.get(
    "connection/testUserID1/testRoomID1/testClientID1/"
  )) as ConnectionRecord;
  expect(connectionRecord).toBeDefined();
  expect(connectionRecord.connectTimestamp).toEqual(testTime);
});

test("connect percent escapes components of the connection key", async () => {
  const {
    testAuth,
    testUserID,
    testRoomID,
    testRequest,
    testRoomDO,
    mocket,
    encodedTestAuth,
  } = createConnectTestFixture({
    testUserID: "/testUserID/?",
    testRoomID: "/testRoomID/=",
    testClientID: "/testClientID/&",
  });

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);
  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (auth, roomID) => {
      expect(auth).toEqual(testAuth);
      expect(roomID).toEqual(testRoomID);
      return { userID: testUserID };
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });
  await createRoom(authDO, testRoomID);

  const testTime = 1010101;
  jest.setSystemTime(testTime);
  const response = await authDO.fetch(testRequest);

  expect(response.status).toEqual(101);
  expect(response.webSocket).toBe(mocket);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toEqual(
    encodedTestAuth
  );
  expect((await storage.list({ prefix: "connection/" })).size).toEqual(1);
  const connectionRecord = (await storage.get(
    "connection/%2FtestUserID%2F%3F/%2FtestRoomID%2F%3D/%2FtestClientID%2F/"
  )) as ConnectionRecord;
  expect(connectionRecord).toBeDefined();
  expect(connectionRecord.connectTimestamp).toEqual(testTime);
});

test("connect returns a 401 without calling Room DO if authHandler rejects", async () => {
  const testRoomID = "testRoomID1";
  const testClientID = "testClientID1";
  const testAuth = "testAuthTokenValue";

  const headers = new Headers();
  headers.set("Sec-WebSocket-Protocol", testAuth);
  const testRequest = new Request(
    `ws://test.roci.dev/connect?roomID=${testRoomID}&clientID=${testClientID}`,
    {
      headers,
    }
  );
  const authDO = new BaseAuthDO({
    roomDO: createRoomDOThatThrowsIfFetchIsCalled(),
    state: { id: authDOID } as DurableObjectState,
    authHandler: async (auth, roomID) => {
      expect(auth).toEqual(testAuth);
      expect(roomID).toEqual(testRoomID);
      throw new Error("Test authHandler reject");
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });

  const response = await authDO.fetch(testRequest);

  expect(response.status).toEqual(401);
  expect(response.webSocket).toBeUndefined();
});

test("connect returns a 401 without calling Room DO if Sec-WebSocket-Protocol header is not present", async () => {
  const testRoomID = "testRoomID1";
  const testClientID = "testClientID1";

  const headers = new Headers();
  const testRequest = new Request(
    `ws://test.roci.dev/connect?roomID=${testRoomID}&clientID=${testClientID}`,
    {
      headers,
    }
  );

  const authDO = new BaseAuthDO({
    roomDO: createRoomDOThatThrowsIfFetchIsCalled(),
    state: { id: authDOID } as DurableObjectState,
    authHandler: async (_auth, _roomID) => {
      throw new Error("Unexpected call to authHandler");
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });

  const response = await authDO.fetch(testRequest);

  expect(response.status).toEqual(401);
  expect(response.webSocket).toBeUndefined();
});

test("authInvalidateForUser when requests to roomDOs are successful", async () => {
  const testUserID = "testUserID1";
  const testRequest = new Request(
    `https://test.roci.dev/api/auth/v0/invalidateForUser`,
    {
      method: "post",
      headers: createAuthAPIHeaders(TEST_AUTH_API_KEY),
      body: JSON.stringify({
        userID: testUserID,
      }),
    }
  );

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);
  await storage.put("connection/testUserID1/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID1/testClientID2/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID2/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID2/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });

  const roomDORequestCountsByRoomID = new Map();
  const testRoomDO: DurableObjectNamespace = {
    ...createTestDurableObjectNamespace(),
    get: (id: DurableObjectId) => {
      return new TestDurableObjectStub(id, async (request: Request) => {
        // We are only interested in auth requests. Plus, we can't get the RoomRecord
        // during the /createRoom call because it hasn't been written yet when /createRoom
        // is called!
        if (isAuthRequest(request)) {
          const roomRecord = (await getRoomRecordByObjectID(
            storage,
            id
          )) as RoomRecord;
          const { roomID } = roomRecord;
          roomDORequestCountsByRoomID.set(
            roomID,
            (roomDORequestCountsByRoomID.get(roomID) || 0) + 1
          );
          expect(request).toBe(testRequest);
        }
        return new Response("Test Success", { status: 200 });
      });
    },
  };

  const logSink = new TestLogSink();
  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (_auth, _roomID) => {
      throw new Error("Unexpected call to authHandler");
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink,
    logLevel: "debug",
  });
  await createRoom(authDO, "testRoomID1");
  await createRoom(authDO, "testRoomID2");

  const response = await authDO.fetch(testRequest);

  expect(roomDORequestCountsByRoomID.size).toEqual(2);
  expect(roomDORequestCountsByRoomID.get("testRoomID1")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID2")).toEqual(1);
  expect(response.status).toEqual(200);
});

test("authInvalidateForUser when connection ids have chars that need to be percent escaped", async () => {
  const testUserID = "/testUserID/?";
  const testRequest = new Request(
    `https://test.roci.dev/api/auth/v0/invalidateForUser`,
    {
      method: "post",
      headers: createAuthAPIHeaders(TEST_AUTH_API_KEY),
      body: JSON.stringify({
        userID: testUserID,
      }),
    }
  );

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);
  await storage.put(
    "connection/%2FtestUserID%2F%3F/%2FtestRoomID1%2F%3D/%2FtestClientID%2F/",
    {
      connectTimestamp: 1000,
    }
  );
  await storage.put(
    "connection/%2FtestUserID%2F%3F/%2FtestRoomID1%2F%3D/%2FtestClientID2%2F/",
    {
      connectTimestamp: 1000,
    }
  );
  await storage.put(
    "connection/%2FtestUserID%2F%3F/%2FtestRoomID2%2F%3D/%2FtestClientID%2F/",
    {
      connectTimestamp: 1000,
    }
  );
  await storage.put("connection/testUserID2/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });

  const roomDORequestCountsByRoomID = new Map();
  const testRoomDO: DurableObjectNamespace = {
    ...createTestDurableObjectNamespace(),
    get: (id: DurableObjectId) => {
      return new TestDurableObjectStub(id, async (request: Request) => {
        // We are only interested in auth requests.
        if (isAuthRequest(request)) {
          const { roomID } = (await getRoomRecordByObjectID(
            storage,
            id
          )) as RoomRecord;
          roomDORequestCountsByRoomID.set(
            roomID,
            (roomDORequestCountsByRoomID.get(roomID) || 0) + 1
          );
          expect(request).toBe(testRequest);
        }
        return new Response("Test Success", { status: 200 });
      });
    },
  };

  const logSink = new TestLogSink();
  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (_auth, _roomID) => {
      throw new Error("Unexpected call to authHandler");
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink,
    logLevel: "debug",
  });
  await createRoom(authDO, "/testRoomID1/=");
  await createRoom(authDO, "/testRoomID2/=");

  const response = await authDO.fetch(testRequest);

  expect(roomDORequestCountsByRoomID.size).toEqual(2);
  expect(roomDORequestCountsByRoomID.get("/testRoomID1/=")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("/testRoomID2/=")).toEqual(1);
  expect(response.status).toEqual(200);
});

test("authInvalidateForUser when any request to roomDOs returns error response", async () => {
  const testUserID = "testUserID1";
  const testRequest = new Request(
    `https://test.roci.dev/api/auth/v0/invalidateForUser`,
    {
      method: "post",
      headers: createAuthAPIHeaders(TEST_AUTH_API_KEY),
      body: JSON.stringify({
        userID: testUserID,
      }),
    }
  );

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);
  await storage.put("connection/testUserID1/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID2/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID3/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID2/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });

  const roomDORequestCountsByRoomID = new Map();
  const testRoomDO: DurableObjectNamespace = {
    ...createTestDurableObjectNamespace(),
    get: (id: DurableObjectId) => {
      return new TestDurableObjectStub(id, async (request: Request) => {
        // We are only interested in auth requests.
        if (isAuthRequest(request)) {
          const { roomID } = (await getRoomRecordByObjectID(
            storage,
            id
          )) as RoomRecord;
          roomDORequestCountsByRoomID.set(
            roomID,
            (roomDORequestCountsByRoomID.get(roomID) || 0) + 1
          );
          expect(request).toBe(testRequest);
          return roomID === "testRoomID2"
            ? new Response(
                "Test authInvalidateForUser Internal Server Error Msg",
                { status: 500 }
              )
            : new Response("Test Success", { status: 200 });
        }
        return new Response("ok", { status: 200 });
      });
    },
  };

  const logSink = new TestLogSink();
  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (_auth, _roomID) => {
      throw new Error("Unexpected call to authHandler");
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink,
    logLevel: "debug",
  });
  await createRoom(authDO, "testRoomID1");
  await createRoom(authDO, "testRoomID2");
  await createRoom(authDO, "testRoomID3");

  const response = await authDO.fetch(testRequest);

  expect(roomDORequestCountsByRoomID.size).toEqual(3);
  expect(roomDORequestCountsByRoomID.get("testRoomID1")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID2")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID3")).toEqual(1);
  expect(response.status).toEqual(500);
  expect(await response.text()).toEqual(
    "Test authInvalidateForUser Internal Server Error Msg"
  );
});

test("authInvalidateForRoom when request to roomDO is successful", async () => {
  const testRoomID = "testRoomID1";
  const testRequest = new Request(
    `https://test.roci.dev/api/auth/v0/invalidateForRoom`,
    {
      method: "post",
      headers: createAuthAPIHeaders(TEST_AUTH_API_KEY),
      body: JSON.stringify({
        roomID: testRoomID,
      }),
    }
  );

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);

  let roomDORequestCount = 0;
  let gotObjectId: DurableObjectId | undefined;
  const testRoomDO: DurableObjectNamespace = {
    ...createTestDurableObjectNamespace(),
    get: (id: DurableObjectId) => {
      gotObjectId = id;
      return new TestDurableObjectStub(id, async (request: Request) => {
        if (isAuthRequest(request)) {
          roomDORequestCount++;
          expect(request).toBe(testRequest);
        }
        return new Response("Test Success", { status: 200 });
      });
    },
  };
  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (_auth, _roomID) => {
      throw new Error("Unexpected call to authHandler");
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });
  await createRoom(authDO, testRoomID);

  const response = await authDO.fetch(testRequest);

  const { roomID } = (await getRoomRecordByObjectID(
    storage,
    gotObjectId!
  )) as RoomRecord;
  expect(roomID).toEqual(testRoomID);
  expect(roomDORequestCount).toEqual(1);
  expect(response.status).toEqual(200);
});

async function createRoom(authDO: BaseAuthDO, roomID: string) {
  const createRoomRequest = newCreateRoomRequest(roomID);
  const resp = await authDO.fetch(createRoomRequest);
  expect(resp.status).toEqual(200);
}

test("authInvalidateForRoom when request to roomDO returns error response", async () => {
  const testRoomID = "testRoomID1";
  const testRequest = new Request(
    `https://test.roci.dev/api/auth/v0/invalidateForRoom`,
    {
      method: "post",
      headers: createAuthAPIHeaders(TEST_AUTH_API_KEY),
      body: JSON.stringify({
        roomID: testRoomID,
      }),
    }
  );

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);

  let roomDORequestCount = 0;
  let gotObjectId: DurableObjectId | undefined;
  const testRoomDO: DurableObjectNamespace = {
    ...createTestDurableObjectNamespace(),
    get: (id: DurableObjectId) => {
      gotObjectId = id;
      return new TestDurableObjectStub(id, async (request: Request) => {
        if (isAuthRequest(request)) {
          roomDORequestCount++;
          expect(request).toBe(testRequest);
          return new Response(
            "Test authInvalidateForRoom Internal Server Error Msg",
            { status: 500 }
          );
        }
        return new Response("ok", { status: 200 });
      });
    },
  };

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (_auth, _roomID) => {
      throw new Error("Unexpected call to authHandler");
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });
  await createRoom(authDO, testRoomID);

  const response = await authDO.fetch(testRequest);

  const { roomID } = (await getRoomRecordByObjectID(
    storage,
    gotObjectId!
  )) as RoomRecord;
  expect(roomID).toEqual(testRoomID);
  expect(roomDORequestCount).toEqual(1);
  expect(response.status).toEqual(500);
  expect(await response.text()).toEqual(
    "Test authInvalidateForRoom Internal Server Error Msg"
  );
});

test("authInvalidateAll when requests to roomDOs are successful", async () => {
  const testRequest = new Request(
    `https://test.roci.dev/api/auth/v0/invalidateAll`,
    { headers: createAuthAPIHeaders(TEST_AUTH_API_KEY), method: "post" }
  );

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);
  await storage.put("connection/testUserID1/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID1/testClientID2/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID2/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID2/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID2/testRoomID3/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put(
    "connection/%2FtestUserID%2F%3F/%2FtestRoomID%2F%3D/%2FtestClientID%2F/",
    {
      connectTimestamp: 1000,
    }
  );

  const roomDORequestCountsByRoomID = new Map();
  const testRoomDO: DurableObjectNamespace = {
    ...createTestDurableObjectNamespace(),
    get: (id: DurableObjectId) => {
      return new TestDurableObjectStub(id, async (request: Request) => {
        if (isAuthRequest(request)) {
          const { roomID } = (await getRoomRecordByObjectID(
            storage,
            id
          )) as RoomRecord;
          roomDORequestCountsByRoomID.set(
            roomID,
            (roomDORequestCountsByRoomID.get(roomID) || 0) + 1
          );
          expect(request).toBe(testRequest);
        }
        return new Response("Test Success", { status: 200 });
      });
    },
  };

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (_auth, _roomID) => {
      throw new Error("Unexpected call to authHandler");
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });
  await createRoom(authDO, "testRoomID1");
  await createRoom(authDO, "testRoomID2");
  await createRoom(authDO, "testRoomID3");
  await createRoom(authDO, "/testRoomID/=");

  const response = await authDO.fetch(testRequest);

  expect(roomDORequestCountsByRoomID.size).toEqual(4);
  expect(roomDORequestCountsByRoomID.get("testRoomID1")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID2")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID3")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("/testRoomID/=")).toEqual(1);
  expect(response.status).toEqual(200);
});

test("authInvalidateAll when any request to roomDOs returns error response", async () => {
  const testRequest = new Request(
    `https://test.roci.dev/api/auth/v0/invalidateAll`,
    {
      headers: createAuthAPIHeaders(TEST_AUTH_API_KEY),
      method: "post",
    }
  );

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);
  await storage.put("connection/testUserID1/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID1/testClientID2/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID2/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID2/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID2/testRoomID3/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put(
    "connection/%2FtestUserID%2F%3F/%2FtestRoomID%2F%3D/%2FtestClientID%2F/",
    {
      connectTimestamp: 1000,
    }
  );

  const roomDORequestCountsByRoomID = new Map();
  const testRoomDO: DurableObjectNamespace = {
    ...createTestDurableObjectNamespace(),
    get: (id: DurableObjectId) => {
      return new TestDurableObjectStub(id, async (request: Request) => {
        if (isAuthRequest(request)) {
          const { roomID } = (await getRoomRecordByObjectID(
            storage,
            id
          )) as RoomRecord;
          roomDORequestCountsByRoomID.set(
            roomID,
            (roomDORequestCountsByRoomID.get(roomID) || 0) + 1
          );
          expect(request).toBe(testRequest);
          return roomID === "testRoomID2"
            ? new Response("Test authInvalidateAll Internal Server Error Msg", {
                status: 500,
              })
            : new Response("Test Success", { status: 200 });
        }
        return new Response("ok", { status: 200 });
      });
    },
  };

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (_auth, _roomID) => {
      throw new Error("Unexpected call to authHandler");
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });
  await createRoom(authDO, "testRoomID1");
  await createRoom(authDO, "testRoomID2");
  await createRoom(authDO, "testRoomID3");
  await createRoom(authDO, "/testRoomID/=");

  const response = await authDO.fetch(testRequest);

  expect(roomDORequestCountsByRoomID.size).toEqual(4);
  expect(roomDORequestCountsByRoomID.get("testRoomID1")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID2")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID3")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("/testRoomID/=")).toEqual(1);
  expect(response.status).toEqual(500);
  expect(await response.text()).toEqual(
    "Test authInvalidateAll Internal Server Error Msg"
  );
});

async function createRevalidateConnectionsTestFixture() {
  const testRequest = new Request(
    `https://test.roci.dev/api/auth/v0/revalidateConnections`,
    {
      headers: createAuthAPIHeaders(TEST_AUTH_API_KEY),
      method: "post",
    }
  );

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);
  await storage.put("connection/testUserID1/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID1/testClientID2/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID2/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID2/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID2/testRoomID3/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID3/testRoomID3/testClientID1/", {
    connectTimestamp: 1000,
  });

  const roomDORequestCountsByRoomID = new Map();
  const testRoomDO: DurableObjectNamespace = {
    ...createTestDurableObjectNamespace(),
    get: (id: DurableObjectId) => {
      return new TestDurableObjectStub(id, async (request: Request) => {
        if (isAuthRequest(request)) {
          const { roomID } = (await getRoomRecordByObjectID(
            storage,
            id
          )) as RoomRecord;
          roomDORequestCountsByRoomID.set(
            roomID,
            (roomDORequestCountsByRoomID.get(roomID) || 0) + 1
          );
          expect(request.url).toEqual(
            "https://unused-reflect-room-do.dev/api/auth/v0/connections"
          );
          switch (roomID) {
            case "testRoomID1":
              return new Response(
                JSON.stringify([
                  { userID: "testUserID1", clientID: "testClientID1" },
                  { userID: "testUserID2", clientID: "testClientID1" },
                ])
              );
            case "testRoomID2":
              return new Response(
                JSON.stringify([
                  { userID: "testUserID1", clientID: "testClientID1" },
                ])
              );
            case "testRoomID3":
              return new Response(JSON.stringify([]));
            default:
              throw new Error(`Unexpected roomID ${roomID}`);
          }
        }
        return new Response("ok", { status: 200 });
      });
    },
  };

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (_auth, _roomID) => {
      throw new Error("Unexpected call to authHandler");
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });
  await createRoom(authDO, "testRoomID1");
  await createRoom(authDO, "testRoomID2");
  await createRoom(authDO, "testRoomID3");
  return { authDO, testRequest, roomDORequestCountsByRoomID, storage };
}

test("revalidateConnections", async () => {
  const { authDO, testRequest, roomDORequestCountsByRoomID, storage } =
    await createRevalidateConnectionsTestFixture();

  const response = await authDO.fetch(testRequest);
  expect(response.status).toEqual(200);
  expect(roomDORequestCountsByRoomID.get("testRoomID1")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID2")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID3")).toEqual(1);

  expect([...(await storage.list({ prefix: "connection/" })).keys()]).toEqual([
    "connection/testUserID1/testRoomID1/testClientID1/",
    "connection/testUserID1/testRoomID2/testClientID1/",
    "connection/testUserID2/testRoomID1/testClientID1/",
  ]);
});

test("revalidateConnections continues if one storage delete throws an error", async () => {
  const { authDO, testRequest, roomDORequestCountsByRoomID, storage } =
    await createRevalidateConnectionsTestFixture();

  jest.spyOn(storage, "delete").mockImplementationOnce(() => {
    throw new Error("test delete error");
  });

  const response = await authDO.fetch(testRequest);
  expect(response.status).toEqual(200);
  expect(roomDORequestCountsByRoomID.get("testRoomID1")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID2")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID3")).toEqual(1);

  expect([...(await storage.list({ prefix: "connection/" })).keys()]).toEqual([
    "connection/testUserID1/testRoomID1/testClientID1/",
    "connection/testUserID1/testRoomID1/testClientID2/",
    "connection/testUserID1/testRoomID2/testClientID1/",
    "connection/testUserID2/testRoomID1/testClientID1/",
  ]);
});

test("revalidateConnections continues if one roomDO returns an error", async () => {
  const testRequest = new Request(
    `https://test.roci.dev/api/auth/v0/revalidateConnections`,
    {
      headers: createAuthAPIHeaders(TEST_AUTH_API_KEY),
      method: "post",
    }
  );

  const storage = await getMiniflareDurableObjectStorage(authDOID);
  const state = new TestDurableObjectState(authDOID, storage);
  await storage.put("connection/testUserID1/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID1/testClientID2/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID2/testRoomID1/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID1/testRoomID2/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID2/testRoomID3/testClientID1/", {
    connectTimestamp: 1000,
  });
  await storage.put("connection/testUserID3/testRoomID3/testClientID1/", {
    connectTimestamp: 1000,
  });

  const roomDORequestCountsByRoomID = new Map();
  const testRoomDO: DurableObjectNamespace = {
    ...createTestDurableObjectNamespace(),
    get: (id: DurableObjectId) => {
      return new TestDurableObjectStub(id, async (request: Request) => {
        if (isAuthRequest(request)) {
          const { roomID } = (await getRoomRecordByObjectID(
            storage,
            id
          )) as RoomRecord;
          roomDORequestCountsByRoomID.set(
            roomID,
            (roomDORequestCountsByRoomID.get(roomID) || 0) + 1
          );
          expect(request.url).toEqual(
            "https://unused-reflect-room-do.dev/api/auth/v0/connections"
          );
          switch (roomID) {
            case "testRoomID1":
              return new Response(
                "Test revalidateConnections Internal Server Error Msg",
                {
                  status: 500,
                }
              );
            case "testRoomID2":
              return new Response(
                JSON.stringify([
                  { userID: "testUserID1", clientID: "testClientID1" },
                ])
              );
            case "testRoomID3":
              return new Response(JSON.stringify([]));
            default:
              throw new Error(`Unexpected roomID ${roomID}`);
          }
        }
        return new Response("ok", { status: 200 });
      });
    },
  };

  const authDO = new BaseAuthDO({
    roomDO: testRoomDO,
    state,
    authHandler: async (_auth, _roomID) => {
      throw new Error("Unexpected call to authHandler");
    },
    authApiKey: TEST_AUTH_API_KEY,
    logSink: new TestLogSink(),
    logLevel: "debug",
  });
  await createRoom(authDO, "testRoomID1");
  await createRoom(authDO, "testRoomID2");
  await createRoom(authDO, "testRoomID3");

  const response = await authDO.fetch(testRequest);
  expect(response.status).toEqual(200);
  expect(roomDORequestCountsByRoomID.get("testRoomID1")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID2")).toEqual(1);
  expect(roomDORequestCountsByRoomID.get("testRoomID3")).toEqual(1);

  expect([...(await storage.list({ prefix: "connection/" })).keys()]).toEqual([
    "connection/testUserID1/testRoomID1/testClientID1/",
    "connection/testUserID1/testRoomID1/testClientID2/",
    "connection/testUserID1/testRoomID2/testClientID1/",
    "connection/testUserID2/testRoomID1/testClientID1/",
  ]);
});
