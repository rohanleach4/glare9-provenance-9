import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCanonical,
  decompressBlock,
  verifyRoutingEpochBytes,
  verifySegmentBytes,
} from "../src/index.js";
import { FrameReader, FRAME_TYPES, G9P_MAGIC } from "../src/format/framing.js";
import { readFramedRecords } from "../src/format/records.js";

test("canonical decoding rejects input, collection and depth limits before unbounded work", () => {
  assert.throws(
    () => decodeCanonical(Buffer.alloc(17), { maxBytes: 16 }),
    (error) => error.code === "DECODE_INPUT_LIMIT",
  );
  assert.throws(
    () => decodeCanonical(Buffer.from([0x40, 0x02, 0x00, 0x00]), { maxCollectionEntries: 1 }),
    (error) => error.code === "DECODE_ARRAY_LIMIT",
  );
  assert.throws(
    () => decodeCanonical(Buffer.from([0x40, 0x01, 0x40, 0x01, 0x00]), { maxDepth: 1 }),
    (error) => error.code === "DECODE_DEPTH",
  );
});

test("frame and record readers reject declared lengths before slicing payloads", () => {
  const frame = Buffer.concat([
    G9P_MAGIC,
    Buffer.from(FRAME_TYPES.header, "ascii"),
    Buffer.from([0x00, 0x00, 0x10, 0x00]),
  ]);
  const reader = new FrameReader(frame, { maxFrameBytes: 1024 });
  reader.readMagic();
  assert.throws(() => reader.readFrame(FRAME_TYPES.header), (error) => error.code === "FORMAT_FRAME_LIMIT");

  assert.throws(
    () => readFramedRecords(Buffer.from([0x00, 0x00, 0x10, 0x00]), 1, { maxRecordBytes: 1024 }),
    (error) => error.code === "RECORD_LIMIT",
  );
});

test("decompression refuses declared output above the configured ceiling", () => {
  assert.throws(
    () => decompressBlock(Buffer.from([0x00]), 1025, 1024),
    (error) => error.code === "DECOMPRESS_LIMIT",
  );
});

test("byte verifiers enforce whole-object limits before parsing hostile input", async () => {
  await assert.rejects(
    verifySegmentBytes(Buffer.alloc(17), { limits: { maxFileBytes: 16 } }),
    (error) => error.code === "VERIFY_FILE_LIMIT",
  );
  await assert.rejects(
    verifyRoutingEpochBytes(Buffer.alloc(17), { limits: { maxFileBytes: 16 } }),
    (error) => error.code === "EPOCH_FILE_LIMIT",
  );
});
