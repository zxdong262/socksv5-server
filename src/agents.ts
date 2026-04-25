import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import { EventEmitter } from 'events';
import { connect as socksConnect } from './client.js';
import type { ClientOptions, ConnectOptions } from './client.js';

type AgentOptions = ClientOptions &
  http.AgentOptions & {
    /** TLS servername override (used by HttpsAgent) */
    servername?: string;
    /** Custom TLS options for HTTPS agent */
    rejectUnauthorized?: boolean;
    ca?: string | Buffer;
    cert?: string | Buffer;
    ciphers?: string;
    key?: string | Buffer;
    pfx?: string | Buffer;
  };

/**
 * An HTTP agent that routes connections through a SOCKS5 proxy.
 *
 * Drop-in replacement for `http.globalAgent` when you need to proxy
 * HTTP requests through a SOCKS5 server.
 *
 * @example
 * ```ts
 * import http from 'http';
 * import { HttpAgent } from 'socksv5-server';
 * import { NoneAuth } from 'socksv5-server/auth';
 *
 * const agent = new HttpAgent({
 *   proxyHost: '127.0.0.1',
 *   proxyPort: 1080,
 *   auths: [NoneAuth()],
 * });
 *
 * http.get({ host: 'example.com', agent }, (res) => {
 *   res.pipe(process.stdout);
 * });
 * ```
 */
export class HttpAgent extends EventEmitter {
  public defaultPort = 80;
  public protocol = 'http:';
  public options: AgentOptions;
  public requests: Record<string, http.ClientRequest[]> = {};
  public sockets: Record<string, net.Socket[]> = {};
  public freeSockets: Record<string, net.Socket[]> = {};
  public keepAliveMsecs: number;
  public keepAlive: boolean;
  public maxSockets: number;
  public maxFreeSockets: number;

  static defaultMaxSockets = Infinity;

  constructor(options: AgentOptions = {}) {
    super();

    this.options = { ...options };
    // Prevent net from treating this as a pipe connection
    (this.options as Record<string, unknown>).path = null;

    this.keepAliveMsecs = options.keepAliveMsecs ?? 1000;
    this.keepAlive = options.keepAlive ?? false;
    this.maxSockets = options.maxSockets ?? HttpAgent.defaultMaxSockets;
    this.maxFreeSockets = options.maxFreeSockets ?? 256;

    this.on('free', (socket: net.Socket, opts: AgentOptions) => {
      const name = this.getName(opts);

      if (!socket.destroyed && this.requests[name]?.length) {
        this.requests[name].shift()?.emit('socket', socket);
        if (this.requests[name].length === 0) delete this.requests[name];
      } else {
        const req = (socket as net.Socket & { _httpMessage?: http.ClientRequest })._httpMessage;
        if (req?.shouldKeepAlive && !socket.destroyed && this.options.keepAlive) {
          const freeSockets = this.freeSockets[name] ?? [];
          const freeLen = freeSockets.length;
          const count = freeLen + (this.sockets[name]?.length ?? 0);

          if (count >= this.maxSockets || freeLen >= this.maxFreeSockets) {
            this.removeSocket(socket, opts);
            socket.destroy();
          } else {
            this.freeSockets[name] = freeSockets;
            socket.setKeepAlive(true, this.keepAliveMsecs);
            socket.unref();
            (socket as net.Socket & { _httpMessage?: unknown })._httpMessage = undefined;
            this.removeSocket(socket, opts);
            freeSockets.push(socket);
          }
        } else {
          this.removeSocket(socket, opts);
          socket.destroy();
        }
      }
    });
  }

  /** Creates a SOCKS5 client connection (can be overridden by subclasses). */
  createConnection(options: ClientOptions & ConnectOptions): ReturnType<typeof socksConnect> {
    return socksConnect({ ...this.options, ...options });
  }

  /** Returns a unique cache key for the given request options. */
  getName(options: AgentOptions): string {
    return [
      options.host ?? 'localhost',
      ':',
      options.port ?? '',
      ':',
      options.localAddress ?? '',
      ':',
    ].join('');
  }

  addRequest(req: http.ClientRequest, options: AgentOptions): void {
    const name = this.getName(options);
    this.sockets[name] = this.sockets[name] ?? [];

    const freeLen = this.freeSockets[name]?.length ?? 0;
    const sockLen = freeLen + this.sockets[name].length;

    if (freeLen) {
      const socket = this.freeSockets[name].shift()!;
      if (!this.freeSockets[name].length) delete this.freeSockets[name];
      socket.ref();
      req.emit('socket', socket);
      this.sockets[name].push(socket);
    } else if (sockLen < this.maxSockets) {
      const client = this.createSocket(req, options);
      client.once('connect', (s: net.Socket) => {
        req.emit('socket', (s as net.Socket & { _tlssock?: tls.TLSSocket })._tlssock ?? s);
      });
    } else {
      this.requests[name] = this.requests[name] ?? [];
      this.requests[name].push(req);
    }
  }

  createSocket(req: http.ClientRequest, options: AgentOptions): ReturnType<typeof socksConnect> {
    const merged: AgentOptions = { ...this.options, ...options };
    merged.servername = (options.host as string | undefined) ?? undefined;

    const hostHeader = req.getHeader('host') as string | undefined;
    if (hostHeader) {
      merged.servername = hostHeader.replace(/:.*$/, '');
    }

    const name = this.getName(merged);
    const client = this.createConnection(merged as unknown as ClientOptions & ConnectOptions);

    client.once('connect', (s: net.Socket) => {
      let finalSocket: net.Socket = s;
      if (this._isHttps()) {
        const upgradeOptions = { ...merged, socket: s };
        finalSocket = (s as net.Socket & { _tlssock?: tls.TLSSocket })._tlssock =
          tls.connect(upgradeOptions);
      }

      this.sockets[name] = this.sockets[name] ?? [];
      this.sockets[name].push(finalSocket);

      const onFree = (): void => {
        this.emit('free', finalSocket, merged);
      };
      const onClose = (): void => {
        this.removeSocket(finalSocket, merged);
      };
      const onRemove = (): void => {
        this.removeSocket(finalSocket, merged);
        finalSocket.removeListener('close', onClose);
        finalSocket.removeListener('free', onFree);
        finalSocket.removeListener('agentRemove', onRemove);
      };

      finalSocket.on('free', onFree).on('close', onClose).on('agentRemove', onRemove);
    });

    return client;
  }

  removeSocket(socket: net.Socket, options: AgentOptions): void {
    const name = this.getName(options);
    const sets: Record<string, net.Socket[]>[] = [this.sockets];
    if (socket.destroyed) sets.push(this.freeSockets);

    for (const set of sets) {
      if (set[name]) {
        const idx = set[name].indexOf(socket);
        if (idx !== -1) {
          set[name].splice(idx, 1);
          if (set[name].length === 0) delete set[name];
        }
      }
    }

    if (this.requests[name]?.length) {
      const req = this.requests[name][0];
      const client = this.createSocket(req, options);
      client.once('connect', (s: net.Socket) => {
        ((s as net.Socket & { _tlssock?: tls.TLSSocket })._tlssock ?? s).emit('free');
      });
    }
  }

  /** Destroy all open and free sockets. */
  destroy(): void {
    for (const set of [this.freeSockets, this.sockets]) {
      for (const sockets of Object.values(set)) {
        for (const s of sockets) s.destroy();
      }
    }
  }

  protected _isHttps(): boolean {
    return false;
  }
}

/**
 * An HTTPS agent that routes connections through a SOCKS5 proxy.
 *
 * @example
 * ```ts
 * import https from 'https';
 * import { HttpsAgent } from 'socksv5-server';
 * import { NoneAuth } from 'socksv5-server/auth';
 *
 * const agent = new HttpsAgent({
 *   proxyHost: '127.0.0.1',
 *   proxyPort: 1080,
 *   auths: [NoneAuth()],
 * });
 *
 * https.get({ host: 'example.com', agent }, (res) => {
 *   res.pipe(process.stdout);
 * });
 * ```
 */
export class HttpsAgent extends HttpAgent {
  constructor(options: AgentOptions = {}) {
    super(options);
    this.defaultPort = 443;
    this.protocol = 'https:';
  }

  override createConnection(
    options: ClientOptions & ConnectOptions,
  ): ReturnType<typeof socksConnect> {
    return socksConnect({ ...this.options, ...options });
  }

  override getName(options: AgentOptions): string {
    return [
      super.getName(options),
      options.ca ?? '',
      ':',
      options.cert ?? '',
      ':',
      options.ciphers ?? '',
      ':',
      options.key ?? '',
      ':',
      options.pfx ?? '',
      ':',
      options.rejectUnauthorized ?? '',
    ].join('');
  }

  protected override _isHttps(): boolean {
    return true;
  }
}
