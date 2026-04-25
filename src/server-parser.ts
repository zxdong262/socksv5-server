import { EventEmitter } from 'events';
import type { Duplex } from 'stream';
import { CMD, ATYP } from './constants.js';

// Parser state machine constants
const STATE_VERSION = 0;
const STATE_NMETHODS = 1;
const STATE_METHODS = 2;
const STATE_REQ_CMD = 3;
const STATE_REQ_RSV = 4;
const STATE_REQ_ATYP = 5;
const STATE_REQ_DSTADDR = 6;
const STATE_REQ_DSTADDR_VARLEN = 7;
const STATE_REQ_DSTPORT = 8;

/**
 * Information about a SOCKS5 proxy request, emitted as the `'request'` event.
 */
export interface RequestInfo {
  /** The proxy command — currently only `'connect'` is fully supported */
  cmd: 'connect' | 'bind' | 'udp';
  /** Source IP address of the connecting client (filled in by the Server) */
  srcAddr: string | undefined;
  /** Source port of the connecting client (filled in by the Server) */
  srcPort: number | undefined;
  /** Desired destination address (IPv4, IPv6, or hostname) */
  dstAddr: string;
  /** Desired destination port */
  dstPort: number;
}

export declare interface ServerParser {
  on(event: 'methods', listener: (methods: Buffer) => void): this;
  on(event: 'request', listener: (info: RequestInfo) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  emit(event: 'methods', methods: Buffer): boolean;
  emit(event: 'request', info: RequestInfo): boolean;
  emit(event: 'error', err: Error): boolean;
}

/**
 * SOCKS5 server-side protocol parser.
 *
 * Reads from a client socket and parses the SOCKS5 handshake:
 * 1. Version + offered auth methods → emits `'methods'`
 * 2. After auth, the proxy request → emits `'request'`
 *
 * The parser pauses the underlying stream while waiting for data,
 * and calls `stream.unshift()` for any bytes beyond the parsed message.
 *
 * @emits methods - Buffer of offered authentication method bytes
 * @emits request - {@link RequestInfo} describing the connection target
 * @emits error   - Parsing error (the caller should close the socket)
 */
export class ServerParser extends EventEmitter {
  private _stream: Duplex;
  private _listening = false;
  private _state = STATE_VERSION;
  private _methods: Buffer | undefined;
  private _methodsp = 0;
  private _cmd: 'connect' | 'bind' | 'udp' = 'connect';
  private _atyp = 0;
  private _dstaddr: Buffer | undefined;
  private _dstaddrp = 0;
  private _dstport: number | undefined;

  /**
   * Set to `true` after the client has been authenticated so the parser
   * can skip the methods handshake on the next invocation.
   */
  public authed = false;

  private readonly _onDataBound: (chunk: Buffer) => void;

  constructor(stream: Duplex) {
    super();
    this._stream = stream;
    this._onDataBound = (chunk: Buffer) => this._onData(chunk);
    this.start();
  }

  /** Start listening for data on the stream. */
  start(): void {
    if (this._listening) return;
    this._listening = true;
    this._stream.on('data', this._onDataBound);
    this._stream.resume();
  }

  /** Stop listening for data on the stream. */
  stop(): void {
    if (!this._listening) return;
    this._listening = false;
    this._stream.removeListener('data', this._onDataBound);
    this._stream.pause();
  }

  private _onData(chunk: Buffer): void {
    let state = this._state;
    let i = 0;
    const len = chunk.length;

    while (i < len) {
      switch (state) {
        /*
         * Initial handshake — client sends:
         *   +----+----------+----------+
         *   |VER | NMETHODS | METHODS  |
         *   +----+----------+----------+
         *   | 1  |    1     | 1 to 255 |
         *   +----+----------+----------+
         */
        case STATE_VERSION:
          if (chunk[i] !== 0x05) {
            this.emit('error', new Error(`Incompatible SOCKS protocol version: ${chunk[i]}`));
            return;
          }
          i++;
          state = this.authed ? STATE_REQ_CMD : STATE_NMETHODS;
          break;

        case STATE_NMETHODS: {
          const nmethods = chunk[i];
          if (nmethods === 0) {
            this.emit('error', new Error('Unexpected empty methods list'));
            return;
          }
          i++;
          state = STATE_METHODS;
          this._methods = Buffer.allocUnsafe(nmethods);
          this._methodsp = 0;
          break;
        }

        case STATE_METHODS: {
          const left = this._methods!.length - this._methodsp;
          const chunkLeft = len - i;
          const minLen = Math.min(left, chunkLeft);
          chunk.copy(this._methods!, this._methodsp, i, i + minLen);
          this._methodsp += minLen;
          i += minLen;
          if (this._methodsp === this._methods!.length) {
            this.stop();
            this._state = STATE_VERSION;
            if (i < len) this._stream.unshift(chunk.slice(i));
            const methods = this._methods!;
            this._methods = undefined;
            this.emit('methods', methods);
            return;
          }
          break;
        }

        /*
         * Proxy request — client sends:
         *   +----+-----+-------+------+----------+----------+
         *   |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
         *   +----+-----+-------+------+----------+----------+
         *   | 1  |  1  | X'00' |  1   | Variable |    2     |
         *   +----+-----+-------+------+----------+----------+
         */
        case STATE_REQ_CMD: {
          const cmd = chunk[i];
          if (cmd === CMD.CONNECT) {
            this._cmd = 'connect';
          } else if (cmd === CMD.BIND) {
            this._cmd = 'bind';
          } else if (cmd === CMD.UDP) {
            this._cmd = 'udp';
          } else {
            this.stop();
            this.emit('error', new Error(`Invalid request command: ${cmd}`));
            return;
          }
          i++;
          state = STATE_REQ_RSV;
          break;
        }

        case STATE_REQ_RSV:
          i++; // reserved byte — skip
          state = STATE_REQ_ATYP;
          break;

        case STATE_REQ_ATYP: {
          const atyp = chunk[i];
          if (atyp === ATYP.IPv4) {
            this._dstaddr = Buffer.allocUnsafe(4);
            state = STATE_REQ_DSTADDR;
          } else if (atyp === ATYP.IPv6) {
            this._dstaddr = Buffer.allocUnsafe(16);
            state = STATE_REQ_DSTADDR;
          } else if (atyp === ATYP.NAME) {
            state = STATE_REQ_DSTADDR_VARLEN;
          } else {
            this.stop();
            this.emit('error', new Error(`Invalid request address type: ${atyp}`));
            return;
          }
          this._atyp = atyp;
          this._dstaddrp = 0;
          i++;
          break;
        }

        case STATE_REQ_DSTADDR: {
          const left = this._dstaddr!.length - this._dstaddrp;
          const chunkLeft = len - i;
          const minLen = Math.min(left, chunkLeft);
          chunk.copy(this._dstaddr!, this._dstaddrp, i, i + minLen);
          this._dstaddrp += minLen;
          i += minLen;
          if (this._dstaddrp === this._dstaddr!.length) {
            state = STATE_REQ_DSTPORT;
            this._dstport = undefined;
          }
          break;
        }

        case STATE_REQ_DSTADDR_VARLEN:
          // First byte is the length of the domain name
          this._dstaddr = Buffer.allocUnsafe(chunk[i]);
          this._dstaddrp = 0;
          state = STATE_REQ_DSTADDR;
          i++;
          break;

        case STATE_REQ_DSTPORT:
          if (this._dstport === undefined) {
            // High byte
            this._dstport = chunk[i];
            i++;
          } else {
            // Low byte — now we have the full port
            this._dstport = (this._dstport << 8) + chunk[i];
            i++;

            this.stop();
            if (i < len) this._stream.unshift(chunk.slice(i));

            // Decode the destination address based on its type
            let dstAddr: string;
            if (this._atyp === ATYP.IPv4) {
              dstAddr = Array.from(this._dstaddr!).join('.');
            } else if (this._atyp === ATYP.IPv6) {
              const addr = this._dstaddr!;
              let ipv6str = '';
              for (let b = 0; b < 16; b++) {
                if (b % 2 === 0 && b > 0) ipv6str += ':';
                ipv6str += (addr[b] < 16 ? '0' : '') + addr[b].toString(16);
              }
              dstAddr = ipv6str;
            } else {
              dstAddr = this._dstaddr!.toString('utf8');
            }

            this.emit('request', {
              cmd: this._cmd,
              srcAddr: undefined,
              srcPort: undefined,
              dstAddr,
              dstPort: this._dstport,
            });
            return;
          }
          break;
      }
    }

    this._state = state;
  }
}
