# socksv5-server

A modern TypeScript rewrite of [socksv5](https://github.com/mscdex/socksv5) (originally by [Brian White / mscdex](https://github.com/mscdex)), with zero runtime dependencies. Designed as a drop-in replacement for `socksv5-electron` in [electerm](https://github.com/electerm/electerm) SSH tunnels.

## Features

- **SOCKS5 server** — accept and proxy connections, intercept for custom piping (SSH tunnels)
- **SOCKS5 client** — connect through a SOCKS5 proxy
- **Authentication** — No-Auth (`0x00`) and Username/Password (`0x02`) handlers out of the box
- **HTTP/HTTPS agents** — route `http`/`https` requests through SOCKS5
- **Zero runtime dependencies** — pure Node.js built-ins only
- **TypeScript** — full type declarations included
- **Dual CJS/ESM output** — works in both CommonJS and ES module projects
- **Node.js 16+** compatible

## Credits

This package is a TypeScript rewrite of **[socksv5](https://github.com/mscdex/socksv5)** originally created by **[Brian White (mscdex)](https://github.com/mscdex)** and licensed under the MIT License.

Modifications and improvements made in this rewrite:
- Complete rewrite in TypeScript with strict typing
- Replaced deprecated `new Buffer()` calls with `Buffer.alloc()` / `Buffer.from()`
- Replaced `inherits(Class, EventEmitter)` prototype chain with native ES6 `class extends EventEmitter`
- Removed the `ipv6` npm dependency — IPv6 parsing is now handled by built-in Node.js APIs
- Added full JSDoc documentation
- Added dual CJS/ESM build output
- Added vitest test suite

## Installation

```bash
npm install socksv5-server
```

## Usage

### SOCKS5 Dynamic Forward (SSH tunnel)

This is the primary use-case — integrating with `ssh2` for SSH dynamic port forwarding (replaces `socksv5-electron` in electerm):

```ts
import { createServer, auth } from 'socksv5-server';

function dynamicForward({ conn, sshTunnelLocalPort, sshTunnelLocalHost = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const dproxyServer = createServer((info, accept, deny) => {
      conn.forwardOut(
        info.srcAddr, info.srcPort,
        info.dstAddr, info.dstPort,
        (err, stream) => {
          if (err) { deny(); return; }
          const clientSocket = accept(true);
          if (clientSocket) {
            stream.pipe(clientSocket).pipe(stream);
          }
        }
      );
    });

    dproxyServer.on('error', reject);
    dproxyServer.listen(sshTunnelLocalPort, sshTunnelLocalHost, () => {
      resolve(1);
    }).useAuth(auth.NoneAuth());

    conn.on('close', () => dproxyServer.close());
  });
}
```

### SOCKS5 Server

```ts
import { createServer, auth } from 'socksv5-server';

// Create a SOCKS5 server with no authentication
const server = createServer((info, accept, deny) => {
  console.log(`CONNECT ${info.srcAddr}:${info.srcPort} → ${info.dstAddr}:${info.dstPort}`);

  if (info.dstPort === 22) {
    deny(); // block SSH
    return;
  }

  accept(); // transparent proxy
});

server.useAuth(auth.NoneAuth());
server.listen(1080, '127.0.0.1', () => {
  console.log('SOCKS5 proxy listening on 127.0.0.1:1080');
});
```

### Username/Password Auth Server

```ts
import { createServer, auth } from 'socksv5-server';

const server = createServer((info, accept, deny) => {
  accept();
});

server.useAuth(
  auth.UserPasswordAuth((username, password, cb) => {
    cb(username === 'admin' && password === 'secret');
  })
);

server.listen(1080, '0.0.0.0');
```

### SOCKS5 Client

```ts
import { Client, auth } from 'socksv5-server';

const client = new Client({
  proxyHost: '127.0.0.1',
  proxyPort: 1080,
});

client.useAuth(auth.NoneAuth());

client.connect({ host: 'example.com', port: 80 }, (socket) => {
  socket.write('GET / HTTP/1.0\r\nHost: example.com\r\n\r\n');
  socket.pipe(process.stdout);
});

client.on('error', console.error);
```

### Using the `connect()` shorthand

```ts
import { connect, auth } from 'socksv5-server';

const client = connect(
  {
    proxyHost: '127.0.0.1',
    proxyPort: 1080,
    host: 'example.com',
    port: 80,
    auths: [auth.NoneAuth()],
  },
  (socket) => {
    socket.write('GET / HTTP/1.0\r\nHost: example.com\r\n\r\n');
    socket.pipe(process.stdout);
  },
);
```

### HTTP Agent

```ts
import http from 'http';
import { HttpAgent, auth } from 'socksv5-server';

const agent = new HttpAgent({
  proxyHost: '127.0.0.1',
  proxyPort: 1080,
  auths: [auth.NoneAuth()],
});

http.get({ host: 'example.com', path: '/', agent }, (res) => {
  res.pipe(process.stdout);
});
```

### HTTPS Agent

```ts
import https from 'https';
import { HttpsAgent, auth } from 'socksv5-server';

const agent = new HttpsAgent({
  proxyHost: '127.0.0.1',
  proxyPort: 1080,
  auths: [auth.NoneAuth()],
});

https.get({ host: 'example.com', path: '/', agent }, (res) => {
  res.pipe(process.stdout);
});
```

## API

### `createServer(options?, listener?)`

Creates a new SOCKS5 server.

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `ServerOptions \| ConnectionListener` | Server options or connection listener shorthand |
| `listener` | `ConnectionListener` | Optional connection event handler |

Returns: `Server`

### `class Server`

#### `server.useAuth(handler: AuthHandler): this`

Register an authentication handler. Handlers are tried in order.

#### `server.listen(...args): this`

Start listening — same signature as `net.Server.listen()`.

#### `server.close(cb?): this`

Stop accepting new connections.

#### `server.address(): net.AddressInfo | string | null`

Returns the bound address.

### Connection listener

```ts
(info: RequestInfo, accept: AcceptFn, deny: DenyFn) => void
```

| Parameter | Description |
|-----------|-------------|
| `info.srcAddr` | Client's IP address |
| `info.srcPort` | Client's port |
| `info.dstAddr` | Requested destination address |
| `info.dstPort` | Requested destination port |
| `info.cmd` | `'connect'` \| `'bind'` \| `'udp'` |
| `accept(intercept?)` | Accept the connection. Pass `true` to get the raw socket for custom piping. |
| `deny()` | Reject the connection with a DISALLOW reply. |

### `class Client`

#### `client.useAuth(handler: AuthHandler): this`

Register an authentication handler.

#### `client.connect(options: ConnectOptions, cb?): this`

Connect through the proxy.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | `'localhost'` | Destination host |
| `port` | `number` | — | Destination port (required) |
| `proxyHost` | `string` | — | Override proxy host |
| `proxyPort` | `number` | — | Override proxy port |
| `localDNS` | `boolean` | `true` | Resolve hostname locally |
| `strictLocalDNS` | `boolean` | `true` | Abort on local DNS failure |

### `connect(options, cb?)`

Shorthand for creating a `Client` and calling `connect()` in one step.

### Authentication Handlers

#### `auth.NoneAuth()` / `NoneAuth()`

No-auth handler (METHOD `0x00`). Allows all connections without credentials.

#### `auth.UserPasswordAuth(verifier)` / `UserPasswordAuth(verifier)`

Server-side username/password handler. `verifier` is `(user, pass, cb) => void`.

#### `auth.UserPasswordAuth(username, password)` / `UserPasswordAuth(username, password)`

Client-side username/password handler with static credentials.

### Protocol Constants

```ts
import { CMD, ATYP, REP } from 'socksv5-server';

CMD.CONNECT   // 0x01
ATYP.IPv4     // 0x01
ATYP.NAME     // 0x03
ATYP.IPv6     // 0x04
REP.SUCCESS   // 0x00
// ...
```

## Scripts

```bash
npm run build          # Build CJS + ESM outputs to dist/
npm run test           # Run vitest tests once
npm run test:watch     # Run vitest in watch mode
npm run test:coverage  # Run tests with coverage report
npm run lint           # TypeScript type-check only (no emit)
```

## License

MIT — see [LICENSE](LICENSE)

Original work Copyright (c) 2013 Brian White. All rights reserved.  
Rewrite Copyright (c) 2024 zxdong262.
