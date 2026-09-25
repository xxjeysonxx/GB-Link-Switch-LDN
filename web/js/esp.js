// A session with the bridge firmware over WebSerial: binary mode, commands with their
// replies, the adapter frames (kinds 6 and 7), and re-attaching when the firmware
// restarts itself, which it does whenever a session with the Switch ends.

import { KIND, FrameDecoder, buildFrame } from './wire.js';
import { parseKeyStatus } from './keys.js';

// Native USB Serial/JTAG (S3, C3, C6), then the USB bridges found on ESP32 dev boards.
export const ESP_FILTERS = [
    { usbVendorId: 0x303a },
    { usbVendorId: 0x10c4 },
    { usbVendorId: 0x1a86 },
    { usbVendorId: 0x0403 },
];

const BOOT_BANNER = new TextEncoder().encode('LDN_READY');
const HANDSHAKE_ATTEMPTS = 4;
// Text that only a chip on its way up prints: the ROM's banner, the second-stage
// bootloader's log, and our firmware's own banner. The ROM always prints at 115200, so
// at our console's rate the bootloader's lines are the first that can be read.
const BOOT_SIGNS = /LDN_READY|ldn_bridge|rst:0x|ESP-ROM:|I \(\d+\) boot:/;

// A chip's own USB port ignores the rate. Behind a USB-UART bridge the firmware's console
// runs at 921600, which is what carrying the adapter's traffic needs, and a browser cannot
// change the rate of a port it has open. Firmware from before that, and the chip's ROM,
// talk at 115200, so that is tried second: it is also where a bootloader's banner becomes
// readable.
const NATIVE_VENDOR_ID = 0x303a;
export const FAST_BAUD = 921600;
const SLOW_BAUD = 115200;

function isNativeUsb(port) {
    return safeInfo(port).usbVendorId === NATIVE_VENDOR_ID;
}

function ratesFor(port) {
    return isNativeUsb(port) ? [SLOW_BAUD] : [FAST_BAUD, SLOW_BAUD];
}

// On Linux a serial port keeps its line settings between programs, and one that was
// last used by a tool that reads with VMIN=0 (anything built on pyserial, esptool
// included) makes the browser's first read come back empty, which it reports as a lost
// device. Replugging the board resets the settings.
export const PORT_LOST_ADVICE = 'El navegador perdió el puerto en cuanto lo abrió. En Linux pasa cuando otro programa serie ha usado el puerto: desenchufa la placa y vuelve a enchufarla, y conecta de nuevo.';

// Whether version string `candidate` is newer than `than` (dotted numbers).
export function newer(candidate, than) {
    const a = String(candidate).split('.').map(Number);
    const b = String(than).split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return false;
}

export class EspDevice extends EventTarget {
    constructor() {
        super();
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.decoder = new FrameDecoder();
        this.session = 0;
        this.request = 0;
        this.pending = null;          // { request, lines, resolve, timer }
        this.queue = Promise.resolve();
        this.info = null;
        this.hello = null;
        this.attached = false;
        this.attaching = false;
        this.onAdapterFrame = null;   // (Uint8Array) => void, kind 6
        this.bannerTail = new Uint8Array(0);
        this.heardAt = 0;             // a Switch's room advertisement was received (LDN_ADV)
        this.readAt = 0;              // and one was decoded (LDN_ROOM)
        this.bannerSeen = false;
        this.readEnded = false;
        this.bootText = '';           // what the chip printed while no session was up
        this.bootSignAt = 0;          // when it last showed signs of starting up
        this.baudRate = 0;
    }

    static available() {
        return typeof navigator !== 'undefined' && Boolean(navigator.serial);
    }

    static requestPort() {
        return navigator.serial.requestPort({ filters: ESP_FILTERS });
    }

    async open(port) {
        const rates = ratesFor(port);
        let failure = null;
        for (let i = 0; i < rates.length; i++) {
            try {
                await this.openPort(port, rates[i]);
            } catch (error) {
                throw Object.assign(new Error(error?.message ?? String(error)), { code: 'port-busy' });
            }
            try {
                await this.attach(i === rates.length - 1);
                return;
            } catch (error) {
                failure = error;
                await this.close();
                if (error.code === 'port-lost' || error.code === 'crash-loop') break;
            }
        }
        throw failure;
    }

    async openPort(port, baudRate) {
        await port.open({ baudRate, bufferSize: 65536 });
        this.baudRate = baudRate;
        this.port = port;
        this.writer = port.writable.getWriter();
        this.reader = port.readable.getReader();
        this.readEnded = false;
        this.bootText = '';
        this.readLoop();
        // On a dev board DTR and RTS work the chip's boot-select and reset pins, and the
        // operating system asserts both while opening. Released, they leave the chip
        // alone when the port closes as well. Reset is RTS without DTR, and a USB-UART
        // chip moves the two pins one after the other, so RTS has to go first there;
        // a chip with USB of its own takes both in one request.
        try {
            if (isNativeUsb(port)) await port.setSignals({ dataTerminalReady: false, requestToSend: false });
            else {
                await port.setSignals({ requestToSend: false });
                await port.setSignals({ dataTerminalReady: false });
            }
        } catch {}
    }

    // Binary mode, a session id, and who we are talking to. Opening the port can reset
    // the chip, so the handshake is retried until the firmware has had time to boot.
    async attach(lastChance = true) {
        this.attached = false;
        this.attaching = true;
        try {
            let hello = null;
            for (let attempt = 0; attempt < HANDSHAKE_ATTEMPTS && !hello; attempt++) {
                this.decoder = new FrameDecoder();
                const justBooted = this.bannerSeen;
                this.bannerSeen = false;
                await sleep(attempt === 0 || justBooted ? 150 : 600);
                // Gone before it said anything is the operating system's doing. Gone after
                // printing is the chip's: one with nothing to run restarts every few
                // seconds, and its own USB port drops off the bus each time.
                if (this.readEnded) throw this.bootText ? this.silenceExplained() : Object.assign(new Error(PORT_LOST_ADVICE), { code: 'port-lost' });
                await this.writeRaw(new TextEncoder().encode('\nLDN_BINARY\n\0'));
                await sleep(200);
                const lines = await this.command('LDN_HELLO', 700, true);
                hello = lines.find((line) => line.startsWith('LDN_HELLO')) ?? null;
                if (this.bannerSeen) hello = null;   // it rebooted under us: go again
                if (!hello && !this.worthAnotherTry(attempt, lastChance)) break;
            }
            if (!hello) throw this.silenceExplained();
            this.hello = hello;
            this.session = ((Date.now() & 0x7fffffff) | 1) >>> 0;
            await this.command(`LDN_BEGIN ${this.session.toString(16).padStart(8, '0')}`, 2000, true);
            const info = await this.command('LDN_INFO', 2000, true);
            this.info = parseInfo(info.find((line) => line.startsWith('LDN_INFO')) ?? '');
            this.attached = true;
        } finally {
            this.attaching = false;
        }
        this.dispatchEvent(new CustomEvent('attached', { detail: this.info }));
    }

    // Running firmware answers within milliseconds, so waiting only makes sense while
    // the chip is visibly starting up (opening the port can reset it). Anything that
    // proves a different program, a bootloader or a crash ends the wait at once; plain
    // silence gets one more try, and only at the last rate there is to try.
    worthAnotherTry(attempt, lastChance) {
        const text = this.bootText;
        if (/waiting for download|invalid header|No bootable app|ESP_ERROR_CHECK failed|abort\(\) was called|Guru Meditation/i.test(text)) return false;
        const project = text.match(/Project name:\s+(\S+)/)?.[1];
        if (project && !project.startsWith('ldn_bridge')) return false;
        // Starting up, as long as that was recent: our firmware answers about a second
        // after the reset, and whatever else prints a boot log never will.
        if (BOOT_SIGNS.test(text)) return Date.now() - this.bootSignAt < 3000;
        return lastChance && attempt === 0 && text.length === 0;
    }

    // Nothing answered the handshake. What the chip printed meanwhile often says why: a
    // ROM bootloader waiting for a download, or firmware that aborts as it starts and
    // restarts, which from outside is just as silent.
    silenceExplained() {
        const text = this.bootText;
        if (/waiting for download/i.test(text)) {
            return Object.assign(new Error('El chip está en su bootloader.'), { code: 'download-mode' });
        }
        // Nothing to start: the ROM finds no bootloader or the bootloader no application,
        // and the chip restarts for ever. Looks like a crash loop, but it is an empty board.
        if (/invalid header|No bootable app/i.test(text)) {
            return Object.assign(new Error('Ningún firmware de puente respondió en este puerto.'), { code: 'no-firmware' });
        }
        const crash = text.match(/ESP_ERROR_CHECK failed[^\r\n]*|abort\(\) was called[^\r\n]*|Guru Meditation Error[^\r\n]*|Brownout detector was triggered/);
        const restarts = (text.match(/rst:0x/g) ?? []).length;
        if (crash || restarts >= 2) {
            const detail = ['file:', 'func:', 'expression:']
                .map((label) => text.match(new RegExp(`${label}[^\\r\\n]*`))?.[0]).filter(Boolean).join(' ');
            return Object.assign(new Error('El firmware de esta placa falla al arrancar y se reinicia.'),
                { code: 'crash-loop', detail: [crash?.[0], detail].filter(Boolean).join(' ') });
        }
        const project = text.match(/Project name:\s+(\S+)/)?.[1];
        if (project && !project.startsWith('ldn_bridge')) {
            return Object.assign(new Error(`Esta placa tiene otro firmware (${project}).`), { code: 'no-firmware' });
        }
        return Object.assign(new Error('Ningún firmware de puente respondió en este puerto.'), { code: 'no-firmware' });
    }

    async readLoop() {
        const reader = this.reader;
        try {
            while (reader === this.reader) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;
                if (!this.attached) {
                    const text = new TextDecoder().decode(value);
                    this.bootText = (this.bootText + text).slice(-16384);
                    // With some of what came before, for a sign split across two reads.
                    if (BOOT_SIGNS.test(this.bootText.slice(-(text.length + 32)))) this.bootSignAt = Date.now();
                }
                this.watchForReboot(value);
                // A frame this page mishandles is not the port failing: keep reading, or
                // the board would look unplugged.
                for (const frame of this.decoder.push(value)) {
                    try { this.handleFrame(frame); }
                    catch (error) { this.dispatchEvent(new CustomEvent('log', { detail: `page: ${error?.message ?? error}` })); }
                }
            }
        } catch {
            // The port went away, or close() cancelled the read.
        }
        this.readEnded = true;
        if (reader === this.reader) this.dispatchEvent(new Event('disconnected'));
    }

    // A software restart leaves the USB port open, so the boot banner is the only sign
    // that the chip is back in text mode and needs the handshake again.
    watchForReboot(chunk) {
        const joined = new Uint8Array(this.bannerTail.length + chunk.length);
        joined.set(this.bannerTail, 0);
        joined.set(chunk, this.bannerTail.length);
        this.bannerTail = joined.slice(Math.max(0, joined.length - (BOOT_BANNER.length - 1)));
        if (indexOf(joined, BOOT_BANNER) < 0) return;
        this.bannerSeen = true;
        if (this.attaching) this.finishPending();   // sent before it was up: no answer is coming
        if (!this.attached || this.attaching) return;
        this.attached = false;
        this.dispatchEvent(new Event('restarted'));
        sleep(1200)
            .then(() => this.attach())
            .then(() => this.dispatchEvent(new Event('reattached')))
            .catch((error) => this.dispatchEvent(new CustomEvent('failed', { detail: error })));
    }

    handleFrame(frame) {
        if (frame.kind === KIND.ADAPTER_OUT) {
            if (this.onAdapterFrame) this.onAdapterFrame(frame.payload);
            return;
        }
        if (frame.kind !== KIND.RESPONSE && frame.kind !== KIND.EVENT) return;
        const text = new TextDecoder().decode(frame.payload).trim();
        const pending = this.pending;
        if (pending && frame.request === pending.request) {
            if (text === 'LDN_DONE') {
                clearTimeout(pending.timer);
                this.pending = null;
                pending.resolve(pending.lines);
            } else {
                pending.lines.push(text);
            }
            return;
        }
        if (text.startsWith('LDN_ADV ')) this.heardAt = Date.now();
        else if (text.startsWith('LDN_ROOM ')) this.readAt = Date.now();
        if (text && text !== 'LDN_DONE') this.dispatchEvent(new CustomEvent('log', { detail: text }));
    }

    // Advertisements keep arriving (four a second while a room is up) but none decodes:
    // the board hears a room its keys cannot read.
    get hearsUnreadableRoom() {
        const now = Date.now();
        return now - this.heardAt < 5000 && now - this.readAt > 10000;
    }

    // The Switch's signal over the last few seconds, in dBm, or null when its room was
    // not heard. Firmware before 2.0.2 counted every wireless frame in this reading.
    async signal() {
        if (!this.info || newer('2.0.2', this.info.version)) return null;
        const lines = await this.command('LDN_RF', 1500);
        const match = lines.find((l) => l.startsWith('LDN_RF '))?.match(/frames=(\d+) avg=(-?\d+)/);
        return match && Number(match[1]) > 0 ? Number(match[2]) : null;
    }

    // One request at a time, as the protocol requires. Resolves with the reply lines,
    // which are whatever arrived if the device never finished the reply. Until the
    // handshake is done only the handshake itself may talk.
    command(text, timeoutMs = 2000, handshake = false) {
        const run = () => new Promise((resolve, reject) => {
            if (!this.writer) { reject(new Error('Sin conexión')); return; }
            if (!this.attached && !handshake) { reject(new Error('La placa ESP32 se está reiniciando')); return; }
            const request = (this.request = (this.request % 0x7fffffff) + 1);
            const entry = { request, lines: [], resolve, timer: null };
            entry.timer = setTimeout(() => {
                if (this.pending === entry) this.pending = null;
                resolve(entry.lines);
            }, timeoutMs);
            this.pending = entry;
            this.writeRaw(buildFrame(KIND.COMMAND, request, this.session, new TextEncoder().encode(text)))
                .catch((error) => { clearTimeout(entry.timer); if (this.pending === entry) this.pending = null; reject(error); });
        });
        const result = this.queue.then(run, run);
        this.queue = result.catch(() => {});
        return result;
    }

    finishPending() {
        const pending = this.pending;
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending = null;
        pending.resolve(pending.lines);
    }

    // Bytes from the adapter, headed for the bridge (kind 7).
    sendAdapter(bytes) {
        if (!this.attached) return;
        this.writeRaw(buildFrame(KIND.ADAPTER_IN, 0, this.session, bytes)).catch(() => {});
    }

    writeRaw(bytes) {
        if (!this.writer) return Promise.reject(new Error('Sin conexión'));
        return this.writer.write(bytes);
    }

    async keyStatus() {
        const lines = await this.command('LDN_KEYS');
        const line = lines.find((l) => l.startsWith('LDN_KEYS '));
        return line ? parseKeyStatus(line) : null;
    }

    // keys: { name: 32 hex digits }. The firmware stores them in flash and never sends
    // them back; only which names are present can be read.
    async storeKeys(keys) {
        const rejected = [];
        for (const [name, value] of Object.entries(keys)) {
            const lines = await this.command(`LDN_KEY ${name} ${value}`, 3000);
            if (!lines.some((l) => l === `LDN_KEY_OK ${name}`)) rejected.push(name);
        }
        return rejected;
    }

    async eraseKeys() {
        const lines = await this.command('LDN_KEYS_ERASE', 3000);
        return lines.includes('LDN_KEYS_ERASED');
    }

    // A board with no keys stops looking for rooms the first time it finds one.
    async startBridge() {
        await this.command('LDN_BRIDGE_START');
    }

    async bridgeStatus() {
        const lines = await this.command('LDN_BRIDGE_STATUS', 1500);
        const line = lines.find((l) => l.startsWith('LDN_BRIDGE_STATUS '));
        if (!line) return null;
        const fields = {};
        for (const part of line.split(/\s+/).slice(1)) {
            const at = part.indexOf('=');
            if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1);
        }
        return fields;
    }

    async adapterPort() {
        const lines = await this.command('LDN_ADAPTER');
        return lines.find((l) => l.startsWith('LDN_ADAPTER '))?.slice(12) ?? null;
    }

    async setAdapterPort(where) {
        const lines = await this.command(`LDN_ADAPTER ${where}`);
        return lines.includes(`LDN_ADAPTER ${where}`);
    }

    // Closes the port and hands it back, for the flasher or for opening again.
    async close() {
        const port = this.port;
        const reader = this.reader;
        const writer = this.writer;
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.attached = false;
        this.finishPending();
        try { await reader?.cancel(); } catch {}
        try { reader?.releaseLock(); } catch {}
        try { writer?.releaseLock(); } catch {}
        try { await port?.close(); } catch {}
        return port;
    }
}

// After a reset the board may drop off the bus and come back as a new port object with
// the same permission. Tries the port we had, then any granted port of the same kind.
export async function reopenPort(previous, attempts = 12) {
    const wanted = safeInfo(previous);
    for (let attempt = 0; attempt < attempts; attempt++) {
        await sleep(attempt === 0 ? 1200 : 700);
        let candidates = [];
        try { candidates = await navigator.serial.getPorts(); } catch {}
        candidates = candidates.filter((port) => {
            const info = safeInfo(port);
            return info.usbVendorId === wanted.usbVendorId && info.usbProductId === wanted.usbProductId;
        });
        if (candidates.includes(previous)) candidates = [previous, ...candidates.filter((p) => p !== previous)];
        for (const port of candidates) {
            const device = new EspDevice();
            try {
                await device.open(port);
                return device;
            } catch (error) {
                await device.close();
                if (error.code !== 'port-busy') throw error;   // else not back yet, or a stale entry
            }
        }
    }
    return null;
}

function safeInfo(port) {
    try { return port?.getInfo?.() ?? {}; } catch { return {}; }
}

function parseInfo(line) {
    // LDN_INFO frlg-ldn-bridge 2.0.0 chip=esp32s3 transport=USB Serial/JTAG
    const match = line.match(/^LDN_INFO (\S+) (\S+) chip=(\S+) transport=(.+)$/);
    return match ? { name: match[1], version: match[2], chip: match[3], transport: match[4] } : null;
}

function indexOf(haystack, needle) {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let k = 0; k < needle.length; k++) if (haystack[i + k] !== needle[k]) continue outer;
        return i;
    }
    return -1;
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
