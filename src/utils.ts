import net from 'net';

/**
 * Expand a potentially compressed IPv6 address (e.g. `::1`, `2001:db8::1`)
 * into its full 16-byte representation and return as an array of numbers.
 *
 * This is a pure Node.js implementation with no external dependencies.
 */
function expandIPv6ToBytes(str: string): number[] {
  const bytes: number[] = new Array(16).fill(0);

  // Split on '::' to detect compressed zeros
  const halves = str.split('::');
  let left: string[];
  let right: string[];

  if (halves.length === 2) {
    left = halves[0] ? halves[0].split(':') : [];
    right = halves[1] ? halves[1].split(':') : [];
  } else {
    left = str.split(':');
    right = [];
  }

  // Fill the missing groups with '0'
  const missing = 8 - left.length - right.length;
  const allGroups = [...left, ...Array<string>(missing).fill('0'), ...right];

  for (let i = 0; i < 8; i++) {
    const group = parseInt(allGroups[i] ?? '0', 16);
    bytes[i * 2] = (group >>> 8) & 0xff;
    bytes[i * 2 + 1] = group & 0xff;
  }

  return bytes;
}

/**
 * Convert an IP address string to an array of bytes.
 *
 * - IPv4 → 4-element array (e.g. `[192, 168, 1, 1]`)
 * - IPv6 → 16-element array (big-endian groups)
 *
 * @param str - A valid IPv4 or IPv6 address string
 * @returns Array of bytes representing the IP address
 * @throws {Error} If the string is not a valid IP address
 *
 * @example
 * ipbytes('192.168.1.1')   // [192, 168, 1, 1]
 * ipbytes('::1')           // [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]
 */
export function ipbytes(str: string): number[] {
  const type = net.isIP(str);

  if (type === 4) {
    const parts = str.split('.', 4);
    const bytes: number[] = new Array(4);
    for (let i = 0; i < 4; i++) {
      const val = Number(parts[i]);
      if (isNaN(val) || val < 0 || val > 255) {
        throw new Error(`Error parsing IPv4 address: ${str}`);
      }
      bytes[i] = val;
    }
    return bytes;
  }

  if (type === 6) {
    return expandIPv6ToBytes(str);
  }

  throw new Error(`Not a valid IP address: ${str}`);
}
