// Puts every Pokémon that arrives from the Switch into a folder on disk, so a trade
// leaves a .pk3 behind without anyone pressing anything.
//
// Two ways to reach a folder, and the page works out which one it has:
//
//   'server'  the project's own serve.py is answering. It writes into PK3/ at the
//             project root. Nothing to set up, no permission to grant.
//   'disk'    the page is being served by something else (a plain static server, or a
//             host), so the File System Access API is all that is left: the user points
//             at a folder once, and the handle is kept in IndexedDB. Chrome may ask
//             again in a later session, and only a click can answer that, which is what
//             resume() is for.
//
// Either way the files land in a folder called PK3 (or pk3), never mixed in with the
// rest of whatever the user pointed at.

const ENDPOINT = '/api/pk3';
const SUBFOLDER = 'PK3';
const DB_NAME = 'gblink-pk3-folder';
const STORE = 'handles';
const KEY = 'folder';

let mode = null;         // 'server' | 'disk' | null while nothing is set up
let serverFolder = '';   // where the project's server writes
let root = null;         // the folder the user picked, in disk mode
let dir = null;          // the PK3 folder inside it

export const subfolder = SUBFOLDER;
export const backend = () => mode;
export const available = () => mode === 'server' || typeof window.showDirectoryPicker === 'function';
export const folderName = () => (mode === 'server' ? serverFolder : root?.name ?? '');

// ---------------------------------------------------------------- names

// Windows and macOS both refuse these in a file name, and a name that is only those
// characters would leave nothing behind.
function clean(name) {
    const safe = String(name ?? '').replace(/[\\/:*?"<>|]/g, '').replace(/[\u0000-\u001f]/g, '').trim();
    return safe || 'pokemon';
}

// Two Pokémon can share a name, and neither should overwrite the other. The server
// settles this itself; on disk it has to be worked out here.
async function freeName(base) {
    let name = `${base}.pk3`;
    for (let n = 2; ; n++) {
        try { await dir.getFileHandle(name); } catch { return name; }
        name = `${base}-${n}.pk3`;
    }
}

// ---------------------------------------------------------------- remembering the handle

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function run(action) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        const request = action(db.transaction(STORE, 'readwrite').objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }));
}

const readHandle = () => run((store) => store.get(KEY));
const writeHandle = (handle) => run((store) => store.put(handle, KEY));
const clearHandle = () => run((store) => store.delete(KEY));

// ---------------------------------------------------------------- permission

const OPTIONS = { mode: 'readwrite' };

async function allowed(handle, { ask = false } = {}) {
    if (!handle?.queryPermission) return true;
    if (await handle.queryPermission(OPTIONS) === 'granted') return true;
    return ask ? await handle.requestPermission(OPTIONS) === 'granted' : false;
}

async function openSubfolder() {
    dir = await root.getDirectoryHandle(SUBFOLDER, { create: true });
    return dir;
}

// ---------------------------------------------------------------- what the page uses

async function probe() {
    try {
        const response = await fetch(ENDPOINT, { cache: 'no-store' });
        if (!response.ok) return null;
        const data = await response.json();
        return data?.ready ? data : null;
    } catch {
        return null;
    }
}

// Picks up where the last session left off. ready is false when Chrome wants the
// permission asked for again, which only the button can do.
export async function restore() {
    const found = await probe();
    if (found) {
        mode = 'server';
        serverFolder = found.folder ?? '';
        return { mode, name: serverFolder, ready: true };
    }
    if (typeof window.showDirectoryPicker !== 'function') {
        mode = null;
        return null;
    }
    mode = 'disk';
    try {
        const handle = await readHandle();
        if (!handle) return null;
        root = handle;
        if (!await allowed(handle)) return { mode, name: handle.name, ready: false };
        await openSubfolder();
        return { mode, name: handle.name, ready: true };
    } catch {
        return null;
    }
}

// Opens the picker. Throws AbortError if the user closes it without choosing.
export async function pick() {
    if (mode === 'server') return { mode, name: serverFolder, ready: true };
    if (typeof window.showDirectoryPicker !== 'function') return null;
    const handle = await window.showDirectoryPicker({ id: 'gblink-pk3', mode: 'readwrite' });
    if (!await allowed(handle, { ask: true })) return null;
    mode = 'disk';
    root = handle;
    await openSubfolder();
    await writeHandle(handle);
    return { mode, name: handle.name, ready: true };
}

// Asks again for a folder this page already has.
export async function resume() {
    if (mode !== 'disk' || !root || !await allowed(root, { ask: true })) return null;
    await openSubfolder();
    return { mode, name: root.name, ready: true };
}

export async function forget() {
    root = null;
    dir = null;
    try { await clearHandle(); } catch {}
}

// Returns the name the file was written under, or null when nothing is set up.
export async function save(pk, name) {
    if (!pk) return null;
    const base = clean(name);

    if (mode === 'server') {
        const response = await fetch(`${ENDPOINT}/${encodeURIComponent(base)}.pk3`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: pk.export(),
        });
        if (!response.ok) {
            const detail = await response.json().catch(() => null);
            throw new Error(detail?.error || `el servidor respondió ${response.status}`);
        }
        const data = await response.json().catch(() => null);
        return data?.file ?? `${base}.pk3`;
    }

    if (mode !== 'disk' || !root) return null;
    if (!dir) await openSubfolder();
    const file = await dir.getFileHandle(await freeName(base), { create: true });
    const writable = await file.createWritable();
    await writable.write(pk.export());
    await writable.close();
    return file.name;
}
