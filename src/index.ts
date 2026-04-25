/**
 * socksv5-server
 *
 * A modern TypeScript rewrite of socksv5/socksv5-electron by Brian White.
 * Provides a SOCKS5 server and client implementation for Node.js 16+.
 *
 * Primarily designed to support SSH dynamic port forwarding in electerm
 * (via `ssh-tunnel.js`), replacing the original socksv5-electron package.
 *
 * @example Basic server (no auth)
 * ```ts
 * import { createServer, auth } from 'socksv5-server';
 *
 * const server = createServer((info, accept, deny) => {
 *   const socket = accept(true);
 *   if (socket) {
 *     // pipe into SSH channel, etc.
 *   }
 * });
 * server.useAuth(auth.NoneAuth());
 * server.listen(1080, '127.0.0.1');
 * ```
 *
 * @example Client
 * ```ts
 * import { connect, auth } from 'socksv5-server';
 *
 * const client = connect(
 *   { proxyHost: '127.0.0.1', proxyPort: 1080, host: 'example.com', port: 80,
 *     auths: [auth.NoneAuth()] },
 *   (socket) => socket.pipe(process.stdout),
 * );
 * ```
 *
 * @module socksv5-server
 */

// Core server
export { Server, createServer } from './server.js';
export type { ServerOptions, AcceptFn, DenyFn, ConnectionListener } from './server.js';

// Core client
export { Client, connect, createConnection } from './client.js';
export type { ClientOptions, ConnectOptions } from './client.js';

// HTTP/HTTPS agents
export { HttpAgent, HttpsAgent } from './agents.js';

// Protocol constants
export { CMD, ATYP, REP } from './constants.js';
export type { CmdValue, AtypValue, RepValue } from './constants.js';

// Parsers (useful for advanced use-cases / custom implementations)
export { ServerParser } from './server-parser.js';
export type { RequestInfo } from './server-parser.js';
export { ClientParser } from './client-parser.js';
export type { ReplyInfo } from './client-parser.js';

// Utilities
export { ipbytes } from './utils.js';

// Auth — re-exported as a `auth` namespace and as individual named exports
import { NoneAuth } from './auth/none.js';
import { UserPasswordAuth } from './auth/user-password.js';
export type { AuthHandler, AuthCallback } from './auth/types.js';
export type { UserPassVerifier, UserPassVerifyCallback } from './auth/user-password.js';
export { NoneAuth, UserPasswordAuth };

/**
 * Authentication handlers namespace.
 *
 * Matches the original `socks.auth.None()` / `socks.auth.UserPassword()` API.
 *
 * @example
 * ```ts
 * import { auth } from 'socksv5-server';
 * server.useAuth(auth.NoneAuth());
 * server.useAuth(auth.UserPasswordAuth('user', 'pass'));
 * ```
 */
export const auth = {
  /** No-auth handler — allows all connections without credentials */
  NoneAuth,
  /** Username/password handler (RFC 1929) */
  UserPasswordAuth,
  // Aliases matching the original socksv5 API
  /** @alias NoneAuth — matches original `socks.auth.None()` */
  None: NoneAuth,
  /** @alias UserPasswordAuth — matches original `socks.auth.UserPassword()` */
  UserPassword: UserPasswordAuth,
} as const;
