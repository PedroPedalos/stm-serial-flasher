/**
 * Convert one byte to a two-character lowercase hexadecimal string.
 */
export function b2hexstr(byte: number): string {
  return ('00' + byte.toString(16)).substr(-2);
}

/**
 * Convert a number to a fixed-size big-endian byte array.
 */
export function num2a(number: number, arraySize: number): number[] {
  let temp = number;
  const result: number[] = [];

  for (let i = 0; i < arraySize; i += 1) {
    result.unshift(temp & 0xFF);
    temp >>= 8;
  }

  return result;
}
