import path from 'node:path';

/** Parsed data payload record (HEX/SREC). */
type DataRecord = {
  type: 'data';
  length?: number;
  address: number;
  data: Uint8Array;
  checksum?: number;
};

/** Parsed start-address record (HEX/SREC). */
type StartRecord = {
  type: 'start';
  length?: number;
  address: number;
  data?: Uint8Array;
  checksum?: number;
};

/** Unified record shape returned by parser helpers. */
export type ParsedRecord = DataRecord | StartRecord;

/** Sum helper used by parser checksum validation. */
function sum(array: Uint8Array): number {
  return array.reduce((a, b) => a + b, 0);
}

/** Convert hexadecimal text to raw byte array. */
function hexstr2uintarray(str: string): Uint8Array {
  const result = new Uint8Array(str.length / 2);
  for (let i = 0; i < str.length / 2; i += 1) {
    result[i] = parseInt(str.substr(i * 2, 2), 16);
  }
  return result;
}

/**
 * Merge adjacent parsed records into fixed-size contiguous data chunks.
 *
 * This is used by UART write flow to reduce command overhead.
 */
function packRecords(records: ParsedRecord[], blockSize: number): ParsedRecord[] {
  let offset = 0;
  const result: ParsedRecord[] = [];

  const minAddress = (): number => {
    let min = -1;
    for (const rec of records) {
      if (rec.type !== 'data') {
        continue;
      }
      if (min === -1 || rec.address < min) {
        min = rec.address;
      }
    }
    return min;
  };

  const findRecord = (address: number): DataRecord | null => {
    for (const rec of records) {
      if (rec.type === 'data' && rec.address === address) {
        return rec;
      }
    }
    return null;
  };

  const findStartRecord = (): StartRecord | null => {
    for (const rec of records) {
      if (rec.type === 'start') {
        return rec as StartRecord;
      }
    }
    return null;
  };

  while (true) {
    const startRec = findStartRecord();
    if (startRec) {
      result.push(startRec);
      records.splice(records.indexOf(startRec), 1);
      continue;
    }

    const startAddress = minAddress();
    if (startAddress === -1) {
      break;
    }

    const dataBuffer = new Uint8Array(blockSize);
    const newRecord: DataRecord = {
      type: 'data',
      address: startAddress,
      data: new Uint8Array(0)
    };

    while (true) {
      const rec = findRecord(startAddress + offset);
      if (!rec) {
        break;
      }
      if (offset + rec.data.length > blockSize) {
        break;
      }

      dataBuffer.set(rec.data, offset);
      records.splice(records.indexOf(rec), 1);
      offset += rec.data.length;
    }

    newRecord.data = offset < blockSize ? dataBuffer.subarray(0, offset) : dataBuffer;
    offset = 0;
    result.push(newRecord);
  }

  return result;
}

/**
 * Parse Motorola S-record content.
 *
 * @param combine When true, combine adjacent data records into blockSize chunks.
 */
export function parseSRec(combine: boolean, blockSize: number, fileContent: string): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  const lines = fileContent.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();

    if (line.length === 0) {
      continue;
    }

    if (line.charAt(0) !== 'S') {
      throw new Error('Invalid SRecord file format');
    }

    const type = parseInt(line.substr(1, 1), 10);
    let addrLength = 0;
    const record: {
      type: 'data' | 'start' | null;
      length?: number;
      address?: number;
      data?: Uint8Array;
      checksum?: number;
    } = { type: null };

    if (type === 1) {
      addrLength = 4;
      record.type = 'data';
    } else if (type === 3) {
      addrLength = 8;
      record.type = 'data';
    } else if (type === 9) {
      addrLength = 4;
      record.type = 'start';
    } else if (type === 7) {
      addrLength = 8;
      record.type = 'start';
    } else {
      continue;
    }

    record.length = parseInt(line.substr(2, 2), 16);
    record.address = parseInt(line.substr(4, addrLength), 16);
    record.data = hexstr2uintarray(line.substr(4 + addrLength, (record.length - 3) * 2));
    record.checksum = parseInt(line.substr(-2), 16);

    const checksum = (sum(hexstr2uintarray(line.substring(2, line.length - 2))) & 0xFF) ^ 0xFF;
    if (checksum !== record.checksum) {
      throw new Error('Checksum in line ' + (i + 1) + ' does not match');
    }

    records.push(record as ParsedRecord);
  }

  return combine ? packRecords(records, blockSize) : records;
}

/**
 * Parse Intel HEX content.
 *
 * @param combine When true, combine adjacent data records into blockSize chunks.
 */
export function parseHex(combine: boolean, blockSize: number, fileContent: string): ParsedRecord[] {
  const lines = fileContent.split('\n');
  const records: ParsedRecord[] = [];
  let base = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();

    if (line.length === 0) {
      continue;
    }

    if (line.charAt(0) !== ':') {
      throw new Error('Invalid HEX file format');
    }

    const type = parseInt(line.substr(7, 2), 16);
    const record: {
      type?: 'data' | 'start';
      length: number;
      address: number;
      data?: Uint8Array;
      checksum?: number;
    } = {
      length: parseInt(line.substr(1, 2), 16),
      address: parseInt(line.substr(3, 4), 16)
    };

    if (base > 0) {
      record.address += base;
    }

    record.data = hexstr2uintarray(line.substr(9, record.length * 2));
    record.checksum = parseInt(line.substr(-2), 16);

    const checksum = sum(hexstr2uintarray(line.substr(1))) % 256;
    if (checksum !== 0) {
      throw new Error('Checksum in line ' + (i + 1) + ' does not match');
    }

    if (type === 0) {
      record.type = 'data';
      records.push(record as ParsedRecord);
    } else if (type === 4) {
      base = (record.data[0] << 24) + (record.data[1] << 16);
    } else if (type === 5) {
      record.type = 'start';
      record.address = parseInt(line.substr(9, record.length * 2), 16);
      records.push(record as ParsedRecord);
    }
  }

  return combine ? packRecords(records, blockSize) : records;
}

/** Return lower-case file extension without leading dot, or null. */
export function extension(fileName: string | null | undefined): string | null {
  const ext = path.extname(fileName || '');
  return ext.startsWith('.') ? ext.substring(1).toLowerCase() : null;
}

/** Count payload-bearing records in a parsed record list. */
export function countData(records: ParsedRecord[]): number {
  let total = 0;
  for (const rec of records) {
    if (rec.type === 'data') {
      total += 1;
    }
  }
  return total;
}

type ParsedIntelHexLine = {
  byteCount: number;
  address: number;
  recordType: number;
  data: Uint8Array;
};

type ParsedIntelHexImage = {
  bytes: Map<number, number>;
  startLinearAddress: number | null;
};

/** Parse a single Intel HEX line and validate its checksum. */
function parseIntelHexLine(line: string, lineNumber: number): ParsedIntelHexLine {
  if (!line.startsWith(':')) {
    throw new Error('Invalid Intel HEX format at line ' + lineNumber + ': missing colon');
  }

  const payload = line.substring(1);
  if (payload.length < 10 || payload.length % 2 !== 0) {
    throw new Error('Invalid Intel HEX format at line ' + lineNumber + ': malformed payload length');
  }

  const raw = hexstr2uintarray(payload);
  if (sum(raw) % 256 !== 0) {
    throw new Error('Checksum mismatch at Intel HEX line ' + lineNumber);
  }

  const byteCount = raw[0];
  const address = (raw[1] << 8) | raw[2];
  const recordType = raw[3];
  const data = raw.subarray(4, raw.length - 1);

  if (data.length !== byteCount) {
    throw new Error('Invalid Intel HEX format at line ' + lineNumber + ': byte count does not match payload');
  }

  return {
    byteCount,
    address,
    recordType,
    data
  };
}

/** Parse Intel HEX into absolute-address bytes. */
function parseIntelHexImage(fileContent: string): ParsedIntelHexImage {
  const lines = fileContent.split('\n');
  const bytes = new Map<number, number>();
  let extendedLinearBase = 0;
  let extendedSegmentBase = 0;
  let addressingMode: 'linear' | 'segment' = 'linear';
  let startLinearAddress: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    const record = parseIntelHexLine(line, i + 1);

    if (record.recordType === 0x00) {
      const base = addressingMode === 'linear' ? extendedLinearBase : extendedSegmentBase;
      for (let j = 0; j < record.data.length; j += 1) {
        const absoluteAddress = base + record.address + j;
        bytes.set(absoluteAddress, record.data[j]);
      }
      continue;
    }

    if (record.recordType === 0x01) {
      break;
    }

    if (record.recordType === 0x02) {
      if (record.data.length !== 2) {
        throw new Error('Invalid type 02 record length in Intel HEX');
      }
      addressingMode = 'segment';
      extendedSegmentBase = (((record.data[0] << 8) | record.data[1]) << 4) >>> 0;
      continue;
    }

    if (record.recordType === 0x04) {
      if (record.data.length !== 2) {
        throw new Error('Invalid type 04 record length in Intel HEX');
      }
      addressingMode = 'linear';
      extendedLinearBase = (((record.data[0] << 8) | record.data[1]) << 16) >>> 0;
      continue;
    }

    if (record.recordType === 0x05) {
      if (record.data.length !== 4) {
        throw new Error('Invalid type 05 record length in Intel HEX');
      }
      startLinearAddress = (
        (record.data[0] << 24)
        | (record.data[1] << 16)
        | (record.data[2] << 8)
        | record.data[3]
      ) >>> 0;
      continue;
    }
  }

  return {
    bytes,
    startLinearAddress
  };
}

/** Build one Intel HEX line from record parts. */
function buildIntelHexLine(recordType: number, address: number, data: number[]): string {
  const length = data.length;
  const frame = new Uint8Array(4 + length + 1);
  frame[0] = length;
  frame[1] = (address >> 8) & 0xFF;
  frame[2] = address & 0xFF;
  frame[3] = recordType & 0xFF;

  for (let i = 0; i < length; i += 1) {
    frame[4 + i] = data[i] & 0xFF;
  }

  const checksum = ((0x100 - (sum(frame.subarray(0, frame.length - 1)) & 0xFF)) & 0xFF) >>> 0;
  frame[frame.length - 1] = checksum;

  let line = ':';
  for (const byte of frame) {
    line += byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return line;
}

/**
 * Merge two Intel HEX payloads into one HEX image.
 *
 * Throws on conflicting overlapping bytes to prevent silent corruption.
 */
export function mergeIntelHexContents(
  firstHex: string,
  secondHex: string
): { mergedHex: string; byteCount: number } {
  const first = parseIntelHexImage(firstHex);
  const second = parseIntelHexImage(secondHex);
  const merged = new Map<number, number>();

  for (const [address, value] of first.bytes) {
    merged.set(address, value);
  }

  for (const [address, value] of second.bytes) {
    const existing = merged.get(address);
    if (existing !== undefined && existing !== value) {
      throw new Error(
        'Conflicting overlap at address 0x'
        + address.toString(16).toUpperCase()
        + ': first=0x'
        + existing.toString(16).toUpperCase().padStart(2, '0')
        + ', second=0x'
        + value.toString(16).toUpperCase().padStart(2, '0')
      );
    }
    merged.set(address, value);
  }

  if (merged.size === 0) {
    throw new Error('Cannot merge Intel HEX files: no data records found');
  }

  const addresses = Array.from(merged.keys()).sort((a, b) => a - b);
  const lines: string[] = [];
  let currentUpper = -1;

  let index = 0;
  while (index < addresses.length) {
    const start = addresses[index];
    const upper = start >>> 16;
    if (upper !== currentUpper) {
      lines.push(buildIntelHexLine(0x04, 0x0000, [(upper >> 8) & 0xFF, upper & 0xFF]));
      currentUpper = upper;
    }

    const chunkBytes: number[] = [];
    const lowStart = start & 0xFFFF;
    let expected = start;

    while (index < addresses.length && chunkBytes.length < 16) {
      const addr = addresses[index];
      if (addr !== expected) {
        break;
      }

      if ((addr >>> 16) !== currentUpper) {
        break;
      }

      chunkBytes.push(merged.get(addr) as number);
      expected += 1;
      index += 1;
    }

    lines.push(buildIntelHexLine(0x00, lowStart, chunkBytes));
  }

  const startLinearAddress = second.startLinearAddress ?? first.startLinearAddress;
  if (startLinearAddress !== null) {
    lines.push(
      buildIntelHexLine(0x05, 0x0000, [
        (startLinearAddress >>> 24) & 0xFF,
        (startLinearAddress >>> 16) & 0xFF,
        (startLinearAddress >>> 8) & 0xFF,
        startLinearAddress & 0xFF
      ])
    );
  }

  lines.push(buildIntelHexLine(0x01, 0x0000, []));

  return {
    mergedHex: lines.join('\n') + '\n',
    byteCount: merged.size
  };
}
