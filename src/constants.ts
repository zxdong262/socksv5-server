/**
 * SOCKS5 protocol command codes.
 * Sent by the client to indicate the type of connection requested.
 */
export const CMD = {
  /** Establish a TCP/IP stream connection */
  CONNECT: 0x01,
  /** Establish a TCP/IP port binding */
  BIND: 0x02,
  /** Associate a UDP port for relay */
  UDP: 0x03,
} as const;

export type CmdValue = (typeof CMD)[keyof typeof CMD];

/**
 * SOCKS5 address type codes.
 * Indicates the format of the destination address field.
 */
export const ATYP = {
  /** IPv4 address — 4 bytes */
  IPv4: 0x01,
  /** Domain name — prefixed with 1-byte length */
  NAME: 0x03,
  /** IPv6 address — 16 bytes */
  IPv6: 0x04,
} as const;

export type AtypValue = (typeof ATYP)[keyof typeof ATYP];

/**
 * SOCKS5 reply codes.
 * Used by the server to indicate the result of a request.
 */
export const REP = {
  /** Request succeeded */
  SUCCESS: 0x00,
  /** General SOCKS server failure */
  GENFAIL: 0x01,
  /** Connection not allowed by ruleset */
  DISALLOW: 0x02,
  /** Network unreachable */
  NETUNREACH: 0x03,
  /** Host unreachable */
  HOSTUNREACH: 0x04,
  /** Connection refused */
  CONNREFUSED: 0x05,
  /** TTL expired */
  TTLEXPIRED: 0x06,
  /** Command not supported */
  CMDUNSUPP: 0x07,
  /** Address type not supported */
  ATYPUNSUPP: 0x08,
} as const;

export type RepValue = (typeof REP)[keyof typeof REP];
