// The trade pool of the GB-Link Pokémon web client, spoken to over the same server and
// the same messages: the server hands out one of its Pokémon, takes the one given for
// it, and both sides confirm the swap in two accept rounds and seven success rounds.
//
// A message is "S", a four-letter tag, a big-endian length and the data, or "G" and a
// tag to ask for one. Counted messages start with a byte that goes up by one each time,
// which is how a repeat of an old message is told from the next one.

import { DataError } from './bytes.js';
import { Pk3 } from './pk3.js';

export const POOL_SERVER = 'wss://pokemon-gb-online-trades.herokuapp.com';
export const POOL_PATH = '/pool3';

const RECORD_SIZE = 149;       // a Pokémon as traded, its mail, the game it is from, gift ribbons
const MON_SIZE = 100;
const MAIL_SIZE = 36;
const CLIENT_VERSION = Uint8Array.of(4, 0, 1, 0, 0, 0);
const ACCEPT = [0xa20000, 0xb20000];
const SUCCESS = [0x900000, 0x910000, 0x920000, 0x930000, 0x940000, 0x950000, 0x9c0000];
const ASK_EVERY_MS = 250;
const CONNECT_MS = 20000;      // the server may have to be woken up first

export class PoolError extends Error {
    constructor(message) { super(message); this.name = 'PoolError'; }
}

// The record the pool keeps for one Pokémon. `wire` is the 100 bytes a game trades;
// `game` is 0 for FireRed and 1 for LeafGreen.
export function poolRecord(wire, { mail = null, game = 0, ribbons = null } = {}) {
    const record = new Uint8Array(RECORD_SIZE);
    record.set(wire.subarray(0, MON_SIZE));
    if (mail) record.set(mail.subarray(0, MAIL_SIZE), MON_SIZE);
    record[MON_SIZE + MAIL_SIZE] = 1;
    record[MON_SIZE + MAIL_SIZE + 1] = game;
    if (ribbons) record.set(ribbons.subarray(0, 11), MON_SIZE + MAIL_SIZE + 2);
    return record;
}

const threeBytes = (value) => Uint8Array.of(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff);
const fromThreeBytes = (bytes) => bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);

export class PoolClient {
    // Socket stands in for WebSocket where there is no server to reach.
    constructor(server = POOL_SERVER, { Socket = globalThis.WebSocket } = {}) {
        this.Socket = Socket;
        this.url = server.replace(/\/$/, '') + POOL_PATH;
        this.socket = null;
        this.sent = new Map();        // tag -> what to send again when the server asks
        this.received = new Map();    // tag -> the latest data for it
        this.ownId = null;
        this.otherId = null;
        this.closed = false;
        this.wake = null;
    }

    connect() {
        this.close();
        this.closed = false;
        this.sent.clear();
        this.received.clear();
        this.ownId = this.otherId = null;
        return new Promise((resolve, reject) => {
            const socket = new this.Socket(this.url);
            socket.binaryType = 'arraybuffer';
            this.socket = socket;
            const unreachable = () => { clearTimeout(timer); if (this.socket === socket) this.close(); reject(new PoolError('No se pudo contactar con la bolsa de intercambio.')); };
            const timer = setTimeout(unreachable, CONNECT_MS);
            socket.onopen = () => { clearTimeout(timer); this.send('VEC3', CLIENT_VERSION); resolve(); };
            socket.onerror = unreachable;
            socket.onclose = () => { if (this.socket === socket) this.closed = true; };
            socket.onmessage = (event) => { if (this.socket === socket) this.onMessage(new Uint8Array(event.data)); };
        });
    }

    close() {
        const socket = this.socket;
        this.socket = null;
        this.closed = true;
        if (!socket) return;
        socket.onopen = socket.onerror = socket.onclose = socket.onmessage = null;
        try { socket.close(); } catch {}
    }

    onMessage(data) {
        if (data.length < 5) return;
        const tag = String.fromCharCode(...data.subarray(1, 5));
        if (data[0] === 0x53 && data.length >= 7) {
            const length = (data[5] << 8) | data[6];
            if (data.length >= 7 + length) this.received.set(tag, data.slice(7, 7 + length));
        } else if (data[0] === 0x47) {
            const again = this.sent.get(tag);
            if (again) this.write('S', tag, again);
        }
        this.wake?.();
    }

    write(kind, tag, data = null) {
        if (!this.socket || this.socket.readyState !== 1) throw new PoolError('Se perdió la conexión con la bolsa de intercambio.');
        const packet = new Uint8Array(5 + (data ? 2 + data.length : 0));
        packet[0] = kind.charCodeAt(0);
        for (let i = 0; i < 4; i++) packet[1 + i] = tag.charCodeAt(i);
        if (data) {
            packet[5] = data.length >> 8;
            packet[6] = data.length & 0xff;
            packet.set(data, 7);
        }
        this.socket.send(packet);
    }

    send(tag, data) {
        this.sent.set(tag, data);
        this.write('S', tag, data);
    }

    sendCounted(tag, data) {
        this.ownId = this.ownId === null ? Math.floor(Math.random() * 256) : (this.ownId + 1) & 0xff;
        const counted = new Uint8Array(1 + data.length);
        counted[0] = this.ownId;
        counted.set(data, 1);
        this.send(tag, counted);
    }

    takeCounted(tag) {
        const data = this.received.get(tag);
        if (!data) return null;
        this.received.delete(tag);
        if (data.length < 1) return null;
        if (this.otherId === null) this.otherId = data[0];
        else if (data[0] !== this.otherId) return null;   // an old message, sent again
        this.otherId = (this.otherId + 1) & 0xff;
        return data.subarray(1);
    }

    // Asks until the server's next counted message under this tag arrives.
    async receive(tag, signal, timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (signal?.aborted) throw new PoolError('La bolsa de intercambio no respondió a tiempo.');
            const data = this.takeCounted(tag);
            if (data) return data;
            if (this.closed) throw new PoolError('Se perdió la conexión con la bolsa de intercambio.');
            if (Date.now() > deadline) throw new PoolError('La bolsa de intercambio dejó de responder.');
            this.write('G', tag);
            await this.arrival(ASK_EVERY_MS);
        }
    }

    // Until the server says something, or it is time to ask again.
    arrival(ms) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
            this.wake = () => { this.wake = null; clearTimeout(timer); resolve(); };
        });
    }

    // The Pokémon the pool offers this connection: its record, the 100 bytes a game
    // trades, and the mail it holds if any.
    async fetchMon(signal) {
        const data = await this.receive('P3SI', signal);
        if (data.length < RECORD_SIZE) throw new PoolError('La bolsa de intercambio no tiene Pokémon que ofrecer ahora mismo.');
        const record = data.slice(0, RECORD_SIZE);
        const wire = record.slice(0, MON_SIZE);
        const pk = new Pk3(wire);
        if (!pk.checksumValid || pk.species === 0 || pk.isBadEgg) throw new DataError('La bolsa de intercambio envió un Pokémon que esta página no puede leer.');
        return { record, wire, pk, mail: pk.hasMail ? record.slice(MON_SIZE, MON_SIZE + MAIL_SIZE) : null };
    }

    // Offers a Pokémon for the pool's one. False when the server will not take it.
    async propose(record, signal) {
        const species = new Pk3(record.subarray(0, MON_SIZE)).speciesInternal;
        this.sendCounted('P3SO', record);
        for (let round = 0; round < 2; round++) {
            const tag = `A3S${round + 1}`;
            this.sendCounted(tag, threeBytes(ACCEPT[round] | species));
            const answer = fromThreeBytes(await this.receive(tag, signal));
            if ((answer & 0xff0000) !== ACCEPT[round]) return false;
        }
        return true;
    }

    // Seals the swap once the games have made theirs: `given` went to the pool, `taken`
    // came from it. False when the server reports it did not go through.
    async complete(given, taken, signal) {
        const ours = [given.speciesInternal, given.pid & 0xffff, given.pid >>> 16, taken.speciesInternal, taken.pid & 0xffff, taken.pid >>> 16, 0];
        for (let round = 0; round < 7; round++) {
            const tag = `S3S${round + 1}`;
            this.sendCounted(tag, threeBytes(SUCCESS[round] | ours[round]));
            const answer = fromThreeBytes(await this.receive(tag, signal));
            if ((answer & 0xff0000) !== SUCCESS[round]) return false;
        }
        return true;
    }
}
