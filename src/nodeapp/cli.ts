#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const SerialPortAdapter = require('./serialport-adapter');
const STM32Api = require('./stm32-api');
const DfuUtilApi = require('./dfu-util-api');
const tools = require('./utils');

function printUsage() {
  console.log('STM32 Node Flasher (UART + USB DFU)');
  console.log('');
  console.log('Usage:');
  console.log('  node build/nodeapp/cli.js --file <firmware|bootloader> [options]');
  console.log('  node build/nodeapp/cli.js --list-ports');
  console.log('  node build/nodeapp/cli.js --list-dfu');
  console.log('');
  console.log('Options:');
  console.log('  -f, --file <path>           Firmware/bootloader file (.bin, .hex, .ihx, .s19)');
  console.log('  -t, --transport <mode>      Transport mode: uart | dfu | dfu-romboot (default: uart)');
  console.log('  -p, --port <path>           UART serial port path (example: /dev/tty.usbserial-0001)');
  console.log('  -b, --baudrate <number>     Baud rate (default: 9600)');
  console.log('  -s, --start-address <hex>   Flash start address for .bin files (default: 0x08000000)');
  console.log('      --list-dfu              List DFU devices with dfu-util and exit');
  console.log('      --dfu-alt <n>           DFU alt setting (default: 0)');
  console.log('      --dfu-address <addr>    DFU target address (default: start-address + :leave)');
  console.log('      --dfu-device <vid:pid>  Optional DFU device filter, ex: 0483:df11');
  console.log('      --romboot-port <path>   UART port used to send romboot command');
  console.log('      --romboot-baudrate <n>  Baudrate for romboot command (default: 115200)');
  console.log('      --romboot-command <cmd> Command to trigger ROM bootloader (default: sys romboot)');
  console.log('      --romboot-eol <eol>     EOL for romboot command: cr | lf | crlf | none (default: cr)');
  console.log('      --romboot-timeout <ms>  Wait timeout for DFU enumeration (default: 15000)');
  console.log('      --go                    Execute firmware after flashing (GO command)');
  console.log('      --reply-mode            Enable reply mode (parity none)');
  console.log('      --no-erase              Skip full flash erase');
  console.log('      --list-ports            Show available serial ports and exit');
  console.log('  -h, --help                  Show this help');
}

function parseAddress(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Invalid start address');
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Invalid start address: ' + value);
  }

  return parsed;
}

function parseArgs(argv) {
  const opts = {
    help: false,
    transport: 'uart',
    baudrate: '9600',
    startAddress: '0x08000000',
    replyMode: false,
    go: false,
    erase: true,
    listPorts: false,
    listDfu: false,
    dfuAlt: '0',
    dfuAddress: null,
    dfuDevice: null,
    rombootPort: null,
    rombootBaudrate: '115200',
    rombootCommand: 'sys romboot',
    rombootEol: 'cr',
    rombootTimeoutMs: '15000',
    file: null,
    port: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-t' || arg === '--transport') {
      opts.transport = (argv[++i] || '').toLowerCase();
    } else if (arg === '--list-ports') {
      opts.listPorts = true;
    } else if (arg === '--list-dfu') {
      opts.listDfu = true;
    } else if (arg === '--dfu-alt') {
      opts.dfuAlt = argv[++i];
    } else if (arg === '--dfu-address') {
      opts.dfuAddress = argv[++i];
    } else if (arg === '--dfu-device') {
      opts.dfuDevice = argv[++i];
    } else if (arg === '--romboot-port') {
      opts.rombootPort = argv[++i];
    } else if (arg === '--romboot-baudrate') {
      opts.rombootBaudrate = argv[++i];
    } else if (arg === '--romboot-command') {
      opts.rombootCommand = argv[++i];
    } else if (arg === '--romboot-eol') {
      opts.rombootEol = (argv[++i] || '').toLowerCase();
    } else if (arg === '--romboot-timeout') {
      opts.rombootTimeoutMs = argv[++i];
    } else if (arg === '--reply-mode') {
      opts.replyMode = true;
    } else if (arg === '--go') {
      opts.go = true;
    } else if (arg === '--no-erase') {
      opts.erase = false;
    } else if (arg === '-f' || arg === '--file') {
      opts.file = argv[++i];
    } else if (arg === '-p' || arg === '--port') {
      opts.port = argv[++i];
    } else if (arg === '-b' || arg === '--baudrate') {
      opts.baudrate = argv[++i];
    } else if (arg === '-s' || arg === '--start-address') {
      opts.startAddress = argv[++i];
    } else if (!arg.startsWith('-') && !opts.file) {
      opts.file = arg;
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }

  return opts;
}

async function listPorts() {
  const ports = await SerialPortAdapter.listPorts();

  if (ports.length === 0) {
    console.log('No serial ports found.');
    return;
  }

  console.log('Available serial ports:');
  for (const port of ports) {
    const details = [
      port.path,
      port.manufacturer || 'unknown manufacturer',
      port.serialNumber || 'unknown serial',
      port.vendorId || 'vid?',
      port.productId || 'pid?'
    ];
    console.log('  - ' + details.join(' | '));
  }
}

async function listDfuDevices() {
  const dfuApi = new DfuUtilApi();
  const output = await dfuApi.listDevices();
  const text = output.trim();

  if (!text || text.indexOf('Found DFU:') === -1) {
    console.log('No DFU devices found.');
    console.log('dfu-util is installed and reachable, but no USB DFU target is currently enumerated.');
    console.log('Make sure the MCU is in ROM/System Memory DFU mode, then retry.');
    return;
  }

  console.log(text);
}

function resolveRombootEol(eol) {
  if (eol === 'none') {
    return '';
  }

  if (eol === 'cr') {
    return '\r';
  }

  if (eol === 'crlf') {
    return '\r\n';
  }

  return '\n';
}

async function waitForSerialPrompt(serial, expectedPrompt, timeoutMs) {
  const started = Date.now();
  let received = '';

  while (Date.now() - started < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - started);
    const perReadTimeout = Math.min(400, Math.max(50, remainingMs));

    try {
      const chunk = await serial.read(perReadTimeout);
      if (!chunk || chunk.length === 0) {
        continue;
      }

      received += Buffer.from(chunk).toString('utf8');

      if (received.indexOf(expectedPrompt) !== -1) {
        return;
      }
    } catch (error) {
      if (error && error.message === 'Read timeout') {
        continue;
      }
      throw error;
    }
  }

  const compact = received.replace(/\s+/g, ' ').trim();
  const preview = compact ? compact.slice(-120) : '<no response>';
  throw new Error('Timed out waiting for serial prompt ' + expectedPrompt + '. Last response: ' + preview);
}

async function sendRombootCommand(args) {
  const commandPort = args.rombootPort || args.port;
  if (!commandPort) {
    throw new Error('Missing required argument for dfu-romboot: --romboot-port <serialPort> (or --port)');
  }

  const baudRate = parseInt(args.rombootBaudrate, 10);
  if (!Number.isInteger(baudRate) || baudRate <= 0) {
    throw new Error('Invalid --romboot-baudrate value: ' + args.rombootBaudrate);
  }

  const eol = resolveRombootEol(args.rombootEol);
  const command = (args.rombootCommand || '').trim();
  if (!command) {
    throw new Error('Invalid --romboot-command value');
  }

  console.log('Opening UART control port: ' + commandPort + ' @ ' + baudRate);
  const serial = new SerialPortAdapter(commandPort);

  try {
    await serial.open({
      baudRate,
      parity: 'none'
    });

    // Enter target command-line mode before issuing sys romboot.
    console.log('Sending initial CR to enter command-line mode...');
    await serial.write(Buffer.from('\r', 'utf8'));
    await waitForSerialPrompt(serial, 'CHGR>', 3000);
    console.log('Detected command-line prompt: CHGR>');

    const payload = Buffer.from(command + eol, 'utf8');
    console.log('Sending romboot command: ' + command);
    await serial.write(payload);
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    await serial.close().catch(() => {});
  }
}

async function waitForDfuDevice(args) {
  const timeoutMs = parseInt(args.rombootTimeoutMs, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Invalid --romboot-timeout value: ' + args.rombootTimeoutMs);
  }

  const started = Date.now();
  const pollMs = 350;
  const dfuApi = new DfuUtilApi();
  console.log('Waiting for DFU device enumeration (timeout ' + timeoutMs + ' ms)...');

  while (Date.now() - started < timeoutMs) {
    const output = await dfuApi.listDevices();
    if (output.indexOf('Found DFU:') !== -1) {
      console.log('DFU device detected.');
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error('Timed out waiting for DFU device after romboot command');
}

async function runDfuRombootFlash(args, absoluteFile, startAddress) {
  await sendRombootCommand(args);
  await waitForDfuDevice(args);
  await runDfuFlash(args, absoluteFile, startAddress);
}

function buildDfuAddress(args, startAddress) {
  if (args.dfuAddress) {
    return args.dfuAddress;
  }

  const base = '0x' + startAddress.toString(16);
  return args.go ? base + ':leave' : base;
}

function buildRawBinaryFromRecords(records) {
  const dataRecords = records.filter((rec) => rec.type === 'data');
  if (!dataRecords.length) {
    throw new Error('No data records found in input file');
  }

  let minAddress = Number.MAX_SAFE_INTEGER;
  let maxAddress = 0;

  for (const rec of dataRecords) {
    if (!Number.isInteger(rec.address) || rec.address < 0) {
      throw new Error('Invalid record address in input file');
    }

    const recEnd = rec.address + rec.data.length;
    minAddress = Math.min(minAddress, rec.address);
    maxAddress = Math.max(maxAddress, recEnd);
  }

  const imageSize = maxAddress - minAddress;
  const image = Buffer.alloc(imageSize, 0xFF);

  for (const rec of dataRecords) {
    const offset = rec.address - minAddress;
    image.set(rec.data, offset);
  }

  return {
    image,
    baseAddress: minAddress
  };
}

async function prepareDfuInputFile(args, absoluteFile, startAddress) {
  const ext = tools.extension(absoluteFile);

  if (ext === 'bin') {
    return {
      filePath: absoluteFile,
      addressBase: startAddress,
      cleanup: null
    };
  }

  if (ext !== 'hex' && ext !== 'ihx' && ext !== 's19') {
    throw new Error('Unsupported file extension for DFU mode: .' + ext);
  }

  const text = await fs.readFile(absoluteFile, 'utf8');
  const records = ext === 's19'
    ? tools.parseSRec(false, 256, text)
    : tools.parseHex(false, 256, text);

  const raw = buildRawBinaryFromRecords(records);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stm-dfu-'));
  const tempFile = path.join(tempDir, path.basename(absoluteFile, path.extname(absoluteFile)) + '.bin');
  await fs.writeFile(tempFile, raw.image);

  return {
    filePath: tempFile,
    addressBase: raw.baseAddress,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function runDfuFlash(args, absoluteFile, startAddress) {
  const dfuApi = new DfuUtilApi();
  const alt = parseInt(args.dfuAlt, 10);

  if (!Number.isInteger(alt) || alt < 0) {
    throw new Error('Invalid --dfu-alt value: ' + args.dfuAlt);
  }

  const prepared = await prepareDfuInputFile(args, absoluteFile, startAddress);

  if (!args.erase) {
    console.log('Note: --no-erase is ignored in DFU mode (erase behavior is managed by target DFU implementation).');
  }

  console.log('DFU mode selected. Ensure MCU is already in ROM DFU bootloader mode before continuing.');
  console.log('Tip: run with --list-dfu first to verify enumeration.');

  const dfuAddress = buildDfuAddress(args, prepared.addressBase);

  console.log('Flashing file via DFU: ' + absoluteFile);
  if (prepared.filePath !== absoluteFile) {
    console.log('Converted firmware to raw binary for dfu-util: ' + prepared.filePath);
  }
  console.log('DFU alt setting: ' + alt);
  console.log('DFU address: ' + dfuAddress);
  if (args.dfuDevice) {
    console.log('DFU device filter: ' + args.dfuDevice);
  }

  let lastPercent = -1;
  let output = '';
  try {
    output = await dfuApi.download({
      alt,
      dfuAddress,
      deviceFilter: args.dfuDevice,
      filePath: prepared.filePath,
      onProgress: (percent) => {
        if (percent === lastPercent) {
          return;
        }

        lastPercent = percent;
        process.stdout.write('\rDFU progress: ' + String(percent).padStart(3, ' ') + '%');
        if (percent >= 100) {
          process.stdout.write('\n');
        }
      }
    });
  } finally {
    if (prepared.cleanup) {
      await prepared.cleanup();
    }
  }

  if (lastPercent >= 0 && lastPercent < 100) {
    process.stdout.write('\n');
  }

  if (output.trim()) {
    console.log(output.trim());
  }

  console.log('DFU flash process completed successfully.');
}

async function loadRecords(filePath, writeBlockSize, startAddress) {
  const ext = tools.extension(filePath);

  if (!ext) {
    throw new Error('Unable to determine file extension for: ' + filePath);
  }

  if (ext === 'bin') {
    const bin = await fs.readFile(filePath);
    return [
      {
        type: 'data',
        address: startAddress,
        data: new Uint8Array(bin)
      }
    ];
  }

  const text = await fs.readFile(filePath, 'utf8');

  if (ext === 's19') {
    return tools.parseSRec(true, writeBlockSize, text);
  }

  if (ext === 'hex' || ext === 'ihx') {
    return tools.parseHex(true, writeBlockSize, text);
  }

  throw new Error('Unsupported file extension: .' + ext);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (args.listPorts) {
    await listPorts();
    return;
  }

  if (args.listDfu) {
    await listDfuDevices();
    return;
  }

  if (args.transport !== 'uart' && args.transport !== 'dfu' && args.transport !== 'dfu-romboot') {
    throw new Error('Invalid --transport value: ' + args.transport + ' (expected uart, dfu, or dfu-romboot)');
  }

  if (!args.file) {
    throw new Error('Missing required argument: --file <path>');
  }

  const absoluteFile = path.resolve(args.file);
  const startAddress = parseAddress(args.startAddress);

  if (args.transport === 'dfu') {
    await runDfuFlash(args, absoluteFile, startAddress);
    return;
  }

  if (args.transport === 'dfu-romboot') {
    await runDfuRombootFlash(args, absoluteFile, startAddress);
    return;
  }

  if (!args.port) {
    throw new Error('Missing required argument: --port <serialPort>');
  }

  const serial = new SerialPortAdapter(args.port);
  const stmApi = new STM32Api(serial, (msg) => console.log('[STM32] ' + msg));

  let connected = false;

  try {
    console.log('Flashing file: ' + absoluteFile);
    console.log('Connecting to port: ' + args.port);

    await stmApi.connect({
      replyMode: args.replyMode,
      baudrate: args.baudrate
    });
    connected = true;

    const info = await stmApi.cmdGET();
    const pid = await stmApi.cmdGID();

    console.log('Bootloader: ' + info.blVersion);
    console.log('Product ID: ' + pid);
    console.log('Supported commands: ' + info.commands.map((cmd) => '0x' + cmd.toString(16).padStart(2, '0')).join(', '));

    if (args.erase) {
      console.log('Erasing flash...');
      await stmApi.eraseAll();
      console.log('Erase complete.');
    } else {
      console.log('Skipping erase (--no-erase).');
    }

    const records = await loadRecords(absoluteFile, stmApi.writeBlockSize, startAddress);
    const totalDataRecords = tools.countData(records);
    let writtenRecords = 0;
    let goAddress = null;

    for (const rec of records) {
      if (rec.type === 'start') {
        goAddress = rec.address;
        console.log('Start address detected from file: 0x' + rec.address.toString(16));
        continue;
      }

      if (rec.type !== 'data') {
        continue;
      }

      writtenRecords += 1;
      console.log('Writing record ' + writtenRecords + '/' + totalDataRecords + ' at 0x' + rec.address.toString(16) + ' (' + rec.data.length + ' bytes)');
      await stmApi.write(rec.data, rec.address);
    }

    if (args.go) {
      const jumpAddress = Number.isInteger(goAddress) ? goAddress : startAddress;
      console.log('Sending GO command to 0x' + jumpAddress.toString(16));
      await stmApi.cmdGO(jumpAddress);
    }

    console.log('Flash process completed successfully.');
  } finally {
    if (connected) {
      try {
        await stmApi.disconnect();
      } catch (disconnectError) {
        console.error('Disconnect failed: ' + disconnectError.message);
      }
    }
  }
}

run().catch((error) => {
  console.error('Flash failed: ' + error.message);
  process.exitCode = 1;
});
