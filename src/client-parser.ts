import { EventEmitter } from 'events';
import type { Duplex } from 'stream';
import { ATYP, REP } from './constants.js';

// Parser state machine constants
const STATE_VERSION = 0;
const STATE_METHOD = 1;
const STATE_REP_STATUS = 2;
const STATE_REP_RSV = 3;
const STATE_REP_ATYP = 4;
const STATE_REP_BNDADDR = 5;
const STATE_REP_BNDADDR_VARLEN = 6;
const STATE_REP_BNDPORT = 7;

/** Maps SOCKS5 reply codes to [message, code] tuples for error creation */
const ERRORS: Record<number, [string, string]> = {
  [REP.GENFAIL]: ['general SOCKS server failure', 'EGENFAIL'],
  [REP.DISALLOW]: ['connection not allowed by ruleset', 'EACCES'],
  [REP.NETUNREACH]: ['network is unreachable', 'ENETUNREACH'],
  [REP.HOSTUNREACH]: ['host is unreachable', 'EHOSTUNREACH'],
  [REP.CONNREFUSED]: ['connection refused', 'ECONNREFUSED'],
  [REP.TTLEXPIRED]: ['ttl expired', 'ETTLEXPIRED'],
  [REP.CMDUNSUPP]: ['command not supported', 'ECMDNOSUPPORT'],
  [REP.ATYPUNSUPP]: ['address type not supported', 'EATYPNOSUPPORT'],
};

const ERROR_UNKNOWN: [string, string] = ['unknown error', 'EUNKNOWN'];

/**
 * Server reply info emitted on the `'reply'` event.
 * Contains the bound address and port as confirmed by the server.
 */
export interface ReplyInfo {
  /** Bound address reported by the server (IPv4, IPv6, or hostname) */
  bndAddr: string;
  /** Bound port reported by the server */
  bndPort: number;
}

export declare interface ClientParser {
  on(event: 'method', listener: (method: number) => void): this;
  on(event: 'reply', listener: (info: ReplyInfo) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  emit(event: 'method', method: number): boolean;
  emit(event: 'reply', info: ReplyInfo): boolean;
  emit(event: 'error', err: Error): boolean;
}

/**
 * SOCKS5 client-side protocol parser.
 *
 * Reads from a server socket and parses the SOCKS5 handshake responses:
 * 1. Auth method selection → emits `'method'`
 * 2. After auth, the proxy reply → emits `'reply'`
 *
 * @emits method - The auth method byte chosen by the server
 * @emits reply  - {@link ReplyInfo} with bound address/port on success
 * @emits error  - Parsing error or non-success reply code
 */
export class ClientParser extends EventEmitter {
  private _stream: Duplex;
  private _listening = false;
  private _state = STATE_VERSION;
  private _atyp = 0;
  private _bndaddr: Buffer | undefined;
  private _bndaddrp = 0;
  private _bndport: number | undefined;

  /**
   * Set to `true` after the client has authenticated so the parser
   * skips directly to reading the reply on the next invocation.
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
         * Server method selection:
         *   +----+--------+
         *   |VER | METHOD |
         *   +----+--------+
         *   | 1  |   1    |
         *   +----+--------+
         */
        case STATE_VERSION:
          if (chunk[i] !== 0x05) {
            this.emit('error', new Error(`Incompatible SOCKS protocol version: ${chunk[i]}`));
            return;
          }
          i++;
          state = this.authed ? STATE_REP_STATUS : STATE_METHOD;
          break;

        case STATE_METHOD: {
          const method = chunk[i];
          i++;
          this.stop();
          this._state = STATE_VERSION;
          if (i < len) this._stream.unshift(chunk.slice(i));
          this.emit('method', method);
          return;
        }

        /*
         * Server reply:
         *   +----+-----+-------+------+----------+----------+
         *   |VER | REP |  RSV  | ATYP | BND.ADDR | BND.PORT |
         *   +----+-----+-------+------+----------+----------+
         *   | 1  |  1  | X'00' |  1   | Variable |    2     |
         *   +----+-----+-------+------+----------+----------+
         */
        case STATE_REP_STATUS: {
          const status = chunk[i];
          if (status !== REP.SUCCESS) {
            const errinfo = ERRORS[status] ?? ERROR_UNKNOWN;
            const err = Object.assign(new Error(errinfo[0]), { code: errinfo[1] });
            this.stop();
            this.emit('error', err);
            return;
          }
          i++;
          state = STATE_REP_RSV;
          break;
        }

        case STATE_REP_RSV:
          i++; // reserved byte — skip
          state = STATE_REP_ATYP;
          break;

        case STATE_REP_ATYP: {
          const atyp = chunk[i];
          if (atyp === ATYP.IPv4) {
            this._bndaddr = Buffer.allocUnsafe(4);
            state = STATE_REP_BNDADDR;
          } else if (atyp === ATYP.IPv6) {
            this._bndaddr = Buffer.allocUnsafe(16);
            state = STATE_REP_BNDADDR;
          } else if (atyp === ATYP.NAME) {
            state = STATE_REP_BNDADDR_VARLEN;
          } else {
            this.stop();
            this.emit('error', new Error(`Invalid reply address type: ${atyp}`));
            return;
          }
          this._atyp = atyp;
          this._bndaddrp = 0;
          i++;
          break;
        }

        case STATE_REP_BNDADDR: {
          const left = this._bndaddr!.length - this._bndaddrp;
          const chunkLeft = len - i;
          const minLen = Math.min(left, chunkLeft);
          chunk.copy(this._bndaddr!, this._bndaddrp, i, i + minLen);
          this._bndaddrp += minLen;
          i += minLen;
          if (this._bndaddrp === this._bndaddr!.length) {
            state = STATE_REP_BNDPORT;
            this._bndport = undefined;
          }
          break;
        }

        case STATE_REP_BNDADDR_VARLEN:
          this._bndaddr = Buffer.allocUnsafe(chunk[i]);
          this._bndaddrp = 0;
          state = STATE_REP_BNDADDR;
          i++;
          break;

        case STATE_REP_BNDPORT:
          if (this._bndport === undefined) {
            // High byte
            this._bndport = chunk[i];
            i++;
          } else {
            // Low byte — now we have the full port
            this._bndport = (this._bndport << 8) + chunk[i];
            i++;

            this.stop();
            if (i < len) this._stream.unshift(chunk.slice(i));

            // Decode the bound address
            let bndAddr: string;
            if (this._atyp === ATYP.IPv4) {
              bndAddr = Array.from(this._bndaddr!).join('.');
            } else if (this._atyp === ATYP.IPv6) {
              const addr = this._bndaddr!;
              let ipv6str = '';
              for (let b = 0; b < 16; b++) {
                if (b % 2 === 0 && b > 0) ipv6str += ':';
                ipv6str += (addr[b] < 16 ? '0' : '') + addr[b].toString(16);
              }
              bndAddr = ipv6str;
            } else {
              bndAddr = this._bndaddr!.toString('utf8');
            }

            this.emit('reply', { bndAddr, bndPort: this._bndport });
            return;
          }
          break;
      }
    }

    this._state = state;
  }
}
