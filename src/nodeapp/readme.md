# STM32 Node Flasher (UART + USB DFU)

This folder contains a Node.js CLI flasher that replaces the web GUI flow for STM32 flashing.

It supports two transport modes:

- UART bootloader mode using serialport
- Direct USB DFU mode using dfu-util
- UART romboot trigger followed by DFU using dfu-romboot mode

For boards that enter ROM bootloader via a command over UART, use `--transport dfu-romboot`.
This sends a command (default `sys romboot`) on a serial port, waits for USB DFU enumeration,
then performs the DFU flash flow.

## Location

- CLI entrypoint: src/nodeapp/cli.js
- Serial adapter: src/nodeapp/serialport-adapter.js
- STM32 protocol API: src/nodeapp/stm32-api.js
- File parsing utilities: src/nodeapp/utils.js

## Requirements

- Node.js 18+ recommended
- UART mode: USB to UART adapter wired to target board
- DFU mode: direct USB connection to MCU in ROM bootloader mode
- For DFU mode: dfu-util installed and available in PATH

On macOS, install dfu-util with:

  brew install dfu-util

## Wiring (UART mode)

Host to target wiring for serial and control lines:

- GND to GND
- TX to RX
- RX to TX
- DTR to NRST
- RTS to BOOT0

Notes:

- DTR and RTS are used by the CLI to toggle reset and bootloader entry.
- BOOT0 line control is STM32 flow.

## Direct USB DFU Mode

For MCUs like STM32G0 connected directly over USB:

- You do not use --port.
- You must place MCU into ROM/System Memory bootloader (DFU) mode before flashing.
- Use --transport dfu and dfu-util handles USB transport.

## Install

From repository root:

    npm install

## NPM Scripts

From repository root:

- List ports:

      npm run nodeapp:list-ports

- List DFU devices:

  npm run nodeapp:list-dfu

- Run flasher:

      npm run nodeapp:run -- --file ./firmware.hex --port /dev/tty.usbserial-0001

- Run flasher in DFU mode:

  npm run nodeapp:run-dfu -- --file ./firmware.bin --start-address 0x08000000 --go

- Run fixed romboot to DFU flow (preconfigured port + firmware path):

  npm run nodeapp:run-romboot-dfu-fixed

- Run with debugger attach enabled:

      npm run nodeapp:debug -- --file ./firmware.hex --port /dev/tty.usbserial-0001

## CLI Help

Command:

    node src/nodeapp/cli.js --help

Output:

    STM32 Node Flasher (UART + USB DFU)

    Usage:
      node src/nodeapp/cli.js --file <firmware|bootloader> [options]
      node src/nodeapp/cli.js --list-ports
      node src/nodeapp/cli.js --list-dfu

    Options:
      -f, --file <path>           Firmware/bootloader file (.bin, .hex, .ihx, .s19)
      -t, --transport <mode>      Transport mode: uart | dfu | dfu-romboot (default: uart)
      -p, --port <path>           UART serial port path (example: /dev/tty.usbserial-0001)
      -b, --baudrate <number>     Baud rate (default: 9600)
      -s, --start-address <hex>   Flash start address for .bin files (default: 0x08000000)
          --list-dfu              List DFU devices with dfu-util and exit
          --dfu-alt <n>           DFU alt setting (default: 0)
          --dfu-address <addr>    DFU target address (default: start-address + :leave)
          --dfu-device <vid:pid>  Optional DFU device filter, ex: 0483:df11
          --romboot-port <path>   UART port used to send romboot command
          --romboot-baudrate <n>  Baudrate for romboot command (default: 115200)
          --romboot-command <cmd> Command to trigger ROM bootloader (default: sys romboot)
          --romboot-eol <eol>     EOL for romboot command: cr | lf | crlf | none (default: cr)
          --romboot-timeout <ms>  Wait timeout for DFU enumeration (default: 15000)
          --go                    Execute firmware after flashing (GO command)
          --reply-mode            Enable reply mode (parity none)
          --no-erase              Skip full flash erase
          --list-ports            Show available serial ports and exit
      -h, --help                  Show this help

## CLI Arguments

Required for flashing:

- --file path to firmware or bootloader image

UART transport only:

- --port serial port path

Optional:

- --transport uart or dfu, default uart
- --baudrate serial baud rate, default 9600
- --start-address start address for binary files, default 0x08000000
- --go send GO command after flash completes
- --reply-mode enables bootloader reply mode and parity none
- --no-erase skips full erase before writing
- --list-ports lists serial ports and exits
- --list-dfu lists DFU devices and exits
- --dfu-alt DFU alt setting for dfu-util, default 0
- --dfu-address explicit DFU target address string passed to dfu-util -s
- --dfu-device optional DFU VID:PID filter for dfu-util -d
- --romboot-port UART control port for dfu-romboot mode
- --romboot-baudrate UART baudrate for romboot command, default 115200
- --romboot-command UART command used to trigger ROM boot mode, default sys romboot
- --romboot-eol command line ending for romboot command: cr, lf, crlf, none (default cr)
- --romboot-timeout max wait for DFU enumeration in ms, default 15000
- --help shows usage and exits

## Supported Input Formats

- .bin
- .hex
- .ihx
- .s19

Behavior:

- Binary files are flashed from --start-address.
- HEX and S19 records are parsed and flashed by record address.
- Start records are recognized and used by --go when present.

## Typical Workflows

1. Find serial port:

       npm run nodeapp:list-ports

2. Flash firmware with erase:

       npm run nodeapp:run -- --file ./firmware.hex --port /dev/tty.usbserial-0001

3. Flash and start execution:

       npm run nodeapp:run -- --file ./firmware.hex --port /dev/tty.usbserial-0001 --go

4. Flash bootloader binary at specific address:

       npm run nodeapp:run -- --file ./bootloader.bin --port /dev/tty.usbserial-0001 --start-address 0x08000000

5. Keep flash contents and write without erase:

       npm run nodeapp:run -- --file ./patch.hex --port /dev/tty.usbserial-0001 --no-erase

6. Direct USB DFU: list devices:

  npm run nodeapp:list-dfu

7. Direct USB DFU: flash STM32G0 binary and leave DFU (run application):

  npm run nodeapp:run-dfu -- --file ./firmware.bin --start-address 0x08000000 --go

8. Direct USB DFU: flash with explicit device filter:

  npm run nodeapp:run-dfu -- --file ./firmware.bin --dfu-device 0483:df11 --dfu-address 0x08000000:leave

9. Trigger romboot over UART, then flash over DFU:

  npm run nodeapp:run-romboot-dfu -- --romboot-port /dev/tty.usbmodem205C337C46421 --romboot-command "sys romboot" --go

## Debugging

Start with inspector break on launch:

    npm run nodeapp:debug -- --file ./firmware.hex --port /dev/tty.usbserial-0001

Then attach from VS Code to Node.js Inspector.

## Runtime Flow

UART transport sequence:

1. Open serial port with selected baud/parity.
2. Toggle RTS and DTR for STM32 bootloader entry.
3. Send sync byte and verify ACK.
4. Read bootloader info with GET and product ID with GID.
5. Optionally full erase.
6. Parse firmware records and write flash blocks.
7. Optionally send GO command.
8. Reset target and close serial connection.

DFU transport sequence:

1. Verify dfu-util is installed.
2. User places MCU in ROM/System Memory DFU mode.
3. Download file with dfu-util using selected alt/address/filter.
4. If address includes :leave (default when --go), device exits DFU and runs.

DFU-ROMBOOT transport sequence:

1. Open serial port for control command.
2. Send an initial carriage return and wait for command prompt `CHGR>`.
3. Send configured romboot command.
4. Close serial port and wait for DFU enumeration.
5. Run standard DFU transport sequence.

## DFU API Integration

You can use the DFU wrapper directly from an Electron main process and forward
progress events to the renderer.

Example main-process usage:

```javascript
const { ipcMain } = require('electron');
const DfuUtilApi = require('./src/nodeapp/dfu-util-api');

ipcMain.handle('flash:dfu', async (event, payload) => {
  const dfu = new DfuUtilApi();
  await dfu.ensureAvailable();

  const output = await dfu.download({
    alt: payload.alt ?? 0,
    dfuAddress: payload.dfuAddress ?? '0x08000000:leave',
    deviceFilter: payload.deviceFilter,
    filePath: payload.filePath,
    onProgress: (percent) => {
      event.sender.send('flash:progress', { percent });
    },
    onLog: (text) => {
      event.sender.send('flash:log', { text });
    }
  });

  return { ok: true, output };
});
```

Renderer-side listener example:

```javascript
const { ipcRenderer } = require('electron');

ipcRenderer.on('flash:progress', (_event, message) => {
  updateProgressBar(message.percent);
});

ipcRenderer.on('flash:log', (_event, message) => {
  appendLog(message.text);
});
```

Notes:

- `onProgress(percent)` only emits parsed percentages (0..100).
- `onLog(text)` emits raw output chunks if you want detailed logs.
- Errors include cleaned dfu-util diagnostics in `error.message`.

## Current Scope

- STM32 UART bootloader flow is implemented.
- STM32 direct USB DFU flow is implemented via dfu-util wrapper.
- STM8 routines and STM8-specific flow are not included in nodeapp currently.

## Troubleshooting

- Port open failure:
  - Verify correct port path.
  - Close other tools using the same port.
- No ACK after sync:
  - Check RX/TX crossover.
  - Check BOOT0 and NRST wiring.
  - Confirm target bootloader UART instance.
- Read timeout:
  - Try lower baudrate.
  - Verify board power and ground.
- Permission issues on serial device:
  - Ensure your user has serial port access.
- DFU mode not found:
  - Confirm MCU is in ROM/System Memory bootloader mode.
  - Run npm run nodeapp:list-dfu and verify the device is listed.
  - Install dfu-util if missing.
