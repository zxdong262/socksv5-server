import { describe, it, expect } from 'vitest';
import { ipbytes } from '../src/utils.js';

describe('ipbytes', () => {
  describe('IPv4', () => {
    it('converts a standard IPv4 address', () => {
      expect(ipbytes('192.168.1.1')).toEqual([192, 168, 1, 1]);
    });

    it('converts 0.0.0.0', () => {
      expect(ipbytes('0.0.0.0')).toEqual([0, 0, 0, 0]);
    });

    it('converts 127.0.0.1', () => {
      expect(ipbytes('127.0.0.1')).toEqual([127, 0, 0, 1]);
    });

    it('converts 255.255.255.255', () => {
      expect(ipbytes('255.255.255.255')).toEqual([255, 255, 255, 255]);
    });

    it('returns a 4-element array', () => {
      expect(ipbytes('10.0.0.1')).toHaveLength(4);
    });
  });

  describe('IPv6', () => {
    it('converts the loopback address ::1', () => {
      const bytes = ipbytes('::1');
      expect(bytes).toHaveLength(16);
      // All bytes zero except the last, which is 1
      expect(bytes.slice(0, 15)).toEqual(new Array(15).fill(0));
      expect(bytes[15]).toBe(1);
    });

    it('converts :: (all zeros)', () => {
      const bytes = ipbytes('::');
      expect(bytes).toHaveLength(16);
      expect(bytes).toEqual(new Array(16).fill(0));
    });

    it('converts a full IPv6 address', () => {
      const bytes = ipbytes('2001:0db8:0000:0000:0000:0000:0000:0001');
      expect(bytes).toHaveLength(16);
      expect(bytes[0]).toBe(0x20);
      expect(bytes[1]).toBe(0x01);
      expect(bytes[2]).toBe(0x0d);
      expect(bytes[3]).toBe(0xb8);
      expect(bytes[15]).toBe(0x01);
    });

    it('converts a compressed IPv6 address 2001:db8::1', () => {
      const bytes = ipbytes('2001:db8::1');
      expect(bytes).toHaveLength(16);
      expect(bytes[0]).toBe(0x20);
      expect(bytes[1]).toBe(0x01);
      expect(bytes[2]).toBe(0x0d);
      expect(bytes[3]).toBe(0xb8);
      expect(bytes[15]).toBe(0x01);
    });
  });

  describe('invalid input', () => {
    it('throws for a hostname (not an IP)', () => {
      expect(() => ipbytes('example.com')).toThrow('Not a valid IP address');
    });

    it('throws for an empty string', () => {
      expect(() => ipbytes('')).toThrow('Not a valid IP address');
    });
  });
});
