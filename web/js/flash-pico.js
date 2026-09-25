// Installs firmware on the GB-Link adapter (RP2040) over WebUSB with picoflash. The
// adapter has to be in its USB bootloader, where it shows up as "RP2 Boot": firmware
// 2.1.2 and later goes there on command, anything else by holding BOOTSEL while
// plugging in.

import { Picoboot } from '../vendor/picoflash/picoboot.js';
import { Target } from '../vendor/picoflash/target.js';
import { uf2ToFlashBuffer } from '../vendor/picoflash/uf2.js';
import { BOOTROM_VENDOR_ID } from './gblink.js';

const SECTOR = 4096;
const ERASE_STEP = 16 * SECTOR;
const WRITE_STEP = 4 * SECTOR;
const ERASE_SHARE = 0.3;      // of the progress bar
const REBOOT_DELAY_MS = 500;

export function parseUf2(bytes) {
    const image = uf2ToFlashBuffer(bytes);
    const padded = new Uint8Array(Math.ceil(image.data.length / SECTOR) * SECTOR).fill(0xff);
    padded.set(image.data);
    return { address: image.address, data: padded };
}

// Needs a user gesture. The chooser only renews the permission: Linux can list several
// stale "RP2 Boot" entries for one board, so every granted bootloader is tried and the
// one that opens is used.
export async function chooseBootloader() {
    await Picoboot.requestDevice([new Target('RP2040')]);
    for (let attempt = 0; attempt < 3; attempt++) {
        const stale = [];
        for (const picoboot of (await Picoboot.getDevices([new Target('RP2040')])) ?? []) {
            try {
                await picoboot.connect();
                for (const other of stale) { try { await other.device?.forget?.(); } catch {} }
                return picoboot;
            } catch {
                await release(picoboot);
                stale.push(picoboot);
            }
        }
        await sleep(400);
    }
    throw new Error('No se pudo abrir el adaptador. Si aparecen varias entradas "RP2 Boot", elige otra.');
}

export function bootloaderFrom(device) {
    return Picoboot.fromDevice(device);
}

export async function flashAdapter(picoboot, image, { onStatus = () => {}, onProgress = () => {} } = {}) {
    try {
        const connection = await connectWithRetry(picoboot);
        await connection.resetInterface();
        await connection.exitXip();

        onStatus('Borrando…');
        for (let at = 0; at < image.data.length; at += ERASE_STEP) {
            await connection.flashErase(image.address + at, Math.min(ERASE_STEP, image.data.length - at));
            onProgress(ERASE_SHARE * Math.min(1, (at + ERASE_STEP) / image.data.length));
        }
        onStatus('Escribiendo… no desenchufes el adaptador.');
        for (let at = 0; at < image.data.length; at += WRITE_STEP) {
            await connection.flashWrite(image.address + at, image.data.subarray(at, at + WRITE_STEP));
            onProgress(ERASE_SHARE + (1 - ERASE_SHARE) * Math.min(1, (at + WRITE_STEP) / image.data.length));
        }
        onStatus('Escrito. Reiniciando el adaptador…');
        try { await connection.reboot(REBOOT_DELAY_MS); } catch {}   // the link drops as it restarts
    } finally {
        await release(picoboot);
    }
    await forgetBootloaders();
}

// Right after the bootloader enumerates, its device node is not always openable yet.
async function connectWithRetry(picoboot) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await picoboot.connect();
        } catch (error) {
            const transient = error?.name === 'SecurityError' || /access denied/i.test(error?.message ?? '');
            await release(picoboot);
            if (!transient || attempt >= 3) throw error;
            await sleep(400);
        }
    }
}

// disconnect() closes only an established connection; a connect() that failed part-way
// leaves the device open, and an open handle on a board that restarts lingers as a
// phantom entry.
async function release(picoboot) {
    try { await picoboot.disconnect(); } catch {}
    try { if (picoboot.device?.opened) await picoboot.device.close(); } catch {}
}

// Every grant for the bootloader is stale once the board has left it.
async function forgetBootloaders() {
    try {
        for (const device of await navigator.usb.getDevices()) {
            if (device.vendorId === BOOTROM_VENDOR_ID) { try { await device.forget?.(); } catch {} }
        }
    } catch {}
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
