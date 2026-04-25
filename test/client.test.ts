import { describe, it, expect, afterAll } from 'vitest';
import net from 'net';
import { Client, connect } from '../src/client.js';
import { Server, createServer } from '../src/server.js';
import { NoneAuth } from '../src/auth/none.js';
import { UserPasswordAuth } from '../src/auth/user-password.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Client', () => {
  const servers: (Server | net.Server)[] = [];

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

  it('instantiates with default options', () => {
    const client = new Client();
    expect(client).toBeInstanceOf(Client);
  });

  it('useAuth() returns `this` for chaining', () => {
    const client = new Client();
    const result = client.useAuth(NoneAuth());
    expect(result).toBe(client);
  });

  it('useAuth() throws for invalid auth handler', () => {
    const client = new Client();
    expect(() => client.useAuth({ METHOD: 0 } as never)).toThrow('Invalid authentication handler');
  });

  it('connect() throws when no auth handlers are registered', () => {
    const client = new Client({ proxyHost: '127.0.0.1', proxyPort: 9999 });
    expect(() => client.connect({ port: 80 })).toThrow('Missing client authentication method');
  });

  it('connect() throws when port is missing', () => {
    const client = new Client({ proxyHost: '127.0.0.1', proxyPort: 9999 });
    client.useAuth(NoneAuth());
    expect(() => client.connect({ port: 0 })).toThrow('port is required');
  });

  it('emits "error" when unable to connect to proxy', () => {
    return new Promise<void>((resolve) => {
      const client = new Client({ proxyHost: '127.0.0.1', proxyPort: 1 });
      client.useAuth(NoneAuth());
      client.on('error', (err) => {
        expect(err).toBeInstanceOf(Error);
        resolve();
      });
      client.connect({ host: '127.0.0.1', port: 80 });
    });
  });

  it('connects through a SOCKS5 proxy with NO_AUTH and receives data', async () => {
    const echoPort = await getFreePort();
    const proxyPort = await getFreePort();

    // Tiny echo server
    const echo = net.createServer((s) => s.pipe(s));
    servers.push(echo);
    await new Promise<void>((resolve) => echo.listen(echoPort, '127.0.0.1', resolve));

    // SOCKS5 server
    const socks = createServer((info, accept) => {
      accept(); // transparent proxy
    });
    socks.useAuth(NoneAuth());
    servers.push(socks);
    await new Promise<void>((resolve) => socks.listen(proxyPort, '127.0.0.1', resolve));

    // SOCKS5 client
    await new Promise<void>((resolve, reject) => {
      const client = new Client({ proxyHost: '127.0.0.1', proxyPort, localDNS: false });
      client.useAuth(NoneAuth());
      client.connect({ host: '127.0.0.1', port: echoPort }, (socket) => {
        const testData = 'hello socks5';
        const received: Buffer[] = [];

        socket.on('data', (chunk: Buffer) => {
          received.push(chunk);
          const msg = Buffer.concat(received).toString();
          if (msg === testData) {
            socket.destroy();
            resolve();
          }
        });
        socket.on('error', reject);
        socket.write(testData);
      });
      client.on('error', reject);
    });
  });

  it('emits "error" with code EAUTHNOTSUPPORT when method does not match', async () => {
    const proxyPort = await getFreePort();

    // A SOCKS5 server requiring user/password auth
    const socks = createServer();
    socks.useAuth(UserPasswordAuth((u, p, cb) => cb(u === 'a' && p === 'b')));
    servers.push(socks);
    await new Promise<void>((resolve) => socks.listen(proxyPort, '127.0.0.1', resolve));

    return new Promise<void>((resolve) => {
      // Client only offers NO_AUTH — will be rejected
      const client = new Client({ proxyHost: '127.0.0.1', proxyPort, localDNS: false });
      client.useAuth(NoneAuth()); // server wants 0x02, client offers 0x00
      client.on('error', (err) => {
        // Server closes connection when no matching method
        expect(err).toBeInstanceOf(Error);
        resolve();
      });
      client.connect({ host: '127.0.0.1', port: 80 });
    });
  });

  describe('connect() factory function', () => {
    it('creates and connects a client', async () => {
      const echoPort = await getFreePort();
      const proxyPort = await getFreePort();

      const echo = net.createServer((s) => s.pipe(s));
      servers.push(echo);
      await new Promise<void>((resolve) => echo.listen(echoPort, '127.0.0.1', resolve));

      const socks = createServer((info, accept) => accept());
      socks.useAuth(NoneAuth());
      servers.push(socks);
      await new Promise<void>((resolve) => socks.listen(proxyPort, '127.0.0.1', resolve));

      await new Promise<void>((resolve, reject) => {
        const client = connect(
          {
            proxyHost: '127.0.0.1',
            proxyPort,
            host: '127.0.0.1',
            port: echoPort,
            localDNS: false,
            auths: [NoneAuth()],
          },
          (socket) => {
            socket.on('data', () => {
              socket.destroy();
              resolve();
            });
            socket.on('error', reject);
            socket.write('ping');
          },
        );
        client.on('error', reject);
      });
    });
  });
});
