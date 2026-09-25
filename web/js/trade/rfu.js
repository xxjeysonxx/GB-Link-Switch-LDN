// The GBA wireless adapter's link layer as the games use it, and the frames that carry
// it over Pia. Port of host/core/Rfu.cs. A command is seven 16-bit words; words[0] holds
// the operation in its high byte.

import { DataError, ascii, fromHex, pad, u16, w16, w32 } from './bytes.js';
import { CHARACTERS } from './pk3-data.js';

export function words(command, value = 0, owner = 0) {
    return [command, value, owner, 0, 0, 0, 0];
}

export function fragment(index, data) {
    const b = pad(data, 12);
    return [0x8900 | index, u16(b), u16(b, 2), u16(b, 4), u16(b, 6), u16(b, 8), u16(b, 10)];
}

export function ni(state, n, phase, ack, payload) {
    const b = new Uint8Array(2 + payload.length);
    w16(b, 0, (state << 10) | (ack << 9) | (n << 7) | (phase << 5) | payload.length);
    b.set(payload, 2);
    return b;
}

// The name exchange a joining game runs before data frames start.
export function gameData() {
    const b = new Uint8Array(26);
    w16(b, 0, 2);
    w16(b, 2, 2 | (5 << 10));
    w16(b, 4, 0x8822);
    b[12] = 0x84;
    b.set(gameName('Soora', 9), 17);
    return [
        ni(1, 1, 0, 0, fromHex('010c001a000000')), ni(2, 1, 0, 0, b.subarray(0, 12)), ni(2, 1, 1, 0, b.subarray(12, 24)),
        ni(2, 1, 2, 0, b.subarray(24)), ni(3, 0, 0, 0, new Uint8Array(0)), ni(0, 1, 0, 0, new Uint8Array(0)),
    ];
}

// Text in the games' character set; only what a trainer name needs.
export function gameName(name, size) {
    const b = new Uint8Array(size);
    let n = 0;
    for (const c of name.slice(0, size - 1)) {
        b[n++] = c >= 'A' && c <= 'Z' ? c.charCodeAt(0) - 65 + 0xbb
            : c >= 'a' && c <= 'z' ? c.charCodeAt(0) - 97 + 0xd5
            : c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 + 0xa1 : 0;
    }
    b[n] = 255;
    return b;
}

export function readName(bytes) {
    let out = '';
    for (const b of bytes) {
        if (CHARACTERS[b] === null) break;
        out += CHARACTERS[b];
    }
    return out;
}

export function playerBlock() {
    const b = new Uint8Array(200);
    const magic = pad(ascii('GameFreak inc.'), 16);
    b.set(magic, 0);
    b.set(magic, 44);
    w16(b, 16, 0x4005);
    w16(b, 18, 0x8000);
    w32(b, 20, 0x47ed8822);
    b.set(gameName('Soora', 8), 24);
    b[32] = b[34] = 0x11;
    w16(b, 42, 2);
    return b;
}

export function trainerCard() {
    const b = new Uint8Array(100);
    b[2] = 1;
    w16(b, 14, 0x8822);
    b.set(gameName('Soora', 8), 48);
    b[56] = 5;
    return b;
}

const MAGIC = ascii('GameFreak inc.');
export function isPlayer(b) {
    if (b.length < 60) return false;
    for (let i = 0; i < 14; i++) if (b[i] !== MAGIC[i] || b[44 + i] !== MAGIC[i]) return false;
    return true;
}

// "WT": one adapter payload for the host, stamped with this side's frame counter.
export function wrap(slot, time) {
    const b = new Uint8Array(12 + ((slot.length + 3) & ~3));
    b[0] = 0x57; b[1] = 0x54;
    w16(b, 2, b.length - 4);
    w32(b, 4, time);
    b[9] = slot.length;
    b.set(slot, 12);
    return b;
}

// "WK": acknowledges the host's frame stamped `time`.
export function ack(sequence, middle, time) {
    const b = new Uint8Array(16);
    b[0] = 0x57; b[1] = 0x4b; b[2] = 12;
    w32(b, 4, sequence);
    w32(b, 8, middle);
    w32(b, 12, time);
    return b;
}

// A block arriving as 12-byte fragments.
export class BlockReceive {
    constructor() {
        this.count = 0;
        this.last = -1;
        this.flags = 0;
        this.data = new Uint8Array(0);
        this.receiving = false;
        this.done = false;
    }

    init(count) {
        if (count < 1 || count > 32) throw new DataError('Invalid RFU fragment count');
        if (this.receiving && !this.done && count === this.count) return;
        this.count = count;
        this.last = -1;
        this.flags = 0;
        this.data = new Uint8Array(count * 12);
        this.receiving = true;
        this.done = false;
    }

    // True when this fragment completed the block.
    add(index, piece) {
        if (!this.receiving || index < 0 || index >= this.count) return false;
        const previous = this.done;
        this.last = index;
        this.flags = (this.flags | (1 << index)) >>> 0;
        this.data.set(piece, index * 12);
        this.done = this.flags === allFragments(this.count);
        return this.done && !previous;
    }
}

const allFragments = (count) => (count === 32 ? 0xffffffff : ((1 << count) - 1) >>> 0);

// A block going out, paced by the peer's echo of what it has received.
export class BlockSend {
    constructor(bytes) {
        this.bytes = bytes;
        this.state = 0;
        this.index = 0;
        this.roundRobin = 0;
        this.count = Math.max(1, Math.floor((bytes.length + 11) / 12));
    }

    get done() { return this.state === 3; }

    piece(i) { return fragment(i, this.bytes.subarray(i * 12, Math.min(this.bytes.length, (i + 1) * 12))); }

    tick(echo) {
        if (this.done) return words(0);
        if (this.state === 0) {
            if (echo.receiving && echo.count === this.count) this.state = 1;
            else return words(0x8800, this.count, 0x81);
        }
        if (this.state === 1) {
            const result = this.piece(this.index);
            if (++this.index >= this.count) this.state = 2;
            return result;
        }
        const last = this.count - 1;
        if (echo.last === last) {
            if (echo.flags === ((1 << this.count) - 1) >>> 0) { this.state = 3; return words(0); }
            const missing = [];
            for (let i = 0; i < this.count; i++) if ((echo.flags & (1 << i)) === 0) missing.push(i);
            if (missing.length > 0) { this.roundRobin = (this.roundRobin + 1) % missing.length; return this.piece(missing[this.roundRobin]); }
        }
        return this.piece(last);
    }
}

// The standby rounds ("link barriers") both games run between steps, and the close.
export class Barrier {
    constructor() {
        this.mode = 0;
        this.count = 0;
        this.hostCount = -1;
        this.rounds = 0;
        this.initiated = false;
        this.sinceHost = 0;
        this.sinceInitiate = 0;
        this.burstFor = -1;
        this.burst = 0;
    }

    get active() { return this.mode !== 0; }

    reset() {
        if (this.mode === 1) { this.mode = 0; this.initiated = false; this.sinceInitiate = 0; this.burstFor = -1; }
    }

    initiate() {
        if (this.mode === 1) return;
        this.mode = 1; this.initiated = true; this.hostCount = -1; this.sinceHost = this.sinceInitiate = 0; this.burstFor = -1;
    }

    feed(op, count) {
        this.sinceHost = 0;
        const previous = this.hostCount;
        this.hostCount = count;
        if (op === 0x5f00) {
            this.count = count;
            if (this.mode !== 2) { this.mode = 2; this.initiated = false; }
            return;
        }
        if (this.initiated && this.mode === 1) {
            if (count === this.count) { this.count++; this.rounds++; this.mode = 0; this.initiated = false; this.sinceInitiate = 0; }
            return;
        }
        if (count < this.count) return;
        if (this.mode !== 1) { this.mode = 1; this.initiated = false; }
        else if (previous >= 0 && previous !== count) this.rounds++;
        this.count = count;
        this.sinceInitiate = 0;
    }

    observe(saw) {
        if (this.mode !== 1) return;
        if (saw) { this.sinceHost = this.sinceInitiate = 0; return; }
        this.sinceHost++;
        if (this.initiated) { if (++this.sinceInitiate > 120) { this.mode = 0; this.initiated = false; } }
        else if (this.sinceHost > 90) { this.count++; this.rounds++; this.mode = 0; }
    }

    emit() {
        if (this.mode === 0) return null;
        if (this.burstFor !== this.count) { this.burstFor = this.count; this.burst = 0; }
        if (this.burst++ >= 6) return null;
        return words(this.mode === 1 ? 0x6600 : 0x5f00, this.count);
    }
}
