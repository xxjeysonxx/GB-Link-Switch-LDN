// The GB-Link adapter, over WebUSB or WebSerial. Either way it looks like a stream of
// GB-Link frames in both directions, which is what the bridge firmware speaks on its
// UART: over serial the adapter frames its traffic that way itself, and over WebUSB the
// channels are separate endpoints that are framed and unframed here.

import { GB_CHANNEL, GbFrameParser, buildGbFrame } from './wire.js';

export const GBLINK_VENDOR_ID = 0x2fe3;
export const BOOTROM_VENDOR_ID = 0x2e8a;

export const COMMAND = {
    SET_MODE: 0x00,
    CANCEL: 0x01,
    FIRMWARE_INFO: 0x0f,
    REBOOT_BOOTLOADER: 0x43,
    WIRELESS_STATS: 0x4c,
};

export const MODE_WIRELESS_ADAPTER = 0x07;

const ENDPOINT_SIZE = 64;

class GbLinkBase extends EventTarget {
    constructor() {
        super();
        this.onBytes = null;       // (Uint8Array) => void: GB-Link frames from the adapter
        this.waiters = [];         // requests waiting for a data-channel reply
        this.resets = [];          // { at, count } over the last few seconds
        this.resetLoop = false;
        this.startedUp = false;    // past the ID handshake, into commands
    }

    // Sends a command and resolves with its reply, or null. Replies arrive on the data
    // channel and start with the command byte; an adapter in a mode also streams its
    // own traffic there, so anything else is passed over.
    request(payload, timeoutMs = 600) {
        return new Promise((resolve) => {
            const waiter = { command: payload[0], resolve, timer: null };
            waiter.timer = setTimeout(() => {
                const at = this.waiters.indexOf(waiter);
                if (at >= 0) this.waiters.splice(at, 1);
                resolve(null);
            }, timeoutMs);
            this.waiters.push(waiter);
            this.sendCommand(payload).catch(() => {});
        });
    }

    // A game that cannot get a command through to the adapter resets it and tries again
    // about four times a second, and blocks while it does: on the GBA that is a freeze.
    // Ordinary play resets the adapter a handful of times in all.
    noteResets(count) {
        const now = Date.now();
        this.resets.push({ at: now, count });
        while (this.resets.length > 1 && now - this.resets[0].at > 5000) this.resets.shift();
        const risen = (count - this.resets[0].count) & 0xff;
        const looping = risen >= 10;
        if (looping === this.resetLoop) return;
        this.resetLoop = looping;
        this.dispatchEvent(new CustomEvent('resetloop', { detail: { looping, startedUp: this.startedUp } }));
    }

    deliver(channel, payload) {
        if (channel !== GB_CHANNEL.DATA || payload.length === 0) return;
        // Twice a second while the wireless adapter mode runs: how often the game has reset
        // the adapter (8 bits, wrapping), and how far the adapter's side of the start-up is.
        if (payload[0] === 0x1d && payload.length === 25) { this.noteResets(payload[14]); return; }
        if (payload[0] === 0x0e && payload.length === 16) { this.startedUp = payload[3] >= 2; return; }
        const at = this.waiters.findIndex((waiter) => waiter.command === payload[0]);
        if (at < 0) return;
        const [waiter] = this.waiters.splice(at, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(payload);
    }

    // Version, and whether this build has the wireless adapter mode: only that firmware
    // answers the statistics command.
    async identify() {
        const info = await this.request([COMMAND.FIRMWARE_INFO]);
        const stats = await this.request([COMMAND.WIRELESS_STATS], 400);
        return {
            version: info && info.length >= 4 && info[0] === COMMAND.FIRMWARE_INFO
                ? `${info[1]}.${info[2]}.${info[3]}` : null,
            wireless: Boolean(stats && stats.length >= 21 && stats[0] === COMMAND.WIRELESS_STATS),
        };
    }

    rebootToBootloader() {
        return this.sendCommand([COMMAND.REBOOT_BOOTLOADER]).catch(() => {});
    }

    leaveMode() {
        return this.sendCommand([COMMAND.CANCEL]).catch(() => {});
    }
}

export class GbLinkSerial extends GbLinkBase {
    constructor() {
        super();
        this.kind = 'serial';
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.parser = new GbFrameParser(ENDPOINT_SIZE);
    }

    static available() {
        return typeof navigator !== 'undefined' && Boolean(navigator.serial);
    }

    static requestPort() {
        return navigator.serial.requestPort({ filters: [{ usbVendorId: GBLINK_VENDOR_ID }] });
    }

    async open(port) {
        await port.open({ baudRate: 115200, bufferSize: 16384 });
        this.port = port;
        this.writer = port.writable.getWriter();
        this.reader = port.readable.getReader();
        this.readEnded = false;
        this.readLoop();
        // See PORT_LOST_ADVICE in esp.js: the same thing happens to this port.
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (this.readEnded) {
            throw Object.assign(new Error('El navegador perdió el puerto en cuanto lo abrió. En Linux pasa cuando otro programa serie ha usado el puerto: desenchufa el adaptador y vuelve a enchufarlo, y conecta de nuevo.'), { code: 'port-lost' });
        }
    }

    async readLoop() {
        const reader = this.reader;
        try {
            while (reader === this.reader) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;
                if (this.onBytes) this.onBytes(value);
                for (const frame of this.parser.push(value)) this.deliver(frame.channel, frame.payload);
            }
        } catch {
            // Unplugged, or close() cancelled the read.
        }
        this.readEnded = true;
        if (reader === this.reader) this.dispatchEvent(new Event('disconnected'));
    }

    // A stream of whole GB-Link frames, as the bridge firmware sends them.
    writeStream(bytes) {
        if (!this.writer) return;
        this.writer.write(bytes).catch(() => {});
    }

    sendCommand(payload) {
        if (!this.writer) return Promise.reject(new Error('Sin conexión'));
        return this.writer.write(buildGbFrame(GB_CHANNEL.COMMAND, Uint8Array.from(payload)));
    }

    async close() {
        const { port, reader, writer } = this;
        this.port = null;
        this.reader = null;
        this.writer = null;
        try { await reader?.cancel(); } catch {}
        try { reader?.releaseLock(); } catch {}
        try { writer?.releaseLock(); } catch {}
        try { await port?.close(); } catch {}
    }
}

export class GbLinkUsb extends GbLinkBase {
    constructor() {
        super();
        this.kind = 'usb';
        this.device = null;
        this.endpoints = null;     // { commandOut, statusIn, dataOut, dataIn }
        this.parser = new GbFrameParser(ENDPOINT_SIZE);
        this.outbound = Promise.resolve();
        this.running = false;
    }

    static available() {
        return typeof navigator !== 'undefined' && Boolean(navigator.usb);
    }

    // The bootloader is offered too, so that a board already in update mode can be picked.
    static requestDevice() {
        return navigator.usb.requestDevice({
            filters: [{ vendorId: GBLINK_VENDOR_ID }, { vendorId: BOOTROM_VENDOR_ID }],
        });
    }

    async open(device) {
        if (!device.opened) await device.open();
        if (!device.configuration) await device.selectConfiguration(1);
        const found = findVendorInterface(device);
        if (!found) throw new Error('Este dispositivo no tiene interfaz GB-Link.');
        await device.claimInterface(found.interfaceNumber);
        this.device = device;
        this.endpoints = found;
        this.running = true;
        this.readLoop(found.dataIn, GB_CHANNEL.DATA);
        this.readLoop(found.statusIn, GB_CHANNEL.STATUS);
    }

    async readLoop(endpoint, channel) {
        const device = this.device;
        try {
            while (this.running && device === this.device) {
                const result = await device.transferIn(endpoint, ENDPOINT_SIZE);
                if (result.status === 'stall') { await device.clearHalt('in', endpoint); continue; }
                if (!result.data || result.data.byteLength === 0) continue;
                const payload = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
                if (this.onBytes) this.onBytes(buildGbFrame(channel, payload));
                this.deliver(channel, payload);
            }
        } catch {
            // Unplugged, or close() ended the transfers.
        }
        if (this.running && device === this.device && channel === GB_CHANNEL.DATA) {
            this.running = false;
            this.dispatchEvent(new Event('disconnected'));
        }
    }

    // One transfer per frame, in the order given: a mode change has to land before the
    // data that follows it.
    writeStream(bytes) {
        for (const frame of this.parser.push(bytes)) {
            const endpoint = frame.channel === GB_CHANNEL.COMMAND ? this.endpoints?.commandOut
                : frame.channel === GB_CHANNEL.DATA ? this.endpoints?.dataOut : null;
            if (endpoint) this.transferOut(endpoint, frame.payload);
        }
    }

    transferOut(endpoint, payload) {
        const device = this.device;
        const result = this.outbound.then(() => {
            if (!device || device !== this.device) throw new Error('Sin conexión');
            return device.transferOut(endpoint, payload);
        });
        this.outbound = result.catch(() => {});
        return result;
    }

    sendCommand(payload) {
        if (!this.endpoints) return Promise.reject(new Error('Sin conexión'));
        return this.transferOut(this.endpoints.commandOut, Uint8Array.from(payload));
    }

    async close() {
        const device = this.device;
        this.running = false;
        this.device = null;
        this.endpoints = null;
        try { if (device?.opened) await device.close(); } catch {}
    }
}

// The vendor interface has two endpoints each way: commands out and status in on the
// lower pair, data both ways on the upper.
function findVendorInterface(device) {
    for (const iface of device.configuration?.interfaces ?? []) {
        for (const alternate of iface.alternates) {
            if (alternate.interfaceClass !== 0xff) continue;
            const numbers = (direction) => alternate.endpoints
                .filter((endpoint) => endpoint.direction === direction)
                .map((endpoint) => endpoint.endpointNumber)
                .sort((a, b) => a - b);
            const ins = numbers('in');
            const outs = numbers('out');
            if (ins.length < 2 || outs.length < 2) continue;
            return {
                interfaceNumber: iface.interfaceNumber,
                commandOut: outs[0],
                statusIn: ins[0],
                dataOut: outs[outs.length - 1],
                dataIn: ins[ins.length - 1],
            };
        }
    }
    return null;
}
