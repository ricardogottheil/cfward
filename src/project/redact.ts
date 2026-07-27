import { Transform } from "node:stream";

export const REDACTION_MARKER = "[cfward: redacted CLOUDFLARE_API_TOKEN]";

function replaceAll(haystack: Buffer, needle: Buffer, mask: Buffer): Buffer {
  let index = haystack.indexOf(needle);
  if (index === -1) return haystack;

  const parts: Buffer[] = [];
  let from = 0;
  while (index !== -1) {
    parts.push(haystack.subarray(from, index), mask);
    from = index + needle.length;
    index = haystack.indexOf(needle, from);
  }
  parts.push(haystack.subarray(from));
  return Buffer.concat(parts);
}

/**
 * How many trailing bytes of `buf` could still grow into a match once more
 * output arrives: the length of the longest suffix of `buf` that is also a
 * prefix of `needle`.
 *
 * Holding back a flat `needle.length - 1` bytes instead would be equally safe
 * and badly wrong in practice. Output shorter than the token would be withheld
 * until something else happened to be printed — so a child that writes a prompt
 * and then waits for an answer (`? Deploy to production? (y/N)`) would look
 * hung, because the prompt never reaches the terminal. Bytes that cannot begin
 * a match are not worth holding, so they go out immediately.
 */
function pendingPrefixLength(buf: Buffer, needle: Buffer): number {
  const longest = Math.min(buf.length, needle.length - 1);
  for (let length = longest; length > 0; length--) {
    if (buf.compare(needle, 0, length, buf.length - length, buf.length) === 0) {
      return length;
    }
  }
  return 0;
}

/**
 * Scrubs the token out of a child process's output.
 *
 * wrangler has no obligation to keep our secret out of its error messages, and
 * an unlucky stack trace or a `--verbose` run can echo the whole token into a
 * terminal, a CI log or a scrollback buffer that outlives the process.
 *
 * Operates on bytes rather than decoded strings for two reasons: a multi-byte
 * character split across chunks would be corrupted by decoding each chunk
 * independently, and a token split across chunks would slip through a
 * per-chunk search. The last `needle.length - 1` bytes of every chunk are held
 * back until the following chunk arrives, so a match straddling the boundary is
 * still caught.
 */
export function createRedactor(secret: string): Transform {
  const needle = Buffer.from(secret, "utf8");
  const mask = Buffer.from(REDACTION_MARKER, "utf8");

  if (needle.length === 0) {
    return new Transform({
      transform(chunk, _encoding, done) {
        done(null, chunk);
      },
    });
  }

  let carry = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const scrubbed = replaceAll(Buffer.concat([carry, chunk]), needle, mask);
      const emitUpTo = scrubbed.length - pendingPrefixLength(scrubbed, needle);
      carry = Buffer.from(scrubbed.subarray(emitUpTo));
      done(null, scrubbed.subarray(0, emitUpTo));
    },
    flush(done) {
      done(null, carry);
    },
  });
}
