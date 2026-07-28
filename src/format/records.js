import { invariant } from "../errors.js";

const LENGTH_BYTES = 4;

export function frameRecord(recordBytes) {
  const bytes = Buffer.from(recordBytes);
  invariant(bytes.length <= 0xffff_ffff, "RECORD_LENGTH", "Record exceeds the unsigned 32-bit length limit");
  const result = Buffer.allocUnsafe(LENGTH_BYTES + bytes.length);
  result.writeUInt32BE(bytes.length, 0);
  bytes.copy(result, LENGTH_BYTES);
  return result;
}

export function readFramedRecords(bytes, expectedCount, { maxRecordBytes = 16 * 1024 * 1024 } = {}) {
  const input = Buffer.from(bytes);
  const records = [];
  let offset = 0;

  while (offset < input.length) {
    invariant(input.length - offset >= LENGTH_BYTES, "RECORD_TRUNCATED", "Record block ends during a length prefix");
    const length = input.readUInt32BE(offset);
    offset += LENGTH_BYTES;
    invariant(length <= maxRecordBytes, "RECORD_LIMIT", `Record declares ${length} bytes, exceeding the ${maxRecordBytes} byte limit`);
    invariant(input.length - offset >= length, "RECORD_TRUNCATED", "Record block ends during a record payload");
    records.push(input.subarray(offset, offset + length));
    offset += length;
  }

  invariant(records.length === expectedCount, "RECORD_COUNT", `Expected ${expectedCount} records but decoded ${records.length}`);
  return records;
}
