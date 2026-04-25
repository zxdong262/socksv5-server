import type { Duplex } from 'stream';

/**
 * Callback for authentication result.
 * - `true` — authentication succeeded
 * - `Error` — authentication failed (optionally with a message)
 */
export type AuthCallback = (result: true | Error) => void;

/**
 * A SOCKS5 authentication handler.
 *
 * Each handler provides both a server-side and client-side implementation
 * for a specific authentication method (identified by `METHOD`).
 *
 * @example
 * // Custom auth handler
 * const myAuth: AuthHandler = {
 *   METHOD: 0x00,
 *   server(stream, cb) { cb(true); },
 *   client(stream, cb) { cb(true); },
 * };
 */
export interface AuthHandler {
  /** SOCKS5 authentication method identifier byte */
  METHOD: number;

  /**
   * Server-side authentication handler.
   * Called when a client connects and the server needs to authenticate it.
   *
   * @param stream - The client socket (already paused)
   * @param cb - Call with `true` on success, `Error` on failure
   */
  server(stream: Duplex, cb: AuthCallback): void;

  /**
   * Client-side authentication handler.
   * Called when the server has chosen this auth method and the client
   * must send credentials.
   *
   * @param stream - The server socket
   * @param cb - Call with `true` on success, `Error` on failure
   */
  client(stream: Duplex, cb: AuthCallback): void;
}
