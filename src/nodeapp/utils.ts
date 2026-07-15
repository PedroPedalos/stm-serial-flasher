import path from 'node:path';

export type DataRecord = {
  type: 'data';
  length?: number;
  address: number;
  data: Uint8Array;
  checksum?: number;
};

export type StartRecord = {
  type: 'start';
  length?: number;
  address: number;
  data?: Uint8Array;
  checksum?: number;
};

export type ParsedRecord = DataRecord | StartRecord;

function sum(array: Uint8Array): number {
  return array.reduce((a, b) => a + b, 0);
}

function hexstr2uintarray(str: string): Uint8Array {
  const result = new Uint8Array(str.length / 2);
  for (let i = 0; i < str.length / 2; i += 1) {
    result[i] = parseInt(str.substr(i * 2, 2), 16);
  }
  return result;
}

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

export function extension(fileName: string | null | undefined): string | null {
  const ext = path.extname(fileName || '');
  return ext.startsWith('.') ? ext.substring(1).toLowerCase() : null;
}

export function num2a(number: number, arraySize: number): number[] {
  let temp = number;
  const result: number[] = [];

  for (let i = 0; i < arraySize; i += 1) {
    result.unshift(temp & 0xFF);
    temp >>= 8;
  }

  return result;
}

export function b2hexstr(byte: number): string {
  return ('00' + byte.toString(16)).substr(-2);
}

export function countData(records: ParsedRecord[]): number {
  let total = 0;
  for (const rec of records) {
    if (rec.type === 'data') {
      total += 1;
    }
  }
  return total;
}
