import { describe, it, expect } from 'vitest';
import { Duplex } from 'stream';
import { ServerParser } from '../src/server-parser.js';
import { ClientParser } from '../src/client-parser.js';
import { ATYP, CMD, REP } from '../src/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock readable-only Duplex that can have data pushed into it.
 * Writes by the parser (pause/resume control) are discarded.
 * This avoids PassThrough's echo behavior where writes reappear as reads.
 */
function makePushableStream(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      cb(); // discard
    },
  });
}
function buildGreeting(methods: number[]): Buffer {
  const buf = Buffer.allocUnsafe(2 + methods.length);
  buf[0] = 0x05;
  buf[1] = methods.length;
  for (let i = 0; i < methods.length; i++) buf[2 + i] = methods[i];
  return buf;
}

/**
 * Build a SOCKS5 CONNECT request for an IPv4 destination.
 * VER=5, CMD=CONNECT, RSV=0, ATYP=IPv4, DST.ADDR, DST.PORT
 */
function buildIPv4Request(ip: string, port: number): Buffer {
  const parts = ip.split('.').map(Number);
  const buf = Buffer.allocUnsafe(10); // 4 header + 4 addr + 2 port
  buf[0] = 0x05;
  buf[1] = CMD.CONNECT;
  buf[2] = 0x00;
  buf[3] = ATYP.IPv4;
  buf[4] = parts[0];
  buf[5] = parts[1];
  buf[6] = parts[2];
  buf[7] = parts[3];
  buf.writeUInt16BE(port, 8);
  return buf;
}

/**
 * Build a SOCKS5 CONNECT request for a domain name destination.
 */
function buildDomainRequest(domain: string, port: number): Buffer {
  const domainBuf = Buffer.from(domain, 'utf8');
  const buf = Buffer.allocUnsafe(7 + domainBuf.length);
  buf[0] = 0x05;
  buf[1] = CMD.CONNECT;
  buf[2] = 0x00;
  buf[3] = ATYP.NAME;
  buf[4] = domainBuf.length;
  domainBuf.copy(buf, 5);
  buf.writeUInt16BE(port, 5 + domainBuf.length);
  return buf;
}

// ---------------------------------------------------------------------------
// ServerParser
// ---------------------------------------------------------------------------

describe('ServerParser', () => {
  it('emits "methods" with the offered auth methods', () => {
    return new Promise<void>((resolve, reject) => {
      const stream = makePushableStream();
      const parser = new ServerParser(stream);

      parser.on('methods', (methods) => {
        try {
          expect(methods).toBeInstanceOf(Buffer);
          expect(methods.length).toBe(1);
          expect(methods[0]).toBe(0x00); // NO_AUTH
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.push(buildGreeting([0x00]));
    });
  });

  it('emits "methods" for multiple offered methods', () => {
    return new Promise<void>((resolve, reject) => {
      const stream = makePushableStream();
      const parser = new ServerParser(stream);

      parser.on('methods', (methods) => {
        try {
          expect(methods.length).toBe(2);
          expect(Array.from(methods)).toContain(0x00);
          expect(Array.from(methods)).toContain(0x02);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.push(buildGreeting([0x00, 0x02]));
    });
  });

  it('emits "error" for wrong SOCKS version', () => {
    return new Promise<void>((resolve, reject) => {
      const stream = makePushableStream();
      const parser = new ServerParser(stream);

      parser.on('error', (err) => {
        try {
          expect(err.message).toMatch(/Incompatible SOCKS protocol version/);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.push(Buffer.from([0x04, 0x01, 0x00])); // SOCKS4 version
    });
  });

  it('emits "request" for an IPv4 CONNECT request', () => {
    return new Promise<void>((resolve, reject) => {
      const stream = makePushableStream();
      const parser = new ServerParser(stream);
      parser.authed = true; // skip methods phase

      parser.on('request', (info) => {
        try {
          expect(info.cmd).toBe('connect');
          expect(info.dstAddr).toBe('93.184.216.34');
          expect(info.dstPort).toBe(80);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      // authed=true — still need to send the version byte first
      stream.push(Buffer.concat([Buffer.from([0x05]), buildIPv4Request('93.184.216.34', 80).slice(1)]));
    });
  });

  it('emits "request" for a domain name CONNECT request', () => {
    return new Promise<void>((resolve, reject) => {
      const stream = makePushableStream();
      const parser = new ServerParser(stream);
      parser.authed = true;

      parser.on('request', (info) => {
        try {
          expect(info.cmd).toBe('connect');
          expect(info.dstAddr).toBe('example.com');
          expect(info.dstPort).toBe(443);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.push(
        Buffer.concat([Buffer.from([0x05]), buildDomainRequest('example.com', 443).slice(1)]),
      );
    });
  });

  it('emits "error" for an invalid command type', () => {
    return new Promise<void>((resolve, reject) => {
      const stream = makePushableStream();
      const parser = new ServerParser(stream);
      parser.authed = true;

      parser.on('error', (err) => {
        try {
          expect(err.message).toMatch(/Invalid request command/);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      // Send version 0x05 then an invalid command 0xFF
      stream.push(Buffer.from([0x05, 0xff, 0x00, ATYP.IPv4, 0, 0, 0, 0, 0, 80]));
    });
  });

  it('handles chunked data arriving in multiple pushes', () => {
    return new Promise<void>((resolve, reject) => {
      const stream = makePushableStream();
      const parser = new ServerParser(stream);

      parser.on('methods', (methods) => {
        try {
          expect(methods.length).toBe(1);
          expect(methods[0]).toBe(0x00);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      const full = buildGreeting([0x00]);
      // Send one byte at a time
      for (const byte of full) {
        stream.push(Buffer.from([byte]));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// ClientParser
// ---------------------------------------------------------------------------

describe('ClientParser', () => {
  /**
   * Build a server method selection response.
   * +----+--------+
   * |VER | METHOD |
   * +----+--------+
   */
  function buildMethodResponse(method: number): Buffer {
    return Buffer.from([0x05, method]);
  }

  /**
   * Build a SOCKS5 success reply with an IPv4 bound address.
   * +----+-----+-------+------+----------+----------+
   * |VER | REP |  RSV  | ATYP | BND.ADDR | BND.PORT |
   * +----+-----+-------+------+----------+----------+
   */
  function buildIPv4Reply(ip: string, port: number): Buffer {
    const parts = ip.split('.').map(Number);
    const buf = Buffer.allocUnsafe(10);
    buf[0] = 0x05;
    buf[1] = REP.SUCCESS;
    buf[2] = 0x00;
    buf[3] = ATYP.IPv4;
    buf[4] = parts[0];
    buf[5] = parts[1];
    buf[6] = parts[2];
    buf[7] = parts[3];
    buf.writeUInt16BE(port, 8);
    return buf;
  }

  it('emits "method" with the chosen method byte', () => {
    return new Promise<void>((resolve, reject) => {
      const stream = makePushableStream();
      const parser = new ClientParser(stream);

      parser.on('method', (method) => {
        try {
          expect(method).toBe(0x00); // NO_AUTH
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.push(buildMethodResponse(0x00));
    });
  });

  it('emits "reply" with bound address and port on success', () => {
    return new Promise<void>((resolve, reject) => {
      const stream = makePushableStream();
      const parser = new ClientParser(stream);
      parser.authed = true; // skip method phase

      parser.on('reply', (info) => {
        try {
          expect(info.bndAddr).toBe('127.0.0.1');
          expect(info.bndPort).toBe(54321);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.push(Buffer.concat([Buffer.from([0x05]), buildIPv4Reply('127.0.0.1', 54321).slice(1)]));
    });
  });

  it('emits "error" with the correct code on non-SUCCESS reply', () => {
    return new Promise<void>((resolve, reject) => {
      const stream = makePushableStream();
      const parser = new ClientParser(stream);
      parser.authed = true;

      parser.on('error', (err) => {
        try {
          expect((err as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.push(
        Buffer.from([0x05, REP.CONNREFUSED, 0x00, ATYP.IPv4, 0, 0, 0, 0, 0, 0]),
      );
    });
  });

  it('emits "error" for wrong SOCKS version in reply', () => {
    return new Promise<void>((resolve, reject) => {
      const stream = makePushableStream();
      const parser = new ClientParser(stream);

      parser.on('error', (err) => {
        try {
          expect(err.message).toMatch(/Incompatible SOCKS protocol version/);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.push(Buffer.from([0x04, 0x00]));
    });
  });
});
