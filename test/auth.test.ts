import { describe, it, expect } from 'vitest';
import { NoneAuth } from '../src/auth/none.js';
import { UserPasswordAuth } from '../src/auth/user-password.js';
import { Duplex } from 'stream';

// ---------------------------------------------------------------------------
// Test helper — a Duplex where:
//   - push(data)  → data is readable by the handler's 'data' listener
//   - write(data) → data is captured in writtenChunks (no echo back to read side)
// This correctly models a real network socket: what you write goes OUT over the
// network, and what arrives from the peer comes IN as readable data.
// ---------------------------------------------------------------------------
function makeMockSocket(): {
  stream: Duplex;
  getWritten: () => Buffer;
} {
  const writtenChunks: Buffer[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      writtenChunks.push(chunk);
      cb();
    },
  });
  return {
    stream,
    getWritten: () => Buffer.concat(writtenChunks),
  };
}

// ---------------------------------------------------------------------------
// NoneAuth
// ---------------------------------------------------------------------------

describe('NoneAuth', () => {
  it('has METHOD 0x00', () => {
    expect(NoneAuth().METHOD).toBe(0x00);
  });

  it('server handler calls cb(true) immediately', () => {
    return new Promise<void>((resolve) => {
      const { stream } = makeMockSocket();
      NoneAuth().server(stream, (result) => {
        expect(result).toBe(true);
        resolve();
      });
    });
  });

  it('client handler calls cb(true) immediately', () => {
    return new Promise<void>((resolve) => {
      const { stream } = makeMockSocket();
      NoneAuth().client(stream, (result) => {
        expect(result).toBe(true);
        resolve();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// UserPasswordAuth
// ---------------------------------------------------------------------------

describe('UserPasswordAuth', () => {
  it('has METHOD 0x02', () => {
    const handler = UserPasswordAuth((u, p, cb) => cb(true));
    expect(handler.METHOD).toBe(0x02);
  });

  it('throws when constructed with invalid arguments', () => {
    expect(() => UserPasswordAuth(123 as unknown as string)).toThrow();
  });

  it('throws when username exceeds 255 bytes', () => {
    expect(() => UserPasswordAuth('a'.repeat(256), 'pass')).toThrow('Username too long');
  });

  it('throws when password exceeds 255 bytes', () => {
    expect(() => UserPasswordAuth('user', 'b'.repeat(256))).toThrow('Password too long');
  });

  describe('client mode', () => {
    it('sends credentials and resolves on STATUS=0x00', () => {
      return new Promise<void>((resolve, reject) => {
        const handler = UserPasswordAuth('admin', 'secret');
        const { stream } = makeMockSocket();

        handler.client(stream, (result) => {
          try {
            expect(result).toBe(true);
            resolve();
          } catch (e) {
            reject(e);
          }
        });

        // Simulate server sending auth success: VER=0x01, STATUS=0x00
        stream.push(Buffer.from([0x01, 0x00]));
      });
    });

    it('calls cb with Error on STATUS != 0x00', () => {
      return new Promise<void>((resolve, reject) => {
        const handler = UserPasswordAuth('admin', 'wrongpass');
        const { stream } = makeMockSocket();

        handler.client(stream, (result) => {
          try {
            expect(result).toBeInstanceOf(Error);
            resolve();
          } catch (e) {
            reject(e);
          }
        });

        // Simulate server sending auth failure: VER=0x01, STATUS=0x01
        stream.push(Buffer.from([0x01, 0x01]));
      });
    });
  });

  describe('server mode (verifier function)', () => {
    /**
     * Build a packet:
     * +----+------+----------+------+----------+
     * |VER | ULEN |  UNAME   | PLEN |  PASSWD  |
     * +----+------+----------+------+----------+
     */
    function buildCredentialPacket(user: string, pass: string): Buffer {
      const uBuf = Buffer.from(user, 'utf8');
      const pBuf = Buffer.from(pass, 'utf8');
      const buf = Buffer.allocUnsafe(3 + uBuf.length + pBuf.length);
      buf[0] = 0x01; // version
      buf[1] = uBuf.length;
      uBuf.copy(buf, 2);
      buf[2 + uBuf.length] = pBuf.length;
      pBuf.copy(buf, 3 + uBuf.length);
      return buf;
    }

    it('accepts correct credentials', () => {
      return new Promise<void>((resolve, reject) => {
        const handler = UserPasswordAuth((user, pass, cb) => {
          cb(user === 'admin' && pass === 'secret');
        });

        const { stream, getWritten } = makeMockSocket();

        handler.server(stream, (result) => {
          try {
            expect(result).toBe(true);
            // Server should have written success response [0x01, 0x00]
            const response = getWritten();
            expect(response[0]).toBe(0x01);
            expect(response[1]).toBe(0x00);
            resolve();
          } catch (e) {
            reject(e);
          }
        });

        // Push credentials from "client" to the server handler
        stream.push(buildCredentialPacket('admin', 'secret'));
      });
    });

    it('rejects incorrect credentials', () => {
      return new Promise<void>((resolve, reject) => {
        const handler = UserPasswordAuth((user, pass, cb) => {
          cb(user === 'admin' && pass === 'correct');
        });

        const { stream } = makeMockSocket();

        handler.server(stream, (result) => {
          try {
            expect(result).toBeInstanceOf(Error);
            resolve();
          } catch (e) {
            reject(e);
          }
        });

        stream.push(buildCredentialPacket('admin', 'wrong'));
      });
    });
  });
});
