// Generation 3 Pokémon data (PK3): the 80-byte stored and 100-byte party forms, as files
// hold them (decrypted, blocks in a fixed order) and as the games trade them (encrypted,
// blocks ordered by personality). Follows what the reference host gets from PKHeX.Core.

import { DataError, u16, u32, w16, w32 } from './bytes.js';
import { CHARACTERS, CHARACTERS_JAPANESE, EXPERIENCE, NATIONAL, SPECIES, SPECIES_NAMES } from './pk3-data.js';

export const STORED_SIZE = 80;
export const PARTY_SIZE = 100;
const UNOWN = 201;
const JAPANESE = 1;

// Order of the growth, attacks, effort and miscellaneous blocks (0 to 3) in traded data,
// by personality value modulo 24.
const BLOCK_ORDER = [
    [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 2, 3, 1], [0, 3, 1, 2], [0, 3, 2, 1],
    [1, 0, 2, 3], [1, 0, 3, 2], [1, 2, 0, 3], [1, 2, 3, 0], [1, 3, 0, 2], [1, 3, 2, 0],
    [2, 0, 1, 3], [2, 0, 3, 1], [2, 1, 0, 3], [2, 1, 3, 0], [2, 3, 0, 1], [2, 3, 1, 0],
    [3, 0, 1, 2], [3, 0, 2, 1], [3, 1, 0, 2], [3, 1, 2, 0], [3, 2, 0, 1], [3, 2, 1, 0],
];

function checksum(data) {
    let sum = 0;
    for (let at = 0x20; at < 0x50; at += 2) sum = (sum + u16(data, at)) & 0xffff;
    return sum;
}

function cipher(data) {
    const key = (u32(data, 0) ^ u32(data, 4)) >>> 0;
    for (let at = 0x20; at < 0x50; at += 4) w32(data, at, (u32(data, at) ^ key) >>> 0);
}

function decrypt(traded) {
    const data = traded.slice();
    cipher(data);
    const order = BLOCK_ORDER[u32(data, 0) % 24];
    const blocks = data.slice(0x20, 0x50);
    for (let position = 0; position < 4; position++) data.set(blocks.subarray(position * 12, position * 12 + 12), 0x20 + order[position] * 12);
    return data;
}

function encrypt(plain) {
    const data = plain.slice();
    const order = BLOCK_ORDER[u32(data, 0) % 24];
    const blocks = data.slice(0x20, 0x50);
    for (let position = 0; position < 4; position++) data.set(blocks.subarray(order[position] * 12, order[position] * 12 + 12), 0x20 + position * 12);
    cipher(data);
    return data;
}

function text(bytes, language) {
    const table = language === JAPANESE ? CHARACTERS_JAPANESE : CHARACTERS;
    let out = '';
    for (const b of bytes) {
        if (table[b] === null) break;
        out += table[b];
    }
    return out;
}

export class Pk3 {
    // Takes either form, traded or not; data is always the 100-byte party form, decrypted.
    constructor(bytes) {
        if (bytes.length !== STORED_SIZE && bytes.length !== PARTY_SIZE) throw new DataError('Un PK3 debe tener 80 o 100 bytes.');
        let data = new Uint8Array(PARTY_SIZE);
        data.set(bytes);
        if (checksum(data) !== u16(data, 0x1c)) data = decrypt(data);
        this.data = data;
    }

    get pid() { return u32(this.data, 0); }
    get tid() { return u16(this.data, 4); }
    get sid() { return u16(this.data, 6); }
    get language() { return this.data[0x12]; }
    get isBadEgg() { return (this.data[0x13] & 1) !== 0; }
    get checksumValid() { return checksum(this.data) === u16(this.data, 0x1c); }
    get speciesInternal() { return u16(this.data, 0x20); }
    get species() { return NATIONAL[this.speciesInternal] ?? 0; }
    get speciesName() { return SPECIES_NAMES[this.species] ?? ''; }
    get heldItem() { return u16(this.data, 0x22); }
    // Which of its trainer's six mail messages a Pokémon in a party carries.
    get mailIndex() { return this.data.length > 0x55 ? this.data[0x55] : 0xff; }
    get hasMail() { return this.heldItem >= 121 && this.heldItem <= 132 && this.mailIndex < 6; }
    get experience() { return u32(this.data, 0x24); }
    get nickname() { return text(this.data.subarray(0x08, 0x12), this.language); }
    get trainerName() { return text(this.data.subarray(0x14, 0x1b), this.language); }
    get trainerGender() { return this.data[0x47] >> 7; }
    get isEgg() { return ((u32(this.data, 0x48) >>> 30) & 1) === 1; }
    get isShiny() { return (this.tid ^ this.sid ^ (this.pid >>> 16) ^ (this.pid & 0xffff)) < 8; }
    get ivs() { const v = u32(this.data, 0x48); return [0, 5, 10, 15, 20, 25].map((shift) => (v >>> shift) & 31); }
    get evs() { return Array.from(this.data.subarray(0x38, 0x3e)); }
    get partyLevel() { return this.data[0x54]; }
    get stats() { return [0x58, 0x5a, 0x5c, 0x5e, 0x60, 0x62].map((at) => u16(this.data, at)); }

    // 0 male, 1 female, 2 none.
    get gender() {
        const ratio = SPECIES[this.species]?.[7] ?? 255;
        if (ratio === 255) return 2;
        if (ratio === 254) return 1;
        if (ratio === 0) return 0;
        return (this.pid & 0xff) < ratio ? 1 : 0;
    }

    // Unown's letter, 0 to 27; 0 for everything else.
    get form() {
        if (this.species !== UNOWN) return 0;
        const pid = this.pid;
        return (((pid & 0x3000000) >>> 18) | ((pid & 0x30000) >>> 12) | ((pid & 0x300) >>> 6) | (pid & 3)) % 28;
    }

    get level() {
        const table = EXPERIENCE[SPECIES[this.species]?.[6] ?? 0];
        const experience = this.experience;
        let level = 1;
        while (level < 100 && experience >= table[level]) level++;
        return level;
    }

    // Level and stats of the party form, worked out from the stored data.
    resetPartyStats() {
        const base = SPECIES[this.species];
        const level = this.level, ivs = this.ivs, evs = this.evs;
        const nature = this.pid % 25, raised = Math.floor(nature / 5), lowered = nature % 5;
        const stats = [0, 1, 2, 3, 4, 5].map((i) => {
            const core = Math.floor((2 * base[i] + ivs[i] + (evs[i] >> 2)) * level / 100);
            if (i === 0) return base[0] === 1 ? 1 : core + level + 10;
            let stat = core + 5;
            if (raised !== lowered) {
                if (i - 1 === raised) stat = Math.floor(stat * 11 / 10);
                if (i - 1 === lowered) stat = Math.floor(stat * 9 / 10);
            }
            return stat;
        });
        const data = this.data;
        w32(data, 0x50, 0);
        data[0x54] = level;
        w16(data, 0x56, stats[0]);
        [0x58, 0x5a, 0x5c, 0x5e, 0x60, 0x62].forEach((at, i) => w16(data, at, stats[i]));
    }

    refreshChecksum() { w16(this.data, 0x1c, checksum(this.data)); }

    // The party form as a file holds it.
    export() {
        const copy = new Pk3(this.data);
        copy.refreshChecksum();
        return copy.data;
    }
}

// A Pokémon from a file or a saved party. Throws DataError unless it can be traded.
export function parse(bytes) {
    const pk = new Pk3(bytes);
    if (!pk.checksumValid || pk.species === 0 || pk.species > 386 || pk.isBadEgg) throw new DataError('Falló la suma de comprobación del PK3, o este no es un Pokémon válido de tercera generación.');
    if (bytes.length === STORED_SIZE || pk.partyLevel === 0) pk.resetPartyStats();
    return pk;
}

// The 100 bytes a game puts on the link for this Pokémon. mailIndex says which of the
// six messages sent with the party is its own; without one it carries no mail.
export function toWire(bytes, mailIndex = 0xff) {
    const pk = parse(bytes);
    pk.data[0x55] = mailIndex;
    pk.refreshChecksum();
    return encrypt(pk.data);
}
