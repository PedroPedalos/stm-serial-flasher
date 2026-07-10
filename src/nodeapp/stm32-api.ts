// @ts-nocheck
'use strict';

const tools = require('./utils');

const MAX_WRITE_BLOCK_SIZE_STM32 = 256;
const MAX_READ_BLOCK_SIZE = 256;

const RESET_PIN = 'dataTerminalReady';
const BOOT0_PIN = 'requestToSend';
const PIN_HIGH = false;
const PIN_LOW = true;

const SYNCHR = 0x7F;
const ACK = 0x79;

const CMD_GET = 0x00;
const CMD_GID = 0x02;
const CMD_GO = 0x21;
const CMD_WRITE = 0x31;
const CMD_ERASE = 0x43;
const CMD_EXTENDED_ERASE = 0x44;

function u8a(array) {
  return new Uint8Array(array);
}

class STM32Api {
  [key: string]: any;

  constructor(serial, logFn) {
    if (!serial) {
      throw new Error('Serial port object not provided');
    }

    this.serial = serial;
    this.log = typeof logFn === 'function' ? logFn : () => {};
    this.replyMode = false;
    this.writeBlockSize = MAX_WRITE_BLOCK_SIZE_STM32;
    this.readBlockSize = MAX_READ_BLOCK_SIZE;
    this.commands = [];
  }

  async connect(params) {
    this.log('Connecting with baudrate ' + params.baudrate + ' and reply mode ' + (params.replyMode ? 'on' : 'off'));

    if (this.serial.isOpen()) {
      throw new Error('Port already opened');
    }

    this.replyMode = params.replyMode || false;

    await this.serial.open({
      baudRate: parseInt(params.baudrate, 10),
      parity: this.replyMode ? 'none' : 'even'
    });

    const signal = {};
    signal[RESET_PIN] = PIN_HIGH;
    signal[BOOT0_PIN] = PIN_LOW;
    await this.serial.control(signal);
    await this.activateBootloader();
  }

  async disconnect() {
    const signal = {};
    signal[BOOT0_PIN] = PIN_LOW;

    if (this.serial.isOpen()) {
      await this.serial.control(signal);
      await this.resetTarget();
      await this.serial.close();
    }
  }

  async write(data, address, onProgress) {
    this.log('Writing ' + data.length + ' bytes to flash at address 0x' + address.toString(16) + ' using ' + this.writeBlockSize + ' bytes chunks');

    if (!this.serial.isOpen()) {
      throw new Error('Connection must be established before sending commands');
    }

    const blocksCount = Math.ceil(data.byteLength / this.writeBlockSize);
    let offset = 0;

    for (let i = 0; i < blocksCount; i += 1) {
      const blockData = (i < blocksCount - 1)
        ? data.subarray(offset, offset + this.writeBlockSize)
        : data.subarray(offset);

      offset += blockData.length;

      if (onProgress) {
        onProgress(i + 1, blocksCount);
      }

      await this.cmdWRITE(blockData, address + i * this.writeBlockSize);
    }

    this.log('Finished writing block sequence');
  }

  async eraseAll() {
    if (!this.serial.isOpen()) {
      throw new Error('Connection must be established before sending commands');
    }

    if (!this.commands.length) {
      throw new Error('Execute GET command first');
    }

    let eraseCmd;
    let eraseFlash;

    if (this.commands.indexOf(CMD_ERASE) !== -1) {
      eraseCmd = [CMD_ERASE, 0xFF ^ CMD_ERASE];
      eraseFlash = [0xFF, 0x00];
    } else if (this.commands.indexOf(CMD_EXTENDED_ERASE) !== -1) {
      eraseCmd = [CMD_EXTENDED_ERASE, 0xFF ^ CMD_EXTENDED_ERASE];
      eraseFlash = [0xFF, 0xFF, 0x00];
    } else {
      throw new Error('No erase command found');
    }

    await this.serial.write(u8a(eraseCmd));
    let response = await this.readResponse();
    if (response[0] !== ACK) {
      throw new Error('Unexpected response while requesting erase');
    }

    await this.serial.write(u8a(eraseFlash));
    response = await this.readResponse();
    if (response[0] !== ACK) {
      throw new Error('Unexpected response while erasing flash');
    }
  }

  async cmdGET() {
    if (!this.serial.isOpen()) {
      throw new Error('Connection must be established before sending commands');
    }

    await this.serial.write(u8a([CMD_GET, 0xFF ^ CMD_GET]));
    const resp = await this.readResponse();
    const response = Array.from(resp);

    if (response[0] !== ACK) {
      throw new Error('Unexpected response');
    }

    const info = {
      blVersion: (response[2] >> 4) + '.' + (response[2] & 0x0F),
      commands: []
    };

    for (let i = 0; i < response[1]; i += 1) {
      info.commands.push(response[3 + i]);
    }

    this.commands = info.commands;
    return info;
  }

  async cmdGID() {
    if (!this.commands.length) {
      throw new Error('Execute GET command first');
    }

    if (this.commands.indexOf(CMD_GID) === -1) {
      throw new Error('GET ID command is not supported by the current target');
    }

    if (!this.serial.isOpen()) {
      throw new Error('Connection must be established before sending commands');
    }

    await this.serial.write(u8a([CMD_GID, 0xFF ^ CMD_GID]));
    const response = await this.readResponse();

    if (response[0] !== ACK) {
      throw new Error('Unexpected response');
    }

    return '0x' + tools.b2hexstr(response[2]) + tools.b2hexstr(response[3]);
  }

  async cmdGO(address) {
    if (!Number.isInteger(address)) {
      throw new Error('Invalid address parameter');
    }

    if (!this.serial.isOpen()) {
      throw new Error('Connection must be established before sending commands');
    }

    const addressFrame = tools.num2a(address, 4);
    addressFrame.push(this.calcChecksum(addressFrame, false));

    await this.serial.write(u8a([CMD_GO, 0xFF ^ CMD_GO]));
    let response = await this.readResponse();
    if (response[0] !== ACK) {
      throw new Error('Unexpected response before GO address');
    }

    await this.serial.write(u8a(addressFrame));
    response = await this.readResponse();
    if (response[0] !== ACK) {
      throw new Error('Unexpected response to GO address');
    }
  }

  async cmdWRITE(data, address) {
    if (!(data instanceof Uint8Array)) {
      throw new Error('Missing data to write');
    }

    if (!Number.isInteger(address) || address < 0) {
      throw new Error('Invalid address parameter');
    }

    if (data.length > this.writeBlockSize) {
      throw new Error('Data is too big, use write()');
    }

    if (!this.commands.length) {
      throw new Error('Execute GET command first');
    }

    if (!this.serial.isOpen()) {
      throw new Error('Connection must be established before sending commands');
    }

    const checksum = this.calcChecksum(data, true);
    const frame = new Uint8Array(data.length + 2);
    frame[0] = data.length - 1;
    frame.set(data, 1);
    frame[frame.length - 1] = checksum;

    const addressFrame = tools.num2a(address, 4);
    addressFrame.push(this.calcChecksum(addressFrame, false));

    await this.serial.write(u8a([CMD_WRITE, 0xFF ^ CMD_WRITE]));
    let response = await this.readResponse();
    if (response[0] !== ACK) {
      throw new Error('Unexpected response before WRITE address');
    }

    await this.serial.write(u8a(addressFrame));
    response = await this.readResponse();
    if (response[0] !== ACK) {
      throw new Error('Unexpected response to WRITE address');
    }

    await this.serial.write(frame);
    response = await this.readResponse();
    if (response[0] !== ACK) {
      throw new Error('Unexpected response to WRITE data');
    }
  }

  async readResponse() {
    const result = await this.serial.read();

    if (this.replyMode) {
      await this.serial.write(u8a([result[0]]));
    }

    return result;
  }

  async activateBootloader() {
    this.log('Activating bootloader...');

    if (!this.serial.isOpen()) {
      throw new Error('Port must be opened before activating the bootloader');
    }

    const signal = {};
    signal[BOOT0_PIN] = PIN_HIGH;

    await this.serial.control(signal);
    await this.resetTarget();

    signal[BOOT0_PIN] = PIN_LOW;
    await this.serial.control(signal);

    await this.serial.write(u8a([SYNCHR]));
    const response = await this.serial.read();

    if (response[0] !== ACK) {
      throw new Error('Unexpected response while syncing bootloader');
    }

    if (this.replyMode) {
      await this.serial.write(u8a([ACK]));
    }

    this.log('Bootloader is ready for commands');
  }

  async resetTarget() {
    this.log('Resetting target...');

    if (!this.serial.isOpen()) {
      throw new Error('Port must be opened for device reset');
    }

    const signal = {};
    signal[RESET_PIN] = PIN_LOW;
    await this.serial.control(signal);

    signal[RESET_PIN] = PIN_HIGH;
    await this.serial.control(signal);

    this.log('Reset done. Wait for init.');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  calcChecksum(data, withLength) {
    let result = 0;
    for (let i = 0; i < data.length; i += 1) {
      result ^= data[i];
    }

    if (withLength) {
      result ^= (data.length - 1);
    }

    return result;
  }
}

module.exports = STM32Api;
