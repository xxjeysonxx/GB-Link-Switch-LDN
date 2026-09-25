// The six Pokémon this page offers the Switch. Kept in the browser between visits, and
// started from the party the project ships when there is nothing saved yet.

import { fromHex, toHex } from './bytes.js';
import { Pk3, parse } from './pk3.js';

const STORE = 'gblink-switch-party';
export const DEFAULT_PARTY = 'assets/party.json';

export class Party {
    constructor() {
        this.slots = [null, null, null, null, null, null];
        this.selected = 0;
    }

    get occupied() { return this.slots.filter(Boolean).length; }
    get canTrade() { return this.occupied >= 2 && Boolean(this.slots[this.selected]); }

    read(record) {
        const entries = record.slots;
        if (!Array.isArray(entries) || entries.length !== 6) throw new Error('Un equipo necesita seis casillas.');
        this.slots = entries.map((entry) => (entry ? parse(fromHex(entry.toLowerCase())) : null));
        this.selected = Number(record.selected) || 0;
        if (!this.slots[this.selected]) this.selected = this.slots.findIndex(Boolean);
        if (this.selected < 0) this.selected = 0;
    }

    // What was saved here before, else the party the project ships.
    async load(fetchDefault = true) {
        const saved = localStorage.getItem(STORE);
        if (saved) {
            try { this.read(JSON.parse(saved)); return 'saved'; }
            catch { localStorage.removeItem(STORE); }
        }
        if (!fetchDefault) return 'empty';
        const response = await fetch(DEFAULT_PARTY, { cache: 'no-store' });
        if (!response.ok) return 'empty';
        this.read(await response.json());
        return 'default';
    }

    save() {
        try { localStorage.setItem(STORE, JSON.stringify(this.record())); } catch {}
    }

    record() {
        return { selected: this.selected, slots: this.slots.map((pk) => (pk ? toHex(pk.export()) : null)) };
    }

    export() { return this.slots.map((pk) => (pk ? pk.export() : null)); }

    set(index, pk) {
        this.slots[index] = pk;
        if (!this.slots[this.selected]) this.selected = this.slots.findIndex(Boolean);
        if (this.selected < 0) this.selected = 0;
        this.save();
    }

    select(index) {
        if (!this.slots[index]) return false;
        this.selected = index;
        this.save();
        return true;
    }

    // A Pokémon the Switch sent, into the slot that was traded away.
    receive(index, bytes) {
        this.slots[index] = parse(bytes);
        this.save();
    }
}

export function describe(pk) {
    const kind = pk.isEgg ? 'Huevo' : pk.speciesName;
    const gender = pk.gender === 0 ? '♂' : pk.gender === 1 ? '♀' : '';
    return { name: pk.isEgg ? 'Huevo' : pk.nickname || kind, kind, level: pk.isEgg ? '' : `Nv. ${pk.level}`, gender, shiny: pk.isShiny && !pk.isEgg };
}

export { Pk3 };
