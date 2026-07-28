import {
  constants,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";

import { fail, invariant } from "./errors.js";

export const ZSTD_PROFILE = Object.freeze({
  algorithm: "zstd",
  profile: "g9p-zstd-v1",
  level: 3,
  checksum: true,
  contentSize: true,
});

const compressionOptions = Object.freeze({
  params: {
    [constants.ZSTD_c_compressionLevel]: ZSTD_PROFILE.level,
    [constants.ZSTD_c_contentSizeFlag]: 1,
    [constants.ZSTD_c_checksumFlag]: 1,
    [constants.ZSTD_c_dictIDFlag]: 0,
    [constants.ZSTD_c_nbWorkers]: 0,
  },
});

export function compressBlock(bytes) {
  invariant(bytes instanceof Uint8Array, "COMPRESS_INPUT", "Compression input must be bytes");
  try {
    return zstdCompressSync(bytes, compressionOptions);
  } catch (error) {
    fail("COMPRESS_FAILED", "Zstandard compression failed", error);
  }
}

export function decompressBlock(bytes, expectedLength, maxOutputLength) {
  invariant(bytes instanceof Uint8Array, "DECOMPRESS_INPUT", "Compressed block must be bytes");
  invariant(Number.isSafeInteger(expectedLength) && expectedLength >= 0, "DECOMPRESS_LENGTH", "Expected decompressed length is invalid");
  invariant(expectedLength <= maxOutputLength, "DECOMPRESS_LIMIT", `Block declares ${expectedLength} decompressed bytes, exceeding the ${maxOutputLength} byte limit`);

  try {
    const output = zstdDecompressSync(bytes, { maxOutputLength });
    invariant(output.length === expectedLength, "DECOMPRESS_LENGTH_MISMATCH", `Expected ${expectedLength} decompressed bytes but received ${output.length}`);
    return output;
  } catch (error) {
    if (error?.code?.startsWith?.("DECOMPRESS_")) throw error;
    fail("DECOMPRESS_FAILED", "Zstandard decompression failed", error);
  }
}
