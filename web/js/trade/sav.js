// Reads the PC boxes out of a Generation 3 save file (.sav). Read-only: nothing here
// writes back to the buffer or talks to the pool or the ESP32. Reuses Pk3/parse from
// pk3.js untouched, since a box slot is the same 80-byte stored form pk3.js already
// reads from .pk3 files.

import { DataError, u16, u32 } from './bytes.js';
import { parse } from './pk3.js';

const SLOT_SIZE = 0xE000;          // one save area: 14 sections of 0x1000 each
const SECTION_SIZE = 0x1000;
const SECTION_COUNT = 14;
const FOOTER_OFFSET = 0xFF4;       // id, checksum, signature, save index, within a section
const SIGNATURE = 0x08012025;
const STORED_SIZE = 80;
export const BOXES = 14;
export const SLOTS_PER_BOX = 30;

// Bytes of real data in each section, by section ID (0-13). The rest of a 0x1000
// section is padding and does not count toward its checksum.
const SECTION_LEN = [3884, 3968, 3968, 3968, 3848, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000];
const PC_FIRST_SECTION = 5;
const PC_LAST_SECTION = 13;
const PC_BUFFER_SIZE = 4 + BOXES * SLOTS_PER_BOX * STORED_SIZE + BOXES * 9 + BOXES; // currentBox + boxes + names + wallpapers

function sectionChecksum(view, offset, length) {
    let sum = 0;
    for (let at = 0; at < length; at += 4) sum = (sum + u32(view, offset + at)) >>> 0;
    return ((sum >>> 16) + (sum & 0xffff)) & 0xffff;
}

// One save area (slot 1 or slot 2 of the file). Returns its 14 sections keyed by
// section ID, its save index (higher = more recent), and whether every section's
// checksum matched.
function readSlot(view, base) {
    const sections = new Map();
    let saveIndex = -1;
    let valid = true;
    for (let i = 0; i < SECTION_COUNT; i++) {
        const offset = base + i * SECTION_SIZE;
        const footer = offset + FOOTER_OFFSET;
        if (footer + 12 > view.length) { valid = false; continue; }
        const id = u16(view, footer);
        const storedChecksum = u16(view, footer + 2);
        const signature = u32(view, footer + 4);
        const index = u32(view, footer + 8);
        if (signature !== SIGNATURE || id > 13) { valid = false; continue; }
        const length = SECTION_LEN[id];
        if (sectionChecksum(view, offset, length) !== storedChecksum) { valid = false; continue; }
        sections.set(id, view.subarray(offset, offset + length));
        saveIndex = index;
    }
    return { sections, saveIndex, valid: valid && sections.size === SECTION_COUNT };
}

// Picks the more recently written of the two save areas a Gen 3 file keeps, so a
// power cut mid-save does not leave you reading half-written boxes.
function readActiveSlot(view) {
    const slot1 = readSlot(view, 0);
    const slot2 = view.length >= 2 * SLOT_SIZE ? readSlot(view, SLOT_SIZE) : { valid: false };
    if (!slot1.valid && !slot2.valid) throw new DataError('Esto no parece un archivo de guardado de tercera generación, o sus dos ranuras están dañadas.');
    if (slot1.valid && (!slot2.valid || slot1.saveIndex > slot2.saveIndex)) return slot1;
    return slot2;
}

// The 33744-byte PC buffer (current box, then all 14 boxes, then their names and
// wallpapers), reassembled from sections 5-13 in section-ID order. Their order in the
// file itself can be anything; the console rotates it on every save.
function readPcBuffer(view) {
    const slot = readActiveSlot(view);
    const buffer = new Uint8Array(PC_BUFFER_SIZE);
    let at = 0;
    for (let id = PC_FIRST_SECTION; id <= PC_LAST_SECTION; id++) {
        const section = slot.sections.get(id);
        if (!section) throw new DataError('Al archivo de guardado le faltan los datos de las cajas.');
        buffer.set(section, at);
        at += section.length;
    }
    return buffer;
}

// All 14 boxes, 30 slots each, in save order: `boxes[b][s]` is a Pk3, or null for an
// empty slot. Throws DataError if this is not a readable Generation 3 save.
export function readBoxes(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const buffer = readPcBuffer(view);
    const boxes = [];
    for (let box = 0; box < BOXES; box++) {
        const slots = [];
        for (let slot = 0; slot < SLOTS_PER_BOX; slot++) {
            const at = 4 + (box * SLOTS_PER_BOX + slot) * STORED_SIZE;
            const raw = buffer.subarray(at, at + STORED_SIZE);
            slots.push(raw.some((b) => b !== 0) ? tryParse(raw) : null);
        }
        boxes.push(slots);
    }
    return boxes;
}

// A box slot with a bad checksum, an out-of-range species, or the bad-egg flag set is
// a genuinely empty-but-nonzero slot, not a file the page should refuse outright —
// parse() already treats those as unreadable for a lone .pk3 file, so skip just this one.
function tryParse(raw) {
    try { return parse(raw); }
    catch { return null; }
}
