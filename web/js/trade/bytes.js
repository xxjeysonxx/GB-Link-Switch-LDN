// Byte helpers shared by the trade modules. Multi-byte fields are little-endian unless
// the name says big (b16, wb32, ...); 64-bit values are BigInt.

export function u16(b, o = 0) { return b[o] | (b[o + 1] << 8); }
export function u32(b, o = 0) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
export function u64(b, o = 0) { return BigInt(u32(b, o)) | (BigInt(u32(b, o + 4)) << 32n); }
export function b16(b, o = 0) { return (b[o] << 8) | b[o + 1]; }
export function b32(b, o = 0) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
export function b64(b, o = 0) { return (BigInt(b32(b, o)) << 32n) | BigInt(b32(b, o + 4)); }

export function w16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; }
export function w32(b, o, v) { w16(b, o, v & 0xffff); w16(b, o + 2, (v >>> 16) & 0xffff); }
export function w64(b, o, v) { w32(b, o, Number(v & 0xffffffffn)); w32(b, o + 4, Number((v >> 32n) & 0xffffffffn)); }
export function wb16(b, o, v) { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; }
export function wb32(b, o, v) { wb16(b, o, (v >>> 16) & 0xffff); wb16(b, o + 2, v & 0xffff); }
export function wb64(b, o, v) { wb32(b, o, Number((v >> 32n) & 0xffffffffn)); wb32(b, o + 4, Number(v & 0xffffffffn)); }

export function fromHex(text) {
    if (text.length % 2 || /[^0-9a-f]/i.test(text)) throw new DataError('Cadena hexadecimal no válida');
    const out = new Uint8Array(text.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16);
    return out;
}

export function toHex(bytes, upper = false) {
    let text = '';
    for (let i = 0; i < bytes.length; i++) text += bytes[i].toString(16).padStart(2, '0');
    return upper ? text.toUpperCase() : text;
}

export function join(...parts) {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}

export function pad(data, length, value = 0) {
    const out = new Uint8Array(length).fill(value);
    out.set(data.subarray(0, Math.min(data.length, length)));
    return out;
}

export function equal(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

export function mac(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(':'); }
export function ipString(bytes, o = 0) { return `${bytes[o]}.${bytes[o + 1]}.${bytes[o + 2]}.${bytes[o + 3]}`; }

export function ipBytes(text) {
    const parts = text.split('.');
    if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) throw new DataError(`Dirección IPv4 no válida: ${text}`);
    return Uint8Array.from(parts, Number);
}

// a is before b in 16-bit sequence space.
export function less(a, b) {
    const d = (b - a) & 0xffff;
    return d > 0 && d < 0x8000;
}

export function ascii(text) { return new TextEncoder().encode(text); }

export function randomBytes(length) {
    const out = new Uint8Array(length);
    globalThis.crypto.getRandomValues(out);
    return out;
}

// Malformed or unauthenticated data from the wire, as opposed to a lost connection.
export class DataError extends Error {
    constructor(message) { super(message); this.name = 'DataError'; }
}

export class ConnectionError extends Error {
    constructor(message) { super(message); this.name = 'ConnectionError'; }
}
