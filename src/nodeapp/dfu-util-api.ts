import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function prependPathList(existing: string | undefined, addition: string): string {
  if (!existing) {
    return addition;
  }

  return addition + path.delimiter + existing;
}

function dfuFolderForHost(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return 'darwin-arm64';
    }

    if (arch === 'x64') {
      return 'darwin-x86_64';
    }

    return null;
  }

  if (platform === 'linux' && arch === 'x64') {
    return 'linux-amd64';
  }

  if (platform === 'win32' && arch === 'x64') {
    return 'win64';
  }

  return null;
}

function bundledBinaryNameForHost(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'dfu-util.exe' : 'dfu-util';
}

function resolveBundledDfuUtilBinary(platform: NodeJS.Platform, arch: string): string | null {
  const dfuFolder = dfuFolderForHost(platform, arch);
  if (!dfuFolder) {
    return null;
  }

  const binaryName = bundledBinaryNameForHost(platform);
  const repoRoot = path.resolve(__dirname, '..', '..');
  const binaryPath = path.join(repoRoot, 'dfu-util-binaries', dfuFolder, binaryName);

  return isExecutableFile(binaryPath) ? binaryPath : null;
}

function buildCommandEnvironment(commandPath: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!commandPath || !path.isAbsolute(commandPath)) {
    return env;
  }

  const binDir = path.dirname(commandPath);
  if (platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = prependPathList(env.DYLD_LIBRARY_PATH, binDir);
  } else if (platform === 'linux') {
    env.LD_LIBRARY_PATH = prependPathList(env.LD_LIBRARY_PATH, binDir);
  } else if (platform === 'win32') {
    env.Path = prependPathList(env.Path || env.PATH, binDir);
    env.PATH = env.Path;
  }

  return env;
}

/**
 * Execute an external command and collect stdout/stderr.
 *
 * @param {string} cmd Executable name or absolute path.
 * @param {string[]} args Command arguments.
 * @param {{onChunk?:(stream:'stdout'|'stderr',text:string)=>void,env?:Record<string,string|undefined>}} [options]
 * Optional live output callback for stream processing.
 * @returns {Promise<{stdout:string,stderr:string}>}
 */
function runCommand(
  cmd: string,
  args: string[],
  options: {
    onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  const opts = options;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env || process.env
    });
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

      const err = new Error('Command failed: ' + cmd + ' ' + args.join(' ')) as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
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
function parseProgressPercent(text: string, state: { buffer: string; lastPercent: number }): number | null {
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
function enrichCommandError(error: {
  message: string;
  code?: number | string;
  stdout?: string;
  stderr?: string;
}): Error & { code?: number | string; stdout?: string; stderr?: string } {
  const details = stripDfuUtilBanner([
    error && error.stderr ? error.stderr : '',
    error && error.stdout ? error.stdout : ''
  ].join('\n'));

  const message = details ? error.message + '\n' + details : error.message;
  const wrapped = new Error(message) as Error & {
    code?: number | string;
    stdout?: string;
    stderr?: string;
  };
  wrapped.code = error.code;
  wrapped.stdout = error.stdout;
  wrapped.stderr = error.stderr;
  return wrapped;
}

/**
 * API wrapper for dfu-util operations.
 */
type DfuDownloadParams = {
  alt: number | string;
  dfuAddress: string;
  deviceFilter?: string | null;
  filePath: string;
  onProgress?: (percent: number) => void;
  onLog?: (text: string) => void;
};

export default class DfuUtilApi {
  commandPath: string;
  commandEnv: NodeJS.ProcessEnv;

  constructor(options: { commandPath?: string } = {}) {
    const opts = options || {};
    const resolvedBinary = resolveBundledDfuUtilBinary(process.platform, process.arch);

    this.commandPath = opts.commandPath || resolvedBinary || 'dfu-util';
    this.commandEnv = buildCommandEnvironment(this.commandPath, process.platform);
  }

  /**
   * Ensure dfu-util is available in PATH.
   *
   * @returns {Promise<void>}
   * @throws {Error} If dfu-util cannot be executed.
   */
  async ensureAvailable(): Promise<void> {
    try {
      await runCommand(this.commandPath, ['--version'], {
        env: this.commandEnv
      });
    } catch (error) {
      const err = /** @type {any} */ (error);
      if (err.code === 'ENOENT') {
        throw new Error('dfu-util is not available for this host. Install it first (for example on macOS: brew install dfu-util) or add matching binary in dfu-util-binaries for ' + process.platform + '/' + process.arch);
      }

      const details = [err.stderr, err.stdout].filter(Boolean).join('\n').trim();
      throw new Error('dfu-util is not available: ' + (details || err.message));
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
  async listDevices(): Promise<string> {
    await this.ensureAvailable();
    try {
      const result = await runCommand(this.commandPath, ['-l'], {
        env: this.commandEnv
      });
      const merged = [result.stdout, result.stderr].filter(Boolean).join('\n');
      return stripDfuUtilBanner(merged);
    } catch (error) {
      throw enrichCommandError(/** @type {any} */ (error));
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
  async download(params: DfuDownloadParams): Promise<string> {
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
      const result = await runCommand(this.commandPath, args, {
        env: this.commandEnv,
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
      throw enrichCommandError(/** @type {any} */ (error));
    }
  }
}