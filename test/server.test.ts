import { describe, it, expect, afterAll } from 'vitest';
import net from 'net';
import { Server, createServer } from '../src/server.js';
import { NoneAuth } from '../src/auth/none.js';
import { UserPasswordAuth } from '../src/auth/user-password.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a free local TCP port by letting the OS assign one. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

/**
 * Perform a raw SOCKS5 NO_AUTH handshake + CONNECT request over a plain socket.
 *
 * Returns the 10-byte success reply (VER REP RSV ATYP [4 addr bytes] [2 port bytes]).
 */
function rawSocksConnect(
  proxyPort: number,
  dstHost: string,
  dstPort: number,
): Promise<{ reply: Buffer; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      // Step 1: send greeting — VER=5, NMETHODS=1, METHOD=0x00 (NO_AUTH)
      socket.write(Buffer.from([0x05, 0x01, 0x00]));

      let phase = 'method-selection';
      const chunks: Buffer[] = [];

      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        const data = Buffer.concat(chunks);

        if (phase === 'method-selection' && data.length >= 2) {
          // Expect: VER=5, METHOD=0x00
          if (data[0] !== 0x05 || data[1] !== 0x00) {
            return reject(new Error(`Unexpected method response: ${data.toString('hex')}`));
          }
          chunks.length = 0;
          phase = 'connect-request';

          // Step 2: send CONNECT for an IPv4 address
          const parts = dstHost.split('.').map(Number);
          const req = Buffer.allocUnsafe(10);
          req[0] = 0x05; // VER
          req[1] = 0x01; // CMD = CONNECT
          req[2] = 0x00; // RSV
          req[3] = 0x01; // ATYP = IPv4
          req[4] = parts[0];
          req[5] = parts[1];
          req[6] = parts[2];
          req[7] = parts[3];
          req.writeUInt16BE(dstPort, 8);
          socket.write(req);
        } else if (phase === 'connect-request' && data.length >= 10) {
          phase = 'done';
          resolve({ reply: data.slice(0, 10), socket });
        }
      });
    });

    socket.on('error', reject);
    socket.setTimeout(3000, () => reject(new Error('Timeout')));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Server', () => {
  const servers: Server[] = [];

  afterAll(async () => {
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );
  });

  it('creates a server via new Server()', () => {
    const server = new Server();
    expect(server).toBeInstanceOf(Server);
  });

  it('creates a server via createServer()', () => {
    const server = createServer();
    expect(server).toBeInstanceOf(Server);
  });

  it('useAuth() returns `this` for chaining', () => {
    const server = new Server();
    const result = server.useAuth(NoneAuth());
    expect(result).toBe(server);
  });

  it('useAuth() throws for invalid handler', () => {
    const server = new Server();
    expect(() => server.useAuth({ METHOD: 0 } as never)).toThrow('Invalid authentication handler');
  });

  it('throws when more than 255 auth handlers are registered', () => {
    const server = new Server();
    // METHOD values must be unique in practice, but the limit is purely count-based
    for (let i = 0; i < 255; i++) {
      server.useAuth({ METHOD: i, server: (_s, cb) => cb(true), client: (_s, cb) => cb(true) });
    }
    expect(() =>
      server.useAuth({ METHOD: 255, server: (_s, cb) => cb(true), client: (_s, cb) => cb(true) }),
    ).toThrow('Too many authentication handlers');
  });

  it('listens and returns address()', async () => {
    const port = await getFreePort();
    const server = createServer().useAuth(NoneAuth());
    servers.push(server);

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    const addr = server.address() as net.AddressInfo;
    expect(addr.port).toBe(port);
    expect(addr.address).toBe('127.0.0.1');
  });

  it('completes a NO_AUTH SOCKS5 handshake and returns a success reply', async () => {
    const proxyPort = await getFreePort();
    const echoPort = await getFreePort();

    // A tiny echo server to be the SOCKS5 target
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((resolve) => echo.listen(echoPort, '127.0.0.1', resolve));

    const server = createServer((info, accept, deny) => {
      // Only allow connections to our echo server
      if (info.dstPort === echoPort) {
        accept(); // transparent proxy
      } else {
        deny();
      }
    });
    server.useAuth(NoneAuth());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(proxyPort, '127.0.0.1', resolve));

    const { reply, socket } = await rawSocksConnect(proxyPort, '127.0.0.1', echoPort);
    socket.destroy();

    expect(reply[0]).toBe(0x05); // VER
    expect(reply[1]).toBe(0x00); // REP = SUCCESS

    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  it('emits "error" for network-level errors', async () => {
    const server = createServer().useAuth(NoneAuth());
    // Not listening — force an internal error by attempting to listen on the same port twice
    const port = await getFreePort();
    const other = net.createServer().listen(port, '127.0.0.1');
    await new Promise<void>((resolve) => other.once('listening', resolve));

    const errorPromise = new Promise<Error>((resolve) => server.on('error', resolve));
    server.listen(port, '127.0.0.1');

    const err = await errorPromise;
    expect((err as NodeJS.ErrnoException).code).toBe('EADDRINUSE');

    other.close();
  });

  it('accepts with intercept=true and returns the raw socket', async () => {
    const proxyPort = await getFreePort();
    let interceptedSocket: net.Socket | undefined;

    const server = createServer((info, accept) => {
      interceptedSocket = accept(true);
    });
    server.useAuth(NoneAuth());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(proxyPort, '127.0.0.1', resolve));

    // Connect and do the handshake — the server will intercept the socket
    const clientSocket = net.connect(proxyPort, '127.0.0.1');
    await new Promise<void>((resolve) => clientSocket.once('connect', resolve));

    clientSocket.write(Buffer.from([0x05, 0x01, 0x00])); // greeting
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Send a CONNECT request
    const req = Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0, 80]);
    clientSocket.write(req);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    clientSocket.destroy();
    expect(interceptedSocket).toBeDefined();
  });

  it('applies UserPasswordAuth correctly', async () => {
    const proxyPort = await getFreePort();

    const server = createServer();
    server.useAuth(
      UserPasswordAuth((user, pass, cb) => {
        cb(user === 'user' && pass === 'pass');
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(proxyPort, '127.0.0.1', resolve));

    // Connect with wrong credentials — server should reject
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write(Buffer.from([0x05, 0x01, 0x02])); // offer METHOD=0x02 (USER_PASS)

        let buf = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length >= 2 && buf[0] === 0x05 && buf[1] === 0x02) {
            // Server chose user/pass auth — send wrong credentials
            const badUser = Buffer.from('wrong');
            const badPass = Buffer.from('creds');
            const cred = Buffer.allocUnsafe(3 + badUser.length + badPass.length);
            cred[0] = 0x01;
            cred[1] = badUser.length;
            badUser.copy(cred, 2);
            cred[2 + badUser.length] = badPass.length;
            badPass.copy(cred, 3 + badUser.length);
            socket.write(cred);
          }
        });

        socket.on('close', () => resolve());
        socket.on('error', () => resolve());
        socket.setTimeout(2000, () => {
          socket.destroy();
          resolve();
        });
      });
      socket.on('error', reject);
    });
  });
});
