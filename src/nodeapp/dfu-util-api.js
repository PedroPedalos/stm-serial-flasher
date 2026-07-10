'use strict';

const { spawn } = require('node:child_process');

/**
 * Thin wrapper around the dfu-util CLI for STM32 USB DFU workflows.
 *
 * Design goals:
 * - Keep process handling in one place.
 * - Normalize/clean CLI output for caller-facing logs.
 * - Expose progress percentages through a callback for UI integration.
 * - Preserve useful stderr/stdout details on failures.
 */

function stripDfuUtilBanner(output) {
  const lines = String(output || '').split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const text = line.trim();
    if (!text) {
      return false;
    }

    if (text.startsWith('dfu-util ')) {
      return false;
    }

    if (text.startsWith('Copyright ')) {
      return false;
    }

    if (text.startsWith('This program is Free Software')) {
      return false;
    }

    if (text.startsWith('Please report bugs to ')) {
      return false;
    }

    return true;
  });

  return filtered.join('\n').trim();
}

/**
 * Execute an external command and collect stdout/stderr.
 *
 * @param {string} cmd Executable name or absolute path.
 * @param {string[]} args Command arguments.
 * @param {{onChunk?:(stream:'stdout'|'stderr',text:string)=>void}} [options]
 * Optional live output callback for stream processing.
 * @returns {Promise<{stdout:string,stderr:string}>}
 */
function runCommand(cmd, args, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (typeof opts.onChunk === 'function') {
        opts.onChunk('stdout', text);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (typeof opts.onChunk === 'function') {
        opts.onChunk('stderr', text);
      }
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const err = new Error('Command failed: ' + cmd + ' ' + args.join(' '));
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

/**
 * Parse percentage values from dfu-util streaming output.
 *
 * dfu-util typically emits progress values like "45%" in stdout/stderr.
 * This helper tracks the latest value and suppresses duplicates.
 *
 * @param {string} text Incoming chunk text.
 * @param {{buffer:string,lastPercent:number}} state Mutable parser state.
 * @returns {number|null} Next progress percentage (0..100) or null.
 */
function parseProgressPercent(text, state) {
  const parseState = state;
  parseState.buffer += text;
  if (parseState.buffer.length > 2048) {
    parseState.buffer = parseState.buffer.slice(-1024);
  }

  const matches = Array.from(parseState.buffer.matchAll(/(\d{1,3})%/g));
  if (!matches.length) {
    return null;
  }

  const value = parseInt(matches[matches.length - 1][1], 10);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    return null;
  }

  if (value === parseState.lastPercent) {
    return null;
  }

  parseState.lastPercent = value;
  return value;
}

/**
 * Convert command errors to user-facing errors that include cleaned
 * dfu-util output details.
 *
 * @param {{message:string,code?:number|string,stdout?:string,stderr?:string}} error
 * @returns {Error & {code?:number|string,stdout?:string,stderr?:string}}
 */
function enrichCommandError(error) {
  const details = stripDfuUtilBanner([
    error && error.stderr ? error.stderr : '',
    error && error.stdout ? error.stdout : ''
  ].join('\n'));

  const message = details ? error.message + '\n' + details : error.message;
  const wrapped = new Error(message);
  wrapped.code = error.code;
  wrapped.stdout = error.stdout;
  wrapped.stderr = error.stderr;
  return wrapped;
}

/**
 * API wrapper for dfu-util operations.
 */
class DfuUtilApi {
  /**
   * Ensure dfu-util is available in PATH.
   *
   * @returns {Promise<void>}
   * @throws {Error} If dfu-util cannot be executed.
   */
  async ensureAvailable() {
    try {
      await runCommand('dfu-util', ['--version']);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('dfu-util is not installed. Install it first, for example on macOS: brew install dfu-util');
      }

      const details = [error.stderr, error.stdout].filter(Boolean).join('\n').trim();
      throw new Error('dfu-util is not available: ' + (details || error.message));
    }
  }

  /**
   * List currently attached DFU-capable devices.
   *
   * Returns cleaned output containing only actionable lines
   * (banner/copyright lines removed).
   *
   * @returns {Promise<string>} Cleaned dfu-util list output.
   * @throws {Error} If listing fails.
   */
  async listDevices() {
    await this.ensureAvailable();
    try {
      const result = await runCommand('dfu-util', ['-l']);
      const merged = [result.stdout, result.stderr].filter(Boolean).join('\n');
      return stripDfuUtilBanner(merged);
    } catch (error) {
      throw enrichCommandError(error);
    }
  }

  /**
   * Download firmware to a DFU device.
   *
   * @param {object} params
   * @param {number|string} params.alt DFU alt setting number.
   * @param {string} params.dfuAddress DfuSe address string passed to `-s`.
   * @param {string} [params.deviceFilter] Optional VID:PID filter for `-d`.
   * @param {string} params.filePath Path to raw binary file for download.
   * @param {(percent:number)=>void} [params.onProgress]
   * Optional progress callback receiving 0..100 percentages.
   * @param {(text:string)=>void} [params.onLog]
   * Optional callback receiving raw stream chunks.
   * @returns {Promise<string>} Cleaned dfu-util output.
   * @throws {Error} If download fails. The error message includes cleaned
   * dfu-util diagnostics.
   */
  async download(params) {
    await this.ensureAvailable();

    const args = ['-a', String(params.alt)];

    if (params.deviceFilter) {
      args.push('-d', params.deviceFilter);
    }

    args.push('-s', params.dfuAddress);
    args.push('-D', params.filePath);

    const progressState = {
      buffer: '',
      lastPercent: -1
    };

    try {
      const result = await runCommand('dfu-util', args, {
        onChunk: (_stream, text) => {
          if (typeof params.onLog === 'function') {
            params.onLog(text);
          }

          if (typeof params.onProgress === 'function') {
            const percent = parseProgressPercent(text, progressState);
            if (percent !== null) {
              params.onProgress(percent);
            }
          }
        }
      });
      const merged = [result.stdout, result.stderr].filter(Boolean).join('\n');
      return stripDfuUtilBanner(merged);
    } catch (error) {
      throw enrichCommandError(error);
    }
  }
}

module.exports = DfuUtilApi;