import type { AuthHandler } from './types.js';

/**
 * Creates a "No Authentication Required" handler for SOCKS5 (METHOD `0x00`).
 *
 * This is the simplest authentication method — it allows all connections
 * without requiring any credentials. Suitable for trusted local proxies
 * (e.g. loopback-only SSH dynamic tunnels).
 *
 * @returns An {@link AuthHandler} for the no-auth method
 *
 * @example
 * server.useAuth(NoneAuth());
 *
 * @example
 * // Equivalent electerm usage:
 * dproxyServer.useAuth(socks.auth.None());
 */
export function NoneAuth(): AuthHandler {
  return {
    METHOD: 0x00,

    server(_stream, cb) {
      // No credentials needed — immediately accept
      cb(true);
    },

    client(_stream, cb) {
      // No credentials to send — immediately proceed
      cb(true);
    },
  };
}
