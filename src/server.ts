import net from 'net';
import dns from 'dns';
import { EventEmitter } from 'events';
import { ServerParser } from './server-parser.js';
import { ipbytes } from './utils.js';
import { ATYP, REP } from './constants.js';
import type { AuthHandler } from './auth/types.js';
import type { RequestInfo } from './server-parser.js';

// Pre-built response buffers for common replies
const BUF_AUTH_NO_ACCEPT = Buffer.from([0x05, 0xff]);
const BUF_REP_INTR_SUCCESS = Buffer.from([
  0x05,
  REP.SUCCESS,
  0x00,
  ATYP.IPv4,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
]);
const BUF_REP_DISALLOW = Buffer.from([0x05, REP.DISALLOW]);
const BUF_REP_CMDUNSUPP = Buffer.from([0x05, REP.CMDUNSUPP]);

/** Options for creating a {@link Server} */
export interface ServerOptions {
  /** Authentication handlers to use. Clients must support at least one. */
  auths?: AuthHandler[];
  /** Optional debug logging function */
  debug?: (msg: string) => void;
}

/**
 * Call `accept()` to allow the SOCKS5 connection.
 *
 * - If called with `intercept = true`, returns the raw client socket for
 *   you to pipe data into. The server writes a success reply automatically.
 * - If called without arguments (or `intercept = false`), the server
 *   automatically proxies the connection to the destination.
 */
export type AcceptFn = (intercept?: boolean) => net.Socket | undefined;

/** Call `deny()` to reject the SOCKS5 connection with a DISALLOW reply. */
export type DenyFn = () => void;

/** Connection listener signature — matches the electerm usage pattern */
export type ConnectionListener = (
  info: RequestInfo & { srcAddr: string; srcPort: number },
  accept: AcceptFn,
  deny: DenyFn,
) => void;

function onErrorNoop(_err: Error): void {
  // Swallow errors on already-handled sockets to prevent process crashes
}

/**
 * Transparently proxy a SOCKS5-accepted socket to the destination address.
 * Used when no `'connection'` listener is attached (automatic proxy mode).
 */
function proxySocket(socket: net.Socket, req: RequestInfo): void {
  dns.lookup(req.dstAddr, (err, dstIP) => {
    if (err) {
      handleProxyError(socket, err as NodeJS.ErrnoException);
      return;
    }

    let connected = false;

    const dstSock = new net.Socket();
    dstSock.setKeepAlive(false);

    dstSock
      .on('error', (connErr: NodeJS.ErrnoException) => {
        if (!connected) handleProxyError(socket, connErr);
      })
      .on('connect', () => {
        connected = true;
        if (!socket.writable) {
          if (dstSock.writable) dstSock.end();
          return;
        }

        // Build the success reply with the actual local bound address
        const localbytes = ipbytes(dstSock.localAddress ?? '127.0.0.1');
        const isIPv6 = localbytes.length === 16;
        const bufrep = Buffer.allocUnsafe(6 + localbytes.length);
        bufrep[0] = 0x05;
        bufrep[1] = REP.SUCCESS;
        bufrep[2] = 0x00;
        bufrep[3] = isIPv6 ? ATYP.IPv6 : ATYP.IPv4;
        for (let i = 0; i < localbytes.length; i++) {
          bufrep[4 + i] = localbytes[i];
        }
        bufrep.writeUInt16BE(dstSock.localPort ?? 0, 4 + localbytes.length);

        socket.write(bufrep);
        socket.pipe(dstSock).pipe(socket);
        socket.resume();
      })
      .connect(req.dstPort, dstIP);

    // Attach the destination socket so close handlers can access it
    (socket as net.Socket & { dstSock?: net.Socket }).dstSock = dstSock;
  });
}

/** Write a SOCKS5 error reply and close the socket. */
function handleProxyError(socket: net.Socket, err: NodeJS.ErrnoException): void {
  if (!socket.writable) return;

  const errbuf = Buffer.from([0x05, REP.GENFAIL]);
  switch (err.code) {
    case 'ENOENT':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
      errbuf[1] = REP.HOSTUNREACH;
      break;
    case 'ENETUNREACH':
      errbuf[1] = REP.NETUNREACH;
      break;
    case 'ECONNREFUSED':
      errbuf[1] = REP.CONNREFUSED;
      break;
  }
  socket.end(errbuf);
}

export declare interface Server {
  on(event: 'connection', listener: ConnectionListener): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'listening', listener: () => void): this;
  on(event: 'close', listener: () => void): this;
  emit(event: 'connection', ...args: Parameters<ConnectionListener>): boolean;
  emit(event: 'error', err: Error): boolean;
  emit(event: 'listening'): boolean;
  emit(event: 'close'): boolean;
}

/**
 * A SOCKS5 server.
 *
 * Wraps a `net.Server`, handles the SOCKS5 handshake, and emits a
 * `'connection'` event for each successfully negotiated request.
 *
 * @example
 * ```ts
 * import { createServer, auth } from 'socksv5-server';
 *
 * const server = createServer((info, accept, deny) => {
 *   // info: { srcAddr, srcPort, dstAddr, dstPort, cmd }
 *   const socket = accept(true); // intercept the socket
 *   if (socket) {
 *     // pipe to your SSH channel, etc.
 *   }
 * });
 * server.useAuth(auth.NoneAuth());
 * server.listen(1080, '127.0.0.1');
 * ```
 */
export class Server extends EventEmitter {
  private _srv: net.Server;
  private _auths: AuthHandler[] = [];
  private _debug: ((msg: string) => void) | undefined;
  private _connections = 0;

  /** Maximum number of concurrent connections (default: `Infinity`) */
  public maxConnections = Infinity;

  constructor(options?: ServerOptions | ConnectionListener, listener?: ConnectionListener) {
    super();

    // Allow `new Server(listener)` shorthand
    if (typeof options === 'function') {
      this.on('connection', options);
      options = undefined;
    } else if (typeof listener === 'function') {
      this.on('connection', listener);
    }

    this._debug = (options as ServerOptions)?.debug;

    if ((options as ServerOptions)?.auths) {
      for (const auth of (options as ServerOptions).auths!) {
        this.useAuth(auth);
      }
    }

    this._srv = new net.Server((socket) => {
      if (this._connections >= this.maxConnections) {
        socket.destroy();
        return;
      }
      this._connections++;
      socket.once('close', () => {
        this._connections--;
      });
      this._onConnection(socket);
    });

    this._srv
      .on('error', (err) => this.emit('error', err))
      .on('listening', () => this.emit('listening'))
      .on('close', () => this.emit('close'));
  }

  private _onConnection(socket: net.Socket): void {
    const parser = new ServerParser(socket as unknown as import('stream').Duplex);

    parser
      .on('error', (_err: Error) => {
        if (socket.writable) socket.end();
      })
      .on('methods', (methods: Buffer) => {
        // Find the first auth handler that matches a method offered by the client
        for (const auth of this._auths) {
          for (let m = 0; m < methods.length; m++) {
            if (methods[m] === auth.METHOD) {
              // Inform the client which method was chosen
              socket.write(Buffer.from([0x05, auth.METHOD]));
              socket.resume();

              auth.server(socket as unknown as import('stream').Duplex, (result) => {
                if (result === true) {
                  parser.authed = true;
                  parser.start();
                } else {
                  this._debug?.(`Auth error: ${(result as Error).message}`);
                  socket.end();
                }
              });
              return;
            }
          }
        }
        // No matching auth method
        socket.end(BUF_AUTH_NO_ACCEPT);
      })
      .on('request', (reqInfo: RequestInfo) => {
        if (reqInfo.cmd !== 'connect') {
          return socket.end(BUF_REP_CMDUNSUPP);
        }

        reqInfo.srcAddr = socket.remoteAddress;
        reqInfo.srcPort = socket.remotePort;

        let handled = false;

        const accept: AcceptFn = (intercept?: boolean) => {
          if (handled) return undefined;
          handled = true;
          if (!socket.writable) return undefined;

          if (intercept) {
            // Return the raw socket to the caller for manual piping
            socket.write(BUF_REP_INTR_SUCCESS);
            socket.removeListener('error', onErrorNoop);
            process.nextTick(() => socket.resume());
            return socket;
          }

          // Automatic transparent proxy
          proxySocket(socket, reqInfo);
          return undefined;
        };

        const deny: DenyFn = () => {
          if (handled) return;
          handled = true;
          if (socket.writable) socket.end(BUF_REP_DISALLOW);
        };

        if (this.listenerCount('connection') > 0) {
          this.emit(
            'connection',
            reqInfo as RequestInfo & { srcAddr: string; srcPort: number },
            accept,
            deny,
          );
        } else {
          proxySocket(socket, reqInfo);
        }
      });

    // Clean up the destination socket when the client socket closes
    function onClose(): void {
      const s = socket as net.Socket & { dstSock?: net.Socket };
      if (s.dstSock?.writable) s.dstSock.end();
      s.dstSock = undefined;
    }

    socket.on('error', onErrorNoop).on('end', onClose).on('close', onClose);
  }

  /**
   * Register an authentication handler.
   *
   * Handlers are tried in registration order. The first one whose `METHOD`
   * appears in the client's offered methods list is used.
   *
   * @param auth - An {@link AuthHandler} object
   * @returns `this` for chaining
   *
   * @example
   * server.useAuth(NoneAuth());
   * server.useAuth(UserPasswordAuth((u, p, cb) => cb(u === 'admin')));
   */
  useAuth(auth: AuthHandler): this {
    if (
      typeof auth !== 'object' ||
      typeof auth.server !== 'function' ||
      auth.server.length !== 2
    ) {
      throw new Error('Invalid authentication handler');
    }
    if (this._auths.length >= 255) {
      throw new Error('Too many authentication handlers (limited to 255)');
    }
    this._auths.push(auth);
    return this;
  }

  /**
   * Start listening for connections.
   * Arguments are forwarded directly to the underlying `net.Server.listen()`.
   *
   * @returns `this` for chaining
   */
  listen(...args: Parameters<net.Server['listen']>): this {
    this._srv.listen(...args);
    return this;
  }

  /** Returns the bound address, family, and port. */
  address(): net.AddressInfo | string | null {
    return this._srv.address();
  }

  /** Retrieve the number of concurrent connections. */
  getConnections(cb: (err: Error | null, count: number) => void): void {
    this._srv.getConnections(cb);
  }

  /** Stop accepting new connections and close the server. */
  close(cb?: (err?: Error) => void): this {
    this._srv.close(cb);
    return this;
  }

  /** Keep the Node.js event loop alive while the server is open. */
  ref(): this {
    this._srv.ref();
    return this;
  }

  /** Allow the Node.js event loop to exit even while the server is open. */
  unref(): this {
    this._srv.unref();
    return this;
  }
}

/**
 * Create a new SOCKS5 {@link Server}.
 *
 * @param options - {@link ServerOptions} or a connection listener shorthand
 * @param listener - Optional connection listener (if `options` is an object)
 * @returns A new {@link Server} instance
 *
 * @example
 * ```ts
 * const server = createServer((info, accept, deny) => {
 *   accept(); // transparent proxy
 * });
 * server.useAuth(NoneAuth());
 * server.listen(1080);
 * ```
 */
export function createServer(
  options?: ServerOptions | ConnectionListener,
  listener?: ConnectionListener,
): Server {
  return new Server(options, listener);
}
