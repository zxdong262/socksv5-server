import net from 'net';
import dns from 'dns';
import { EventEmitter } from 'events';
import { ClientParser } from './client-parser.js';
import { CMD, ATYP } from './constants.js';
import { ipbytes } from './utils.js';
import type { AuthHandler } from './auth/types.js';

/** Options for creating a SOCKS5 {@link Client} */
export interface ClientOptions {
  /** SOCKS5 proxy host (default: `'localhost'`) */
  proxyHost?: string;
  /** SOCKS5 proxy port (default: `1080`) */
  proxyPort?: number;
  /** Authentication handlers for the client */
  auths?: AuthHandler[];
  /**
   * Resolve hostnames locally before sending to the proxy.
   * When `true`, DNS lookup is performed by the client before connecting.
   * Default: `true`
   */
  localDNS?: boolean;
  /**
   * When `localDNS` is `true` and DNS lookup fails, abort the connection
   * rather than passing the unresolved hostname to the proxy.
   * Default: `true`
   */
  strictLocalDNS?: boolean;
}

/** Options passed to {@link Client.connect} */
export interface ConnectOptions {
  /** Destination host */
  host?: string;
  /** Destination port (required) */
  port: number;
  /** Optional local bind address */
  localAddress?: string;
  /** Override proxy host for this connection */
  proxyHost?: string;
  /** Override proxy port for this connection */
  proxyPort?: number;
  /** Override localDNS setting for this connection */
  localDNS?: boolean;
  /** Override strictLocalDNS setting for this connection */
  strictLocalDNS?: boolean;
}

export declare interface Client {
  on(event: 'connect', listener: (socket: net.Socket) => void): this;
  on(event: 'close', listener: (hadError: boolean) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  emit(event: 'connect', socket: net.Socket): boolean;
  emit(event: 'close', hadError: boolean): boolean;
  emit(event: 'error', err: Error): boolean;
}

/**
 * A SOCKS5 client that connects through a proxy server.
 *
 * @example
 * ```ts
 * import { Client, auth } from 'socksv5-server';
 *
 * const client = new Client({ proxyHost: '127.0.0.1', proxyPort: 1080 });
 * client.useAuth(auth.NoneAuth());
 * client.connect({ host: 'example.com', port: 80 }, (socket) => {
 *   socket.write('GET / HTTP/1.0\r\n\r\n');
 *   socket.pipe(process.stdout);
 * });
 * ```
 */
export class Client extends EventEmitter {
  private _hadError = false;
  private _ready = false;
  private _sock: net.Socket;
  private _parser: ClientParser | undefined;
  private _proxyHost: string;
  private _proxyPort: number;
  private _dstAddr = '';
  private _dstPort = 0;
  private _localDNS: boolean;
  private _strictLocalDNS: boolean;
  private _auths: AuthHandler[] = [];

  constructor(options?: ClientOptions) {
    super();

    this._proxyHost = options?.proxyHost ?? 'localhost';
    this._proxyPort = options?.proxyPort ?? 1080;
    this._localDNS = options?.localDNS ?? true;
    this._strictLocalDNS = options?.strictLocalDNS ?? true;

    if (options?.auths) {
      for (const auth of options.auths) this.useAuth(auth);
    }

    this._sock = new net.Socket();
    this._sock
      .on('connect', () => this._onConnect())
      .on('error', (err) => {
        if (!this._hadError && !this._ready) {
          this._hadError = true;
          this.emit('error', err);
        }
      })
      .on('close', (hadErr) => {
        this.emit('close', this._hadError || hadErr);
      });
  }

  private _onConnect(): void {
    const socket = this._sock;
    const parser = this._parser!;

    // Send list of supported auth methods to the proxy server
    const auths = this._auths;
    const authsbuf = Buffer.allocUnsafe(2 + auths.length);
    authsbuf[0] = 0x05;
    authsbuf[1] = auths.length;
    for (let a = 0; a < auths.length; a++) {
      authsbuf[2 + a] = auths[a].METHOD;
    }
    socket.write(authsbuf);

    parser
      .on('method', (method: number) => {
        // Find the matching auth handler
        const matched = auths.find((a) => a.METHOD === method);
        if (!matched) {
          this._hadError = true;
          const err = Object.assign(new Error('Authentication method mismatch'), {
            code: 'EAUTHNOTSUPPORT',
          });
          this.emit('error', err);
          socket.end();
          return;
        }

        socket.resume();
        matched.client(socket as unknown as import('stream').Duplex, (result) => {
          if (result === true) {
            parser.authed = true;
            parser.start();
            this._sendRequest();
          } else {
            this._hadError = true;
            if (result instanceof Error) {
              this.emit('error', result);
            } else {
              this.emit(
                'error',
                Object.assign(new Error('Authentication failed'), { code: 'EAUTHFAILED' }),
              );
            }
            socket.end();
          }
        });
      })
      .on('error', (err: Error) => {
        this._hadError = true;
        this.emit('error', err);
        if (socket.writable) socket.end();
      })
      .on('reply', () => {
        this._ready = true;
        this.emit('connect', this._sock);
        this._sock.resume();
      });
  }

  private _sendRequest(): void {
    const iptype = net.isIP(this._dstAddr);
    const addrlen =
      iptype === 0
        ? Buffer.byteLength(this._dstAddr)
        : iptype === 4
          ? 4
          : 16;

    const reqbuf = Buffer.allocUnsafe(6 + (iptype === 0 ? 1 : 0) + addrlen);
    reqbuf[0] = 0x05;
    reqbuf[1] = CMD.CONNECT;
    reqbuf[2] = 0x00; // reserved

    if (iptype > 0) {
      const addrbytes = ipbytes(this._dstAddr);
      reqbuf[3] = iptype === 4 ? ATYP.IPv4 : ATYP.IPv6;
      for (let i = 0; i < addrlen; i++) {
        reqbuf[4 + i] = addrbytes[i];
      }
      reqbuf.writeUInt16BE(this._dstPort, 4 + addrlen);
    } else {
      // Domain name
      reqbuf[3] = ATYP.NAME;
      reqbuf[4] = addrlen; // length prefix
      reqbuf.write(this._dstAddr, 5, addrlen);
      reqbuf.writeUInt16BE(this._dstPort, 5 + addrlen);
    }

    this._sock.write(reqbuf);
  }

  /**
   * Register an authentication handler.
   *
   * @param auth - An {@link AuthHandler} object
   * @returns `this` for chaining
   */
  useAuth(auth: AuthHandler): this {
    if (
      typeof auth !== 'object' ||
      typeof auth.client !== 'function' ||
      auth.client.length !== 2
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
   * Connect through the SOCKS5 proxy to the destination host/port.
   *
   * @param options - Destination and optional proxy overrides
   * @param cb - Optional callback called on `'connect'`
   * @returns `this` for chaining
   *
   * @example
   * client.connect({ host: 'example.com', port: 80 }, (socket) => {
   *   // socket is ready
   * });
   */
  connect(options: ConnectOptions, cb?: (socket: net.Socket) => void): this {
    if (this._auths.length === 0) {
      throw new Error('Missing client authentication method(s)');
    }

    if (!options.port) {
      throw new Error('Can only connect to TCP hosts (port is required)');
    }

    if (cb) this.once('connect', cb);

    this._dstAddr = options.host ?? 'localhost';
    this._dstPort = +options.port;

    if (typeof options.localDNS === 'boolean') this._localDNS = options.localDNS;
    if (typeof options.strictLocalDNS === 'boolean') this._strictLocalDNS = options.strictLocalDNS;
    if (typeof options.proxyHost === 'string') this._proxyHost = options.proxyHost;
    if (typeof options.proxyPort === 'number') this._proxyPort = options.proxyPort;

    // Reset the parser for this new connection attempt
    this._parser?.stop();
    this._parser = new ClientParser(this._sock as unknown as import('stream').Duplex);
    this._hadError = false;
    this._ready = false;

    const connectProxy = (): void => {
      this._sock.connect({
        host: this._proxyHost,
        port: this._proxyPort,
        localAddress: options.localAddress,
      });
    };

    // Optionally resolve the destination DNS locally
    if (net.isIP(this._dstAddr) === 0 && this._localDNS) {
      dns.lookup(this._dstAddr, (err, addr) => {
        if (err && this._strictLocalDNS) {
          this._hadError = true;
          this.emit('error', err);
          this.emit('close', true);
          return;
        }
        if (addr) this._dstAddr = addr;
        connectProxy();
      });
    } else {
      connectProxy();
    }

    return this;
  }
}

/**
 * Create and immediately connect a SOCKS5 {@link Client}.
 *
 * @param options - Combined client + connect options
 * @param cb - Called on successful connection
 * @returns The new {@link Client} instance
 *
 * @example
 * ```ts
 * import { connect, auth } from 'socksv5-server';
 *
 * const client = connect(
 *   { proxyHost: '127.0.0.1', proxyPort: 1080, host: 'example.com', port: 80,
 *     auths: [auth.NoneAuth()] },
 *   (socket) => { socket.pipe(process.stdout); },
 * );
 * ```
 */
export function connect(
  options: ClientOptions & ConnectOptions,
  cb?: (socket: net.Socket) => void,
): Client {
  const client = new Client(options);
  if (options.auths) {
    // already registered in constructor
  }
  process.nextTick(() => client.connect(options, cb));
  return client;
}

/** Alias for {@link connect} */
export const createConnection = connect;
