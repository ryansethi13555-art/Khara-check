/**
 * Schema-less Protocol Buffers reader. Apps and some web SDKs send binary protobuf, and
 * without the vendor's schema the field names are unknown, but the wire format still says
 * where every string and nested message starts and ends. This turns a message into plain
 * JSON keyed by field number, e.g. {"2": {"1": "metformin 500"}}, so the ordinary matcher can
 * search it and report a path like "2.1".
 *
 * Bytes that are neither readable text nor a valid nested message become lowercase hex,
 * which is how a raw 32-byte SHA-256 hash inside a message becomes findable.
 */

type Value = string | number | Value[] | { [field: string]: Value | Value[] };

const MAX_DEPTH = 6;

function readVarint(buf: Uint8Array, pos: number): [bigint, number] | null {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) return null;
    const byte = buf[pos++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  return null;
}

function printable(bytes: Uint8Array): string | null {
  if (!bytes.length) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let ok = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127 && c !== 0xfffd)) ok++;
  }
  return ok / [...text].length >= 0.95 ? text : null;
}

/** Parses a whole buffer as a message, or returns null if it is not one. */
export function parseMessage(buf: Uint8Array, depth = 0): Record<string, Value> | null {
  if (!buf.length || depth > MAX_DEPTH) return null;
  const out: Record<string, Value> = {};
  let pos = 0;
  let fields = 0;
  const put = (field: string, value: Value): void => {
    const existing = out[field];
    if (existing === undefined) out[field] = value;
    else if (Array.isArray(existing) && (existing as unknown as { _repeated?: true })._repeated) existing.push(value);
    else {
      const list = [existing, value] as Value[] & { _repeated?: true };
      Object.defineProperty(list, '_repeated', { value: true, enumerable: false });
      out[field] = list;
    }
  };
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    if (!key) return null;
    pos = key[1];
    const field = Number(key[0] >> 3n);
    const wire = Number(key[0] & 7n);
    if (field < 1 || field > 536_870_911) return null;
    switch (wire) {
      case 0: {
        const v = readVarint(buf, pos);
        if (!v) return null;
        pos = v[1];
        put(String(field), v[0] <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v[0]) : v[0].toString());
        break;
      }
      case 1:
        if (pos + 8 > buf.length) return null;
        put(String(field), Buffer.from(buf.subarray(pos, pos + 8)).readBigUInt64LE().toString());
        pos += 8;
        break;
      case 5:
        if (pos + 4 > buf.length) return null;
        put(String(field), Buffer.from(buf.subarray(pos, pos + 4)).readUInt32LE());
        pos += 4;
        break;
      case 2: {
        const len = readVarint(buf, pos);
        if (!len) return null;
        pos = len[1];
        const n = Number(len[0]);
        if (pos + n > buf.length) return null;
        const bytes = buf.subarray(pos, pos + n);
        pos += n;
        // Text without control characters is a string. Anything else is tried as a nested
        // message first (its tag bytes are often control characters such as 0x0a), then as
        // text with line breaks, and finally kept as hex.
        const text = printable(bytes);
        const clean = text !== null && !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(text);
        const nested = clean ? null : parseMessage(bytes, depth + 1);
        put(String(field), clean ? text! : (nested ?? text ?? Buffer.from(bytes).toString('hex')));
        break;
      }
      default:
        return null; // groups (3, 4) are obsolete; anything else means this is not protobuf
    }
    fields++;
  }
  return fields ? out : null;
}

/** Plain JSON text for a protobuf message, or null if the bytes are not one worth reading. */
export function protobufToJson(buf: Uint8Array): string | null {
  // Very short buffers parse as "protobuf" by accident far too often.
  if (buf.length < 6) return null;
  const message = parseMessage(buf);
  if (!message) return null;
  // Require at least one length-delimited field: a message of bare numbers carries no text.
  const json = JSON.stringify(message);
  return /"[^"]{4,}"/.test(json.replace(/"\d+":/g, '')) ? json : null;
}
