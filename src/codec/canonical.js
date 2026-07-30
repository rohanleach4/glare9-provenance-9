import { fail, invariant } from "../errors.js";

const TAG_NULL = 0x00;
const TAG_FALSE = 0x01;
const TAG_TRUE = 0x02;
const TAG_INTEGER = 0x10;
const TAG_FLOAT64 = 0x11;
const TAG_STRING = 0x20;
const TAG_BYTES = 0x30;
const TAG_ARRAY = 0x40;
const TAG_MAP = 0x50;
const MAX_VARUINT_BYTES = 10;

const textDecoder = new TextDecoder("utf-8", { fatal: true });

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxCollectionEntries: 1_000_000,
  maxDepth: 64,
});

function encodeVarUint(value) {
  invariant(typeof value === "bigint" && value >= 0n, "ENCODE_VARUINT", "Unsigned varint value must be a non-negative bigint");

  const bytes = [];
  let remaining = value;
  do {
    invariant(bytes.length < MAX_VARUINT_BYTES, "ENCODE_VARUINT_LIMIT", `Unsigned varint exceeds ${MAX_VARUINT_BYTES} bytes`);
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);

  return Buffer.from(bytes);
}

function encodeLength(value) {
  invariant(Number.isSafeInteger(value) && value >= 0, "ENCODE_LENGTH", "Length must be a non-negative safe integer");
  return encodeVarUint(BigInt(value));
}

function encodeStringValue(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([TAG_STRING]), encodeLength(bytes.length), bytes]);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeValue(value, depth, limits) {
  invariant(depth <= limits.maxDepth, "ENCODE_DEPTH", `Canonical value exceeds maximum depth ${limits.maxDepth}`);

  if (value === null) return Buffer.from([TAG_NULL]);
  if (value === false) return Buffer.from([TAG_FALSE]);
  if (value === true) return Buffer.from([TAG_TRUE]);

  if (typeof value === "number") {
    invariant(Number.isFinite(value), "ENCODE_NUMBER", "Canonical numbers must be finite");

    if (Number.isSafeInteger(value)) {
      const integer = BigInt(value);
      const zigZag = integer >= 0n ? integer * 2n : (-integer * 2n) - 1n;
      return Buffer.concat([Buffer.from([TAG_INTEGER]), encodeVarUint(zigZag)]);
    }

    const encoded = Buffer.allocUnsafe(9);
    encoded[0] = TAG_FLOAT64;
    encoded.writeDoubleBE(value, 1);
    return encoded;
  }

  if (typeof value === "string") {
    return encodeStringValue(value);
  }

  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    invariant(bytes.length <= limits.maxBytes, "ENCODE_BYTES_LIMIT", `Byte string exceeds maximum length ${limits.maxBytes}`);
    return Buffer.concat([Buffer.from([TAG_BYTES]), encodeLength(bytes.length), bytes]);
  }

  if (Array.isArray(value)) {
    invariant(value.length <= limits.maxCollectionEntries, "ENCODE_ARRAY_LIMIT", `Array exceeds maximum entries ${limits.maxCollectionEntries}`);
    return Buffer.concat([
      Buffer.from([TAG_ARRAY]),
      encodeLength(value.length),
      ...value.map((item) => encodeValue(item, depth + 1, limits)),
    ]);
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(([key, entryValue]) => ({
      key,
      keyBytes: Buffer.from(key, "utf8"),
      entryValue,
    }));

    invariant(entries.length <= limits.maxCollectionEntries, "ENCODE_MAP_LIMIT", `Map exceeds maximum entries ${limits.maxCollectionEntries}`);
    entries.sort((left, right) => Buffer.compare(left.keyBytes, right.keyBytes));

    return Buffer.concat([
      Buffer.from([TAG_MAP]),
      encodeLength(entries.length),
      ...entries.flatMap(({ key, entryValue }) => [
        encodeStringValue(key),
        encodeValue(entryValue, depth + 1, limits),
      ]),
    ]);
  }

  fail("ENCODE_TYPE", `Unsupported canonical value type: ${typeof value}`);
}

class Decoder {
  constructor(bytes, limits) {
    this.bytes = Buffer.from(bytes);
    this.offset = 0;
    this.limits = limits;
  }

  remaining() {
    return this.bytes.length - this.offset;
  }

  readByte() {
    invariant(this.remaining() >= 1, "DECODE_TRUNCATED", "Canonical value is truncated");
    return this.bytes[this.offset++];
  }

  readBytes(length) {
    invariant(Number.isSafeInteger(length) && length >= 0, "DECODE_LENGTH", "Decoded length is invalid");
    invariant(length <= this.limits.maxBytes, "DECODE_BYTES_LIMIT", `Decoded byte string exceeds maximum length ${this.limits.maxBytes}`);
    invariant(this.remaining() >= length, "DECODE_TRUNCATED", "Canonical value is truncated");
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  readVarUint() {
    let value = 0n;
    let shift = 0n;
    let count = 0;
    let finalPayload = 0;

    while (true) {
      invariant(count < 10, "DECODE_VARUINT", "Unsigned varint is too large");
      const byte = this.readByte();
      finalPayload = byte & 0x7f;
      value |= BigInt(finalPayload) << shift;
      count += 1;

      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }

    invariant(count === 1 || finalPayload !== 0, "DECODE_NON_CANONICAL", "Unsigned varint is not minimally encoded");
    return value;
  }

  readLength() {
    const value = this.readVarUint();
    invariant(value <= BigInt(Number.MAX_SAFE_INTEGER), "DECODE_LENGTH", "Decoded length exceeds the safe integer range");
    return Number(value);
  }

  decodeString() {
    const length = this.readLength();
    const bytes = this.readBytes(length);
    try {
      return { value: textDecoder.decode(bytes), bytes };
    } catch (error) {
      fail("DECODE_UTF8", "String is not valid UTF-8", error);
    }
  }

  decodeValue(depth = 0) {
    invariant(depth <= this.limits.maxDepth, "DECODE_DEPTH", `Canonical value exceeds maximum depth ${this.limits.maxDepth}`);
    const tag = this.readByte();

    if (tag === TAG_NULL) return null;
    if (tag === TAG_FALSE) return false;
    if (tag === TAG_TRUE) return true;

    if (tag === TAG_INTEGER) {
      const zigZag = this.readVarUint();
      const integer = (zigZag & 1n) === 0n ? zigZag / 2n : -((zigZag + 1n) / 2n);
      invariant(integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER), "DECODE_INTEGER", "Integer exceeds the safe integer range");
      return Number(integer);
    }

    if (tag === TAG_FLOAT64) {
      const bytes = this.readBytes(8);
      const value = bytes.readDoubleBE(0);
      invariant(Number.isFinite(value), "DECODE_NUMBER", "Decoded floating-point number is not finite");
      invariant(!Number.isSafeInteger(value), "DECODE_NON_CANONICAL", "Safe integers must use the integer encoding");
      return value;
    }

    if (tag === TAG_STRING) {
      return this.decodeString().value;
    }

    if (tag === TAG_BYTES) {
      return Uint8Array.from(this.readBytes(this.readLength()));
    }

    if (tag === TAG_ARRAY) {
      const length = this.readLength();
      invariant(length <= this.limits.maxCollectionEntries, "DECODE_ARRAY_LIMIT", `Array exceeds maximum entries ${this.limits.maxCollectionEntries}`);
      const result = [];
      for (let index = 0; index < length; index += 1) {
        result.push(this.decodeValue(depth + 1));
      }
      return result;
    }

    if (tag === TAG_MAP) {
      const length = this.readLength();
      invariant(length <= this.limits.maxCollectionEntries, "DECODE_MAP_LIMIT", `Map exceeds maximum entries ${this.limits.maxCollectionEntries}`);
      const result = Object.create(null);
      let previousKeyBytes = null;

      for (let index = 0; index < length; index += 1) {
        invariant(this.readByte() === TAG_STRING, "DECODE_MAP_KEY", "Map keys must be strings");
        const { value: key, bytes: keyBytes } = this.decodeString();
        if (previousKeyBytes !== null) {
          invariant(Buffer.compare(previousKeyBytes, keyBytes) < 0, "DECODE_MAP_ORDER", "Map keys are duplicated or not in canonical order");
        }
        previousKeyBytes = keyBytes;
        result[key] = this.decodeValue(depth + 1);
      }
      return result;
    }

    fail("DECODE_TAG", `Unknown canonical type tag 0x${tag.toString(16).padStart(2, "0")}`);
  }
}

export function encodeCanonical(value, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  return encodeValue(value, 0, limits);
}

export function decodeCanonical(bytes, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  invariant(bytes instanceof Uint8Array, "DECODE_INPUT", "Canonical input must be bytes");
  invariant(bytes.byteLength <= limits.maxBytes, "DECODE_INPUT_LIMIT", `Canonical input exceeds maximum length ${limits.maxBytes}`);

  const decoder = new Decoder(bytes, limits);
  const value = decoder.decodeValue();
  invariant(decoder.remaining() === 0, "DECODE_TRAILING", "Canonical value contains trailing bytes");

  const reencoded = encodeCanonical(value, limits);
  invariant(Buffer.from(bytes).equals(reencoded), "DECODE_NON_CANONICAL", "Canonical value has a non-canonical representation");
  return value;
}

export const canonicalLimits = DEFAULT_LIMITS;
