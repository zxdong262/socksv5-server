import type { Duplex } from 'stream';
import type { AuthHandler } from './types.js';

/** Callback used for server-side username/password verification */
export type UserPassVerifyCallback = (success: boolean) => void;

/** Async function provided by the caller to verify username + password */
export type UserPassVerifier = (
  user: string,
  pass: string,
  cb: UserPassVerifyCallback,
) => void;

// Sub-state machine constants — server side
const STATE_VERSION = 0;
const STATE_ULEN = 1;
const STATE_UNAME = 2;
const STATE_PLEN = 3;
const STATE_PASSWD = 4;
// Sub-state machine constants — client side
const STATE_STATUS = 5;

// Fixed-length response buffers for the server
const BUF_SUCCESS = Buffer.from([0x01, 0x00]);
const BUF_FAILURE = Buffer.from([0x01, 0x01]);

/**
 * Creates a Username/Password authentication handler for SOCKS5 (METHOD `0x02`).
 *
 * **Server mode** — accepts a verifier callback `(user, pass, cb)`:
 * ```ts
 * UserPasswordAuth((user, pass, cb) => {
 *   cb(user === 'admin' && pass === 'secret');
 * });
 * ```
 *
 * **Client mode** — accepts static username and password strings:
 * ```ts
 * UserPasswordAuth('admin', 'secret');
 * ```
 *
 * @param usernameOrVerifier - Static username string (client mode) or verifier function (server mode)
 * @param password - Static password string (required in client mode)
 * @returns An {@link AuthHandler} for username/password authentication
 *
 * @throws {Error} If arguments are invalid or username/password exceed 255 bytes
 */
export function UserPasswordAuth(
  usernameOrVerifier: string | UserPassVerifier,
  password?: string,
): AuthHandler {
  let authcb: UserPassVerifier | undefined;
  let staticUser: string | undefined;
  let staticPass: string | undefined;
  let userlen = 0;
  let passlen = 0;

  if (typeof usernameOrVerifier === 'function') {
    // Server mode: caller provides a verifier function
    authcb = usernameOrVerifier;
  } else if (
    typeof usernameOrVerifier === 'string' &&
    typeof password === 'string'
  ) {
    // Client mode: static credentials
    staticUser = usernameOrVerifier;
    staticPass = password;
    userlen = Buffer.byteLength(staticUser);
    passlen = Buffer.byteLength(staticPass);
    if (userlen > 255) throw new Error('Username too long (limited to 255 bytes)');
    if (passlen > 255) throw new Error('Password too long (limited to 255 bytes)');
  } else {
    throw new Error(
      'UserPasswordAuth requires either a verifier function or (username, password) strings',
    );
  }

  return {
    METHOD: 0x02,

    /**
     * Server-side handler: reads username + password from the client socket
     * according to RFC 1929, then invokes the verifier callback.
     *
     * Sub-auth packet format:
     * +----+------+----------+------+----------+
     * |VER | ULEN |  UNAME   | PLEN |  PASSWD  |
     * +----+------+----------+------+----------+
     * | 1  |  1   | 1 to 255 |  1   | 1 to 255 |
     * +----+------+----------+------+----------+
     */
    server(stream: Duplex, cb) {
      let state = STATE_VERSION;
      let user: Buffer = Buffer.alloc(0);
      let pass: Buffer = Buffer.alloc(0);
      let userp = 0;
      let passp = 0;

      function onData(chunk: Buffer): void {
        let i = 0;
        const len = chunk.length;

        while (i < len) {
          switch (state) {
            case STATE_VERSION:
              if (chunk[i] !== 0x01) {
                stream.removeListener('data', onData);
                cb(new Error(`Unsupported auth request version: ${chunk[i]}`));
                return;
              }
              i++;
              state = STATE_ULEN;
              break;

            case STATE_ULEN: {
              const ulen = chunk[i];
              if (ulen === 0) {
                stream.removeListener('data', onData);
                cb(new Error('Bad username length (0)'));
                return;
              }
              i++;
              state = STATE_UNAME;
              user = Buffer.allocUnsafe(ulen);
              userp = 0;
              break;
            }

            case STATE_UNAME: {
              const left = user.length - userp;
              const chunkLeft = len - i;
              const minLen = Math.min(left, chunkLeft);
              chunk.copy(user, userp, i, i + minLen);
              userp += minLen;
              i += minLen;
              if (userp === user.length) {
                state = STATE_PLEN;
              }
              break;
            }

            case STATE_PLEN: {
              const plen = chunk[i];
              if (plen === 0) {
                stream.removeListener('data', onData);
                cb(new Error('Bad password length (0)'));
                return;
              }
              i++;
              state = STATE_PASSWD;
              pass = Buffer.allocUnsafe(plen);
              passp = 0;
              break;
            }

            case STATE_PASSWD: {
              const left = pass.length - passp;
              const chunkLeft = len - i;
              const minLen = Math.min(left, chunkLeft);
              chunk.copy(pass, passp, i, i + minLen);
              passp += minLen;
              i += minLen;
              if (passp === pass.length) {
                stream.removeListener('data', onData);
                const userStr = user.toString('utf8');
                const passStr = pass.toString('utf8');
                // Reset for potential re-use
                state = STATE_VERSION;
                if (i < len) {
                  (stream as NodeJS.ReadableStream & { unshift: (b: Buffer) => void }).unshift(
                    chunk.slice(i),
                  );
                }
                authcb!(userStr, passStr, (success) => {
                  if ((stream as Duplex & { writable: boolean }).writable) {
                    stream.write(success ? BUF_SUCCESS : BUF_FAILURE);
                    cb(success || new Error('Authentication failed'));
                  }
                });
                return;
              }
              break;
            }
          }
        }
      }

      stream.on('data', onData);
    },

    /**
     * Client-side handler: sends username + password to the server and reads
     * the response status byte.
     *
     * Packet sent:
     * +----+------+----------+------+----------+
     * |VER | ULEN |  UNAME   | PLEN |  PASSWD  |
     * +----+------+----------+------+----------+
     *
     * Response:
     * +----+--------+
     * |VER | STATUS |
     * +----+--------+
     */
    client(stream: Duplex, cb) {
      let state = STATE_VERSION;

      function onData(chunk: Buffer): void {
        let i = 0;
        const len = chunk.length;

        while (i < len) {
          switch (state) {
            case STATE_VERSION:
              if (chunk[i] !== 0x01) {
                stream.removeListener('data', onData);
                cb(new Error(`Unsupported auth response version: ${chunk[i]}`));
                return;
              }
              i++;
              state = STATE_STATUS;
              break;

            case STATE_STATUS: {
              const status = chunk[i];
              i++;
              state = STATE_VERSION;
              // Remove listener BEFORE unshift — unshift triggers a synchronous
              // re-entrant 'data' event and the old listener must not fire again.
              stream.removeListener('data', onData);
              if (i < len) {
                (stream as NodeJS.ReadableStream & { unshift: (b: Buffer) => void }).unshift(
                  chunk.slice(i),
                );
              }
              cb(status === 0x00 || new Error('Authentication failed'));
              return;
            }
          }
        }
      }

      stream.on('data', onData);

      // Send credentials to the server
      const buf = Buffer.allocUnsafe(3 + userlen + passlen);
      buf[0] = 0x01; // sub-negotiation version
      buf[1] = userlen;
      buf.write(staticUser!, 2, userlen);
      buf[2 + userlen] = passlen;
      buf.write(staticPass!, 3 + userlen, passlen);
      stream.write(buf);
    },
  };
}
