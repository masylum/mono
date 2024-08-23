import type {WebSocket} from '@fastify/websocket';
import type {LogContext} from '@rocicorp/logger';
import * as valita from 'shared/src/valita.js';
import type {CloseEvent, ErrorEvent, MessageEvent} from 'ws';
import {
  ConnectedMessage,
  Downstream,
  ErrorKind,
  ErrorMessage,
  PongMessage,
  upstreamSchema,
} from 'zero-protocol';
import {ConnectParams} from '../services/dispatcher/connect-params.js';
import type {Mutagen} from '../services/mutagen/mutagen.js';
import type {
  SyncContext,
  ViewSyncer,
} from '../services/view-syncer/view-syncer.js';
import {findErrorForClient} from '../types/error-for-client.js';
import type {CancelableAsyncIterable} from '../types/streams.js';

/**
 * Represents a connection between the client and server.
 *
 * Handles incoming messages on the connection and dispatches
 * them to the correct service.
 *
 * Listens to the ViewSyncer and sends messages to the client.
 */
export class Connection {
  readonly #ws: WebSocket;
  readonly #clientGroupID: string;
  readonly #syncContext: SyncContext;
  readonly #lc: LogContext;
  readonly #onClose: () => void;

  readonly #viewSyncer: ViewSyncer;
  readonly #mutagen: Mutagen;

  #outboundStream: CancelableAsyncIterable<Downstream> | undefined;
  #closed = false;

  constructor(
    lc: LogContext,
    viewSyncer: ViewSyncer,
    mutagen: Mutagen,
    connectParams: ConnectParams,
    ws: WebSocket,
    onClose: () => void,
  ) {
    this.#ws = ws;
    const {clientGroupID, clientID, wsID, baseCookie} = connectParams;
    this.#clientGroupID = clientGroupID;
    this.#syncContext = {clientID, wsID, baseCookie};
    this.#lc = lc
      .withContext('connection')
      .withContext('clientID', clientID)
      .withContext('clientGroupID', clientGroupID)
      .withContext('wsID', wsID);
    this.#onClose = onClose;

    this.#viewSyncer = viewSyncer;
    this.#mutagen = mutagen;

    this.#ws.addEventListener('message', this.#handleMessage);
    this.#ws.addEventListener('close', this.#handleClose);
    this.#ws.addEventListener('error', this.#handleError);

    const connectedMessage: ConnectedMessage = [
      'connected',
      {wsid: wsID, timestamp: Date.now()},
    ];
    send(ws, connectedMessage);
  }

  close() {
    if (this.#closed) {
      return;
    }
    this.#lc.debug?.('close');
    this.#closed = true;
    this.#ws.removeEventListener('message', this.#handleMessage);
    this.#ws.removeEventListener('close', this.#handleClose);
    this.#ws.removeEventListener('error', this.#handleError);
    this.#outboundStream?.cancel();
    this.#outboundStream = undefined;
    this.#onClose();
    if (this.#ws.readyState !== this.#ws.CLOSED) {
      this.#ws.close();
    }

    // spin down services if we have
    // no more client connections for the client group?
  }

  #handleMessage = async (event: MessageEvent) => {
    const lc = this.#lc;
    const data = event.data.toString();
    const viewSyncer = this.#viewSyncer;
    if (this.#closed) {
      this.#lc.debug?.('Ignoring message received after closed', data);
      return;
    }

    let msg;
    try {
      const value = JSON.parse(data);
      msg = valita.parse(value, upstreamSchema);
    } catch (e) {
      this.#closeWithError(['error', ErrorKind.InvalidMessage, String(e)], e);
      return;
    }
    try {
      const msgType = msg[0];
      switch (msgType) {
        case 'ping':
          this.send(['pong', {}] satisfies PongMessage);
          break;
        case 'push': {
          const {clientGroupID, mutations} = msg[1];
          if (clientGroupID !== this.#clientGroupID) {
            this.#closeWithError([
              'error',
              ErrorKind.InvalidPush,
              `clientGroupID in mutation "${clientGroupID}" does not match ` +
                `clientGroupID of connection "${this.#clientGroupID}`,
            ]);
          }
          for (const mutation of mutations) {
            const errorDesc = await this.#mutagen.processMutation(mutation);
            if (errorDesc !== undefined) {
              this.sendError(['error', ErrorKind.MutationFailed, errorDesc]);
            }
          }
          break;
        }
        case 'pull':
          lc.error?.('TODO: implement pull');
          break;
        case 'changeDesiredQueries':
          await viewSyncer.changeDesiredQueries(this.#syncContext, msg);
          break;
        case 'deleteClients':
          lc.error?.('TODO: implement deleteClients');
          break;
        case 'initConnection': {
          this.#outboundStream = await viewSyncer.initConnection(
            this.#syncContext,
            msg,
          );
          if (this.#closed) {
            this.#outboundStream.cancel();
          } else {
            void this.#proxyOutbound(this.#outboundStream);
          }
          break;
        }
        default:
          msgType satisfies never;
      }
    } catch (e) {
      this.#closeWithThrown(e);
    }
  };

  #handleClose = (e: CloseEvent) => {
    const {code, reason, wasClean} = e;
    this.#lc.info?.('WebSocket close event', {code, reason, wasClean});
    this.close();
  };

  #handleError = (e: ErrorEvent) => {
    this.#lc.error?.('WebSocket error event', e.message, e.error);
  };

  async #proxyOutbound(outboundStream: CancelableAsyncIterable<Downstream>) {
    try {
      for await (const outMsg of outboundStream) {
        this.send(outMsg);
      }
      this.#lc.info?.('downstream closed by ViewSyncer');
      this.close();
    } catch (e) {
      this.#closeWithThrown(e);
    }
  }

  #closeWithThrown(e: unknown) {
    const errorMessage = findErrorForClient(e)?.errorMessage ?? [
      'error',
      ErrorKind.Internal,
      String(e),
    ];
    this.#closeWithError(errorMessage, e);
  }

  #closeWithError(errorMessage: ErrorMessage, thrown?: unknown) {
    this.sendError(errorMessage, thrown);
    this.close();
  }

  send(data: Downstream) {
    send(this.#ws, data);
  }

  sendError(errorMessage: ErrorMessage, thrown?: unknown) {
    sendError(this.#lc, this.#ws, errorMessage, thrown);
  }
}

export function send(ws: WebSocket, data: Downstream) {
  ws.send(JSON.stringify(data));
}

export function sendError(
  lc: LogContext,
  ws: WebSocket,
  errorMessage: ErrorMessage,
  thrown?: unknown,
) {
  lc = lc.withContext('errorKind', errorMessage[1]);
  const logLevel = thrown ? 'error' : 'info';
  lc[logLevel]?.('Sending error on WebSocket', errorMessage, thrown ?? '');
  send(ws, errorMessage);
}