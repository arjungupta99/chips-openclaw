/**
 * Chips's ids: a prefix and 26 characters of Crockford base32, the first `0` to `7` (Chips's
 * `connect/custom` docs). The bridge mints its ids from OpenClaw's own, so a retry after a restart
 * names the same run, step or approval, and Chips answers it as a duplicate.
 */

import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 128 bits as 26 base32 characters; the two spare bits keep the first character at 7 or below. */
function encode(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.subarray(0, 16).toString("hex")}`);
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** An id for `from`, the same every time; or a fresh one when there is nothing to derive it from. */
export function chipsId(prefix: string, from?: string): string {
  const bytes = from === undefined ? randomBytes(16) : createHash("sha256").update(from).digest();
  return `${prefix}_${encode(bytes)}`;
}
