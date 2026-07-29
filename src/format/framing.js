import { invariant } from "../errors.js";

export const G9P_MAGIC_V1 = Buffer.from([0x47, 0x39, 0x50, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
export const G9P_MAGIC_V2 = Buffer.from([0x47, 0x39, 0x50, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
export const G9P_MAGIC = G9P_MAGIC_V1;
export const FRAME_HEADER_BYTES = 8;

export const FRAME_TYPES = Object.freeze({
  header: "HEAD",
  headerV2: "HED2",
  block: "BLK1",
  manifest: "MNF1",
  manifestV2: "MNF2",
  routingEpoch: "RTE1",
  signature: "SIG1",
  end: "END!",
});

export function encodeFrame(type, payload = Buffer.alloc(0)) {
  invariant(typeof type === "string" && /^[A-Z0-9!]{4}$/u.test(type), "FRAME_TYPE", "Frame type must contain four uppercase ASCII characters");
  const payloadBytes = Buffer.from(payload);
  invariant(payloadBytes.length <= 0xffff_ffff, "FRAME_LENGTH", "Frame payload exceeds the unsigned 32-bit length limit");

  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payloadBytes.length);
  frame.write(type, 0, 4, "ascii");
  frame.writeUInt32BE(payloadBytes.length, 4);
  payloadBytes.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export class FrameReader {
  constructor(bytes, { maxFrameBytes = 64 * 1024 * 1024 } = {}) {
    this.bytes = Buffer.from(bytes);
    this.offset = 0;
    this.maxFrameBytes = maxFrameBytes;
  }

  readMagic(expectedMagic = G9P_MAGIC) {
    invariant(this.bytes.length >= expectedMagic.length, "FORMAT_TRUNCATED", "File is shorter than the G9P magic header");
    const actual = this.bytes.subarray(0, expectedMagic.length);
    const version = expectedMagic[expectedMagic.length - 1];
    invariant(actual.equals(expectedMagic), "FORMAT_MAGIC", `File does not contain the G9P version ${version} magic header`);
    this.offset = expectedMagic.length;
  }

  remaining() {
    return this.bytes.length - this.offset;
  }

  peekType() {
    invariant(this.remaining() >= FRAME_HEADER_BYTES, "FORMAT_TRUNCATED", "File is truncated before the next frame header");
    return this.bytes.toString("ascii", this.offset, this.offset + 4);
  }

  readFrame(expectedType) {
    invariant(this.remaining() >= FRAME_HEADER_BYTES, "FORMAT_TRUNCATED", "File is truncated before a complete frame header");
    const start = this.offset;
    const type = this.bytes.toString("ascii", start, start + 4);
    const length = this.bytes.readUInt32BE(start + 4);

    invariant(type === expectedType, "FORMAT_FRAME_ORDER", `Expected ${expectedType} frame but found ${type}`);
    invariant(length <= this.maxFrameBytes, "FORMAT_FRAME_LIMIT", `${type} frame exceeds the ${this.maxFrameBytes} byte limit`);
    invariant(this.remaining() >= FRAME_HEADER_BYTES + length, "FORMAT_TRUNCATED", `${type} frame is truncated`);

    const payloadStart = start + FRAME_HEADER_BYTES;
    const payload = this.bytes.subarray(payloadStart, payloadStart + length);
    this.offset = payloadStart + length;

    return {
      type,
      payload,
      frameBytes: this.bytes.subarray(start, this.offset),
      start,
      end: this.offset,
    };
  }

  assertEnd() {
    invariant(this.remaining() === 0, "FORMAT_TRAILING", "File contains bytes after the end frame");
  }
}
