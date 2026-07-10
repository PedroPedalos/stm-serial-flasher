'use strict';

const { SerialPort } = require('serialport');

/**
 * Minimal serial adapter used by the Node flasher flows.
 *
 * It provides:
 * - open/close lifecycle for one serial port path
 * - queued reads with timeout handling
 * - buffered writes with drain wait
 * - DTR/RTS line control compatible with WebSerial-style flags
 */
class SerialPortAdapter {
  /**
   * @param {string} pathName Absolute serial device path.
   */
  constructor(pathName) {
    if (!pathName) {
      throw new Error('Serial port path is required');
    }

    this.pathName = pathName;
    this.port = null;
    this.rxQueue = [];
    this.pendingReads = [];
    this.closed = true;
    this.defaultReadTimeoutMs = 4000;

    this.handleData = this.handleData.bind(this);
    this.handleClose = this.handleClose.bind(this);
  }

  /**
   * List serial ports visible to the host.
   * @returns {Promise<Array<object>>}
   */
  static async listPorts() {
    return SerialPort.list();
  }

  /**
   * @returns {boolean} True when the underlying serial port is open.
   */
  isOpen() {
    return Boolean(this.port && this.port.isOpen && !this.closed);
  }

  /**
   * Open the serial connection.
   * @param {{baudRate: number, parity?: 'none'|'even'|'odd'|'mark'|'space'}} parameter
   */
  async open(parameter) {
    if (this.isOpen()) {
      throw new Error('Port already open');
    }

    const { baudRate, parity } = parameter;

    this.port = new SerialPort({
      path: this.pathName,
      baudRate,
      parity: parity || 'even',
      autoOpen: false
    });

    await new Promise((resolve, reject) => {
      this.port.open((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    this.closed = false;
    this.port.on('data', this.handleData);
    this.port.on('close', this.handleClose);
  }

  /**
   * Close the serial connection and reject pending reads.
   */
  async close() {
    if (!this.port) {
      return;
    }

    this.closed = true;

    this.port.off('data', this.handleData);
    this.port.off('close', this.handleClose);

    if (this.port.isOpen) {
      await new Promise((resolve, reject) => {
        this.port.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }

    this.port = null;
    this.rxQueue = [];

    while (this.pendingReads.length > 0) {
      const pending = this.pendingReads.shift();
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Port closed'));
    }
  }

  /**
   * Read one queued chunk from the serial stream.
   * @param {number} [timeoutMs] Optional timeout in milliseconds.
   * @returns {Promise<Uint8Array>}
   */
  read(timeoutMs) {
    const effectiveTimeout = Number.isInteger(timeoutMs) ? timeoutMs : this.defaultReadTimeoutMs;

    if (!this.isOpen()) {
      return Promise.reject(new Error('Port is not open'));
    }

    if (this.rxQueue.length > 0) {
      return Promise.resolve(this.rxQueue.shift());
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.pendingReads.findIndex((entry) => entry.resolve === resolve);
        if (idx !== -1) {
          this.pendingReads.splice(idx, 1);
        }
        reject(new Error('Read timeout'));
      }, effectiveTimeout);

      this.pendingReads.push({ resolve, reject, timeoutId });
    });
  }

  /**
   * Write bytes to the port and wait for drain.
   * @param {Buffer|Uint8Array|Array<number>|string} data
   */
  async write(data) {
    if (!this.isOpen()) {
      throw new Error('Port is not open');
    }

    const buffer = Buffer.from(data);

    await new Promise((resolve, reject) => {
      this.port.write(buffer, (err) => {
        if (err) {
          reject(err);
          return;
        }

        this.port.drain((drainErr) => {
          if (drainErr) {
            reject(drainErr);
            return;
          }
          resolve();
        });
      });
    });
  }

  /**
   * Set control line states.
   *
   * WebSerial-compatible names are accepted and translated:
   * - dataTerminalReady -> dtr
   * - requestToSend -> rts
   *
   * @param {{dataTerminalReady?: boolean, requestToSend?: boolean}} lineParams
   */
  async control(lineParams) {
    if (!this.isOpen()) {
      throw new Error('Port is not open');
    }

    const setValues = {};

    if (typeof lineParams.dataTerminalReady === 'boolean') {
      setValues.dtr = lineParams.dataTerminalReady;
    }

    if (typeof lineParams.requestToSend === 'boolean') {
      setValues.rts = lineParams.requestToSend;
    }

    if (Object.keys(setValues).length === 0) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.port.set(setValues, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Internal data event handler.
   * @param {Buffer} chunk
   */
  handleData(chunk) {
    const data = Uint8Array.from(chunk);

    if (this.pendingReads.length > 0) {
      const pending = this.pendingReads.shift();
      clearTimeout(pending.timeoutId);
      pending.resolve(data);
      return;
    }

    this.rxQueue.push(data);
  }

  /**
   * Internal close event handler.
   */
  handleClose() {
    this.closed = true;
  }
}

module.exports = SerialPortAdapter;
