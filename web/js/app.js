// The page: the ESP32 board first, then one of two trees over the device modules. A Game
// Boy Advance linked with the Switch takes the adapter and the play card; the Switch on
// its own takes the trade card. The board's card and the adapter's are each drawn from
// one view of their state: a line of status, perhaps a hint, and at most one thing to
// press. Everything rarely needed sits under a fold.

import { EspDevice, ESP_FILTERS, FAST_BAUD, newer, reopenPort, sleep } from './esp.js';
import { GbLinkSerial, GbLinkUsb, BOOTROM_VENDOR_ID, GBLINK_VENDOR_ID } from './gblink.js';
import { Bridge } from './bridge.js';
import { parseProdKeys } from './keys.js';
import { loadManifest, fetchBytes } from './manifest.js';
import { fromHex, toHex } from './trade/bytes.js';
import { Party, describe as describeMon } from './trade/party.js';
import { parse as parsePk3 } from './trade/pk3.js';
import { spriteUrl, spriteFallbackUrl } from './trade/sprites.js';
import { CancelledError, TradeSession } from './trade/session.js';
import { POOL_SERVER, PoolClient } from './trade/pool.js';
import { readBoxes } from './trade/sav.js';
import * as Pk3Folder from './pk3-folder.js';
import { discordLog } from './discord-log.js';

const $ = (id) => document.getElementById(id);

const CHIP_NAMES = { esp32: 'ESP32', esp32c3: 'ESP32-C3', esp32c6: 'ESP32-C6', esp32s3: 'ESP32-S3' };
// The board's pins for the standalone link, as [its transmit, to the adapter's GP9; its
// receive, from the adapter's GP8].
const LINK_PINS = { esp32: [17, 16], esp32c3: [5, 4], esp32c6: [2, 1], esp32s3: [2, 1] };
// What dev boards print beside those pins, where that is not the GPIO number.
const LINK_PIN_LABELS = { esp32: ['TX2', 'RX2'] };
const KEY_NAMES = {
    kek: 'aes_kek_generation_source',
    gen: 'aes_key_generation_source',
    master00: 'master_key_00',
    master12: 'master_key_12',
};
const POLL_MS = 5000;

const state = {
    manifest: null,
    path: 'switch',         // which tree is on show: gba | switch

    esp: null,
    espPort: null,          // a port that was picked but would not attach
    espPhase: 'idle',       // idle | choosing | connecting | installing | starting
    espProblem: null,       // { code, text, hint } left by the last attempt
    espNote: '',            // what the installer is doing
    espProgress: null,
    askForEsp: false,       // a remembered board let us down: offer the list next time
    keys: null,
    keysNote: null,         // { text, tone } about the last thing done with the keys
    replacingKeys: false,
    session: null,
    polls: 0,
    signal: null,           // the Switch's signal in dBm, from firmware 2.0.2 on
    pollTimer: null,

    adapter: null,
    adapterInfo: null,
    adapterPhase: 'idle',   // idle | choosing | connecting
    adapterProblem: null,
    askForAdapter: false,
    bootDevice: null,       // an adapter that was picked while already in its bootloader
    install: null,          // { step, manual, progress, image } while firmware goes on
    customUf2: null,
    uf2Note: null,

    source: 'party',        // what the trade card offers: pool | party (only party now)
    poolServer: POOL_SERVER,
    poolMon: null,          // what the pool is offering, while connected
    menuOpen: false,
    trading: false,         // both sides have confirmed, and the trade is under way
    kept: [],               // what the Switch gave in swaps the pool did not confirm
    folder: null,           // { name, ready } for the folder traded Pokémon are written to
    folderNote: '',         // what to say about the last save, or the folder itself
    party: new Party(),
    partyNote: '',
    pickerSlot: 0,
    trade: null,            // the session while a trade is running
    tradeStop: null,        // its AbortController
    tradePhase: '',
    tradeTone: '',
    tradeDeclining: false,
    trades: 0,
    offered: -1,            // the slot this page has offered, while connected
    hiddenAt: 0,
    opponent: null,         // { name, party: [six or null] }

    boxes: null,             // all 14 boxes read from a .sav, or null if none loaded
    box: 0,                  // which box is on show
    boxesNote: null,         // { text, tone } about the last .sav read

    resetLoop: false,       // the adapter reports the game resetting it over and over
    bridge: null,
    bridgeTimer: null,
    bridgeNote: null,
    wiringNote: null,
};

// ---------------------------------------------------------------- small helpers

function setLine(id, text, tone = '') {
    const element = $(id);
    element.textContent = text ?? '';
    element.className = `${element.dataset.base ?? element.className.split(' ')[0]} ${tone}`.trim();
}

function setProgress(id, fraction) {
    const element = $(id);
    if (id === 'esp-progress') element.hidden = fraction === null || fraction === undefined;
    element.firstElementChild.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

// Consecutive repeats of a message share one line, with a count.
const logLines = [];
let lastLogged = { key: '', count: 0 };
function log(source, text) {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    const key = `${source}\n${text}`;
    if (key === lastLogged.key && logLines.length) {
        lastLogged.count++;
        logLines[logLines.length - 1] = `${stamp}  ${source.padEnd(7)} ${text}  (×${lastLogged.count})`;
    } else {
        lastLogged = { key, count: 1 };
        const line = `${stamp}  ${source.padEnd(7)} ${text}`;
        logLines.push(line);
        discordLog(line);
        if (logLines.length > 600) logLines.splice(0, logLines.length - 600);
    }
    const view = $('log');
    const pinned = view.scrollTop + view.clientHeight >= view.scrollHeight - 8;
    view.textContent = logLines.join('\n');
    if (pinned) view.scrollTop = view.scrollHeight;
}

function describe(error) {
    return error?.message || String(error);
}

// Runs one of the browser's device choosers. Resolves with null when nothing was picked.
async function choose(request) {
    try {
        return await request();
    } catch (error) {
        if (error?.name !== 'NotFoundError') log('page', `el navegador no mostró su lista de dispositivos: ${describe(error)}`);
        return null;
    }
}

// ---------------------------------------------------------------- ESP32 board: what to show

const ESP_PROBLEMS = {
    'no-firmware': () => ({
        tone: 'warn',
        text: 'Esta placa todavía no tiene el firmware de puente.',
        primary: ['Instalar el firmware', () => onEspInstall()],
        secondary: ['Elegir otro puerto', onEspPickAnother],
    }),
    'download-mode': () => ({
        tone: 'warn',
        text: 'La placa está en su bootloader, lista para el firmware.',
        hint: 'Si ya tiene el firmware, pulsa su botón de reinicio (EN) y vuelve a conectar.',
        primary: ['Instalar el firmware', () => onEspInstall()],
        secondary: ['Conectar de nuevo', onEspConnect],
    }),
    'crash-loop': (problem) => ({
        tone: 'bad',
        text: 'El firmware de esta placa falla al arrancar.',
        hint: problem.hint ? `${problem.hint} (también en el registro de abajo)` : 'Instalarlo de nuevo suele arreglarlo.',
        primary: ['Instalar el firmware de nuevo', () => onEspInstall()],
    }),
    'port-busy': () => ({
        tone: 'bad',
        text: 'Otro programa tiene este puerto abierto.',
        hint: 'Cierra cualquier monitor serie o herramienta de flasheo y vuelve a intentarlo.',
        primary: ['Reintentar', onEspConnect],
        secondary: ['Elegir otro puerto', onEspPickAnother],
    }),
    'port-lost': () => ({
        tone: 'bad',
        text: 'El navegador perdió el puerto al abrirlo.',
        hint: 'Desenchufa la placa y vuelve a enchufarla, y conecta de nuevo. En Linux pasa cuando otro programa serie ha usado el puerto.',
        primary: ['Conectar', onEspConnect],
    }),
    'install-failed': (problem) => ({
        tone: 'bad',
        text: problem.text,
        hint: problem.hint,
        primary: ['Reintentar', () => onEspInstall()],
        secondary: ['Elegir otro puerto', onEspPickAnother],
    }),
    'silent-after-install': () => ({
        tone: 'warn',
        text: 'Instalado, pero la placa todavía no responde.',
        hint: 'Pulsa su botón de reinicio, o desenchúfala y vuelve a enchufarla, y conecta.',
        primary: ['Conectar', onEspConnect],
    }),
    gone: (problem) => ({ tone: problem.tone ?? '', text: problem.text, primary: ['Conectar', onEspConnect] }),
};

function espView() {
    if (state.espPhase === 'choosing') {
        return {
            busy: true,
            text: 'Elige la placa en la lista que muestra el navegador.',
            hint: 'Aparece como “USB JTAG/serial debug unit”, o como “CP2102” o “CH340” en placas con un chip USB aparte.',
        };
    }
    if (state.espPhase === 'connecting') return { busy: true, text: 'Buscando el firmware de puente…' };
    if (state.espPhase === 'installing') return { busy: true, text: state.espNote, progress: state.espProgress };
    if (state.espPhase === 'starting') return { busy: true, text: 'Instalado. Esperando a que arranque la placa…' };

    const esp = state.esp;
    if (state.espProblem) {
        const view = (ESP_PROBLEMS[state.espProblem.code] ?? ESP_PROBLEMS.gone)(state.espProblem);
        return { ...view, connected: Boolean(esp) };
    }
    if (!esp) return { text: 'Conecta la placa a este ordenador con un cable USB de datos.', primary: ['Conectar', onEspConnect] };
    const name = CHIP_NAMES[esp.info?.chip] ?? esp.info?.chip ?? 'board';
    if (!esp.attached) {
        return { busy: true, connected: true, done: Boolean(state.keys?.complete), text: `${name} · reiniciándose, como hace tras cada sesión…` };
    }
    const bundled = state.manifest?.bridge.version;
    if (!esp.info || (bundled && newer(bundled, esp.info.version))) {
        return {
            connected: true,
            tone: 'warn',
            text: esp.info ? `El firmware ${esp.info.version} está instalado; hay ${bundled} disponible.` : 'El firmware de esta placa es más antiguo de lo que espera esta página.',
            primary: ['Actualizar el firmware', () => onEspInstall()],
        };
    }
    if (!state.keys?.complete || state.replacingKeys) {
        return {
            connected: true,
            tone: state.keys?.complete ? '' : 'warn',
            dot: state.keys?.complete ? 'good' : 'warn',
            text: state.keys?.complete ? `${name} conectada. Suelta un prod.keys para reemplazar las claves guardadas.` : `${name} conectada. Todavía necesita las claves de tu consola.`,
            keys: true,
        };
    }
    return { connected: true, done: true, tone: 'good', text: `${name} · firmware ${esp.info.version} · claves guardadas` };
}

// ---------------------------------------------------------------- ESP32 board: doing things

async function onEspConnect() {
    if (state.espPhase !== 'idle' || state.esp) return;
    let port = (await livePort(state.espPort)) ?? (await rememberedEspPort());
    if (!port) {
        state.espPhase = 'choosing';
        render();
        port = await choose(() => EspDevice.requestPort());
        state.espPhase = 'idle';
    }
    if (port) await attachEsp(port);
    else render();
}

async function onEspPickAnother() {
    if (state.espPhase !== 'idle') return;
    state.askForEsp = true;
    state.espPort = null;
    state.espProblem = null;
    await onEspConnect();
}

// A chip with USB of its own comes back from every reset as a new port object under the
// same permission, which leaves the object the page was holding dead.
async function livePort(port) {
    if (!port) return null;
    let ports = [];
    try { ports = await navigator.serial.getPorts(); } catch {}
    if (ports.includes(port)) return port;
    const was = port.getInfo();
    const same = ports.filter((other) => other.getInfo().usbVendorId === was.usbVendorId && other.getInfo().usbProductId === was.usbProductId);
    return same.length === 1 ? same[0] : null;
}

// A board this page was given access to before is used without asking again, as long as
// there is no doubt which one that is.
async function rememberedEspPort() {
    if (state.askForEsp) return null;
    let ports = [];
    try { ports = await navigator.serial.getPorts(); } catch {}
    ports = ports.filter((port) => ESP_FILTERS.some((filter) => filter.usbVendorId === port.getInfo().usbVendorId));
    return ports.length === 1 ? ports[0] : null;
}

async function attachEsp(port) {
    state.espPhase = 'connecting';
    state.espProblem = null;
    render();
    const device = new EspDevice();
    try {
        await device.open(port);
    } catch (error) {
        await device.close();
        state.espPort = error.code === 'port-lost' ? null : port;
        state.espProblem = { code: error.code ?? 'no-firmware', text: describe(error), hint: error.detail };
        if (error.code === 'crash-loop') log('board', `falla al arrancar: ${error.detail || 'sin detalles'}`);
        state.espPhase = 'idle';
        render();
        return;
    }
    state.askForEsp = false;
    state.espPhase = 'idle';
    await adoptEsp(device);
}

async function adoptEsp(device) {
    state.esp = device;
    state.espPort = null;
    state.espProblem = null;
    device.addEventListener('log', (event) => onEspLine(event.detail));
    device.addEventListener('restarted', () => {
        if (state.esp !== device) return;
        log('board', 'restarted');
        lastRoomLine = '';
        state.session = null;
        render();
    });
    device.addEventListener('reattached', () => { if (state.esp === device) refreshEsp(); });
    device.addEventListener('failed', (event) => { if (state.esp === device) dropEsp({ code: 'gone', tone: 'bad', text: `La placa dejó de responder (${describe(event.detail)}).` }); });
    device.addEventListener('disconnected', () => { if (state.esp === device) dropEsp({ code: 'gone', tone: 'warn', text: 'Han desenchufado la placa.' }); });
    await refreshEsp();
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollSession, POLL_MS);
}

async function refreshEsp() {
    const esp = state.esp;
    if (!esp) return;
    const info = esp.info;
    const bundled = state.manifest?.bridge.version;
    $('esp-chip').textContent = CHIP_NAMES[info?.chip] ?? info?.chip ?? 'Desconocido';
    $('esp-version').textContent = !info ? 'Anterior a 2.0' : bundled && newer(bundled, info.version) ? `${info.version} (hay ${bundled})` : info.version;
    $('esp-transport').textContent = info ? (info.transport === 'UART' ? `UART, ${esp.baudRate} baud` : info.transport) : '–';
    try {
        // Left over from a page that was closed while it carried the link.
        if (!state.bridge && (await esp.adapterPort()) === 'host') await esp.setAdapterPort('uart');
        await refreshKeys();
    } catch (error) {
        log('page', describe(error));
    }
    render();
    pollSoon();
}

async function dropEsp(problem = null) {
    const device = state.esp;
    if (state.bridge) await stopBridge('La placa ESP32 ha desaparecido.');
    clearInterval(state.pollTimer);
    state.esp = null;
    state.keys = null;
    state.keysNote = null;
    state.replacingKeys = false;
    state.session = null;
    state.espProblem = problem;
    await device?.close();
    render();
}

// The board repeats what it hears while it scans: the raw advertisement four times a
// second, and the room it decodes from it. The log keeps the room, once per change.
let lastRoomLine = '';
function onEspLine(line) {
    if (line.startsWith('LDN_HELLO') || line.startsWith('LDN_ADV ')) return;
    if (line.startsWith('LDN_ROOM ')) {
        if (line === lastRoomLine) return;
        lastRoomLine = line;
    }
    log('board', line);
    if (line === 'LDN_BRIDGE no keys') refreshKeys();
    if (line.startsWith('LDN_BRIDGE ')) pollSoon();
}

let pollSoonTimer = null;
function pollSoon() {
    clearTimeout(pollSoonTimer);
    pollSoonTimer = setTimeout(pollSession, 400);
}

async function onEspInstall(eraseAll = false) {
    if (state.espPhase !== 'idle') return;
    if (!state.manifest) {
        state.espProblem = { code: 'install-failed', text: 'No se pudo cargar el firmware incluido con esta página.' };
        render();
        return;
    }
    let port = state.esp?.port ?? (await livePort(state.espPort)) ?? (await rememberedEspPort());
    if (!port) {
        state.espPhase = 'choosing';
        render();
        port = await choose(() => EspDevice.requestPort());
        state.espPhase = 'idle';
        if (!port) { render(); return; }
    }
    $('esp-more').open = false;
    state.espPhase = 'installing';
    state.espNote = 'Preparando…';
    state.espProgress = 0;
    render();
    try {
        if (state.esp) await dropEsp();
        state.espProblem = null;
        const { flashBridge } = await import('./flash-esp.js');
        const done = await flashBridge(port, state.manifest, {
            eraseAll,
            onStatus: (text) => { state.espNote = text; render(); },
            onProgress: (fraction) => { state.espProgress = fraction; setProgress('esp-progress', fraction); },
            onLog: (text) => log('flasher', text),
        });
        log('page', `firmware ${done.version} instalado en el ${done.chip}`);
        state.espPhase = 'starting';
        state.espProgress = null;
        render();
        let device = null;
        try { device = await reopenPort(port); } catch (error) { log('page', describe(error)); }
        state.espPhase = 'idle';
        if (device) await adoptEsp(device);
        else {
            state.espPort = port;
            state.espProblem = { code: 'silent-after-install' };
            render();
        }
    } catch (error) {
        log('flasher', describe(error));
        state.espPort = port;
        state.espPhase = 'idle';
        state.espProgress = null;
        state.espProblem = { code: 'install-failed', ...installAdvice(error) };
        render();
    }
}

function installAdvice(error) {
    const text = describe(error);
    if (/device has been lost/i.test(text)) {
        return { text: 'El navegador perdió el puerto al abrirlo.', hint: 'Desenchufa la placa y vuelve a enchufarla, y reinténtalo.' };
    }
    if (/failed to connect|timed? ?out|no serial data|invalid head/i.test(text)) {
        return { text: 'El chip no entró en su bootloader.', hint: 'Mantén pulsado BOOT, pulsa y suelta RESET (o enchufa la placa con BOOT pulsado) y reinténtalo.' };
    }
    if (/failed to open|already open/i.test(text)) return { text: 'Otro programa tiene este puerto abierto.', hint: 'Ciérralo y reinténtalo.' };
    return { text: 'La instalación falló.', hint: text };
}

// Two clicks rather than a dialog: the first arms the button for a few seconds.
const armed = new Map();   // button -> { label, timer }
function twice(button, warning, action) {
    if (!armed.has(button)) {
        armed.set(button, { label: button.textContent, timer: setTimeout(() => disarm(button), 6000) });
        button.textContent = warning;
        return;
    }
    disarm(button);
    action();
}

function disarm(button) {
    const pending = armed.get(button);
    if (!pending) return;
    clearTimeout(pending.timer);
    armed.delete(button);
    button.textContent = pending.label;
}

// ---------------------------------------------------------------- keys

async function refreshKeys() {
    const esp = state.esp;
    if (!esp?.attached) return;
    state.keys = await esp.keyStatus();
    render();
}

async function onKeysFile(file) {
    const esp = state.esp;
    if (!file || !esp?.attached) return;
    const note = (text, tone) => { state.keysNote = { text, tone }; render(); };
    if (file.size > 1024 * 1024) { note('Ese archivo es demasiado grande para ser un prod.keys.', 'bad'); return; }
    const parsed = parseProdKeys(await file.text());
    if (parsed.missing.length || parsed.malformed.length) {
        const problems = [];
        if (parsed.missing.length) problems.push(`no están en el archivo: ${parsed.missing.join(', ')}`);
        if (parsed.malformed.length) problems.push(`no son 32 dígitos hex: ${parsed.malformed.join(', ')}`);
        note(`Ese archivo no sirve (${problems.join('; ')}).`, 'bad');
        return;
    }
    note('Guardando las claves en la placa…');
    try {
        const rejected = await esp.storeKeys(parsed.keys);
        if (rejected.length) { note(`La placa no aceptó: ${rejected.join(', ')}.`, 'bad'); return; }
        state.replacingKeys = false;
        state.keysNote = null;
        await refreshKeys();
        if (state.keys?.complete) {
            await esp.startBridge();
            log('page', 'claves guardadas; la placa busca una sala');
            pollSoon();
        }
    } catch (error) {
        note(`No se pudieron guardar las claves (${describe(error)}).`, 'bad');
    }
}

async function onKeysErase() {
    const esp = state.esp;
    if (!esp?.attached) return;
    try {
        await esp.eraseKeys();
        log('page', 'claves borradas de la placa');
        await refreshKeys();
    } catch (error) {
        state.keysNote = { text: describe(error), tone: 'bad' };
        render();
    }
}

function keysLine() {
    if (state.keysNote) return state.keysNote;
    const keys = state.keys;
    if (!keys || keys.complete) return { text: '' };
    const missing = Object.entries(KEY_NAMES).filter(([flag]) => !keys[flag]).map(([, name]) => name);
    return missing.length && missing.length < 4 ? { text: `Todavía faltan: ${missing.join(', ')}.`, tone: 'warn' } : { text: '' };
}

// ---------------------------------------------------------------- session status

async function pollSession() {
    const esp = state.esp;
    if (!esp?.attached || state.espPhase !== 'idle' || state.trade) return;
    try {
        state.session = await esp.bridgeStatus();
        if (state.polls++ % 3 === 0) state.signal = await esp.signal();
        $('esp-signal').textContent = roomWord(esp, state.session, state.signal);
    } catch {
        return;   // restarting; the next poll will do
    }
    renderSession();
}

// The board joins a room as soon as it reads one and stops reporting advertisements
// while it is in, so the bridge's state comes first; while it scans, its reports say
// whether a room is heard at all, and whether the keys can read it.
function roomWord(esp, status, signal) {
    const dbm = signal === null || signal === undefined ? '' : `, ${signal} dBm`;
    if (status && status.state === 'run') return `joined${dbm}`;
    if (status && status.state !== 'scan' && status.state !== 'stopped' && status.state !== 'idle') return `joining${dbm}`;
    const now = Date.now();
    if (now - esp.readAt < 10000) return `oída y leída${dbm}`;
    if (now - esp.heardAt < 5000) return `oída, pero las claves no la leen${dbm}`;
    return 'no se oye';
}

function renderSession() {
    if (!gbaTree()) return;   // the play card is not on this page
    const status = state.session;
    const box = $('session');
    box.hidden = !state.esp;
    if (!state.esp) { $('play-dot').className = 'dot'; return; }
    let headline = 'Esperando a la placa…';
    let hint = '';
    let tone = '';
    if (state.resetLoop && state.adapter) {
        headline = 'El juego reinicia el adaptador inalámbrico sin parar.';
        hint = 'En la GBA esto parece un cuelgue. Normalmente es el cable de enlace: tiene que ser uno de Game Boy Color, no de Game Boy Advance, y el adaptador necesita el firmware del paso 2.';
        tone = 'warn';
    } else if (state.keys && !state.keys.complete) {
        headline = 'La placa necesita sus claves.';
        hint = 'Sin ellas no puede leer la red inalámbrica de la Switch. Añade tu prod.keys en el paso 1.';
        tone = 'warn';
    } else if (status) {
        const running = status.state === 'run';
        if (status.state === 'stopped' || status.state === 'idle') {
            headline = 'El puente está detenido.';
            hint = 'Desenchufa la placa y vuelve a enchufarla.';
            tone = 'warn';
        } else if (status.state === 'scan' && state.esp.hearsUnreadableRoom) {
            headline = 'La placa oye una sala de la Switch pero no puede leerla.';
            hint = 'Las claves que tiene no coinciden. Reemplázalas en el paso 1 con un prod.keys de tu propia Switch.';
            tone = 'warn';
        } else if (status.state === 'scan') {
            headline = 'Buscando una sala de Rojo Fuego o Verde Hoja…';
            hint = 'En la Switch, abre el Centro de Intercambio o el Coliseo como líder del grupo.';
        } else if (!running) {
            headline = 'Uniéndose a la sala de la Switch…';
        } else if (status.child === '1') {
            headline = 'La Game Boy Advance y la Switch están enlazadas.';
            hint = 'Salid de la sala en las dos consolas al terminar; la placa se prepara entonces para la siguiente.';
            tone = 'good';
        } else if (status.conn_state === '2') {
            headline = 'En la sala de la Switch. Esperando a la Game Boy Advance.';
            hint = 'En la GBA, elige la misma actividad y únete al grupo.';
            tone = 'good';
        } else {
            headline = 'En la sala de la Switch, preparando la sesión…';
        }
    }
    $('session-headline').textContent = headline;
    $('session-hint').textContent = hint;
    box.className = `session ${tone}`.trim();
    $('play-dot').className = `dot ${tone === 'good' ? 'good' : tone === 'warn' ? 'warn' : 'busy'}`;
}

// ---------------------------------------------------------------- adapter: what to show

const ADAPTER_PROBLEMS = {
    denied: () => ({
        tone: 'bad',
        text: 'El navegador no obtuvo acceso al adaptador.',
        hint: 'Cierra otras páginas o programas que lo usen. En Linux además necesita una regla udev; conectando por serie, en Más opciones, funciona sin ella.',
        primary: ['Reintentar', () => onAdapterConnect()],
    }),
    'port-lost': () => ({
        tone: 'bad',
        text: 'El navegador perdió el puerto al abrirlo.',
        hint: 'Desenchufa el adaptador y vuelve a enchufarlo, y conecta de nuevo.',
        primary: ['Conectar', () => onAdapterConnect()],
    }),
    'install-failed': (problem) => ({
        tone: 'bad',
        text: 'La instalación falló.',
        hint: problem.hint,
        primary: ['Reintentar', onAdapterInstall],
    }),
    'no-webusb': () => ({
        tone: 'warn',
        text: 'Este navegador no puede llegar al bootloader del adaptador.',
        hint: 'Usa Chrome o Edge, o instálalo a mano como se explica en Más opciones.',
    }),
    cancelled: () => ({
        text: 'Cancelled.',
        hint: 'Si el adaptador sigue en modo de actualización, desenchúfalo y vuelve a enchufarlo para usarlo como antes.',
        primary: ['Conectar', () => onAdapterConnect()],
    }),
    gone: (problem) => ({ tone: problem.tone ?? '', text: problem.text, hint: problem.hint, primary: ['Conectar', () => onAdapterConnect()] }),
};

function adapterView() {
    if (state.install) {
        const waiting = state.install.step === 'restart' || state.install.step === 'choose';
        return { busy: true, steps: true, text: 'Instalando el firmware…', secondary: waiting ? ['Cancelar', cancelAdapterInstall] : null };
    }
    if (state.adapterPhase === 'choosing') {
        return { busy: true, text: 'Elige el adaptador en la lista que muestra el navegador.', hint: 'Aparece como “GBLink USB”.' };
    }
    if (state.adapterPhase === 'connecting') return { busy: true, text: 'Connecting…' };

    const adapter = state.adapter;
    if (state.adapterProblem) {
        const view = (ADAPTER_PROBLEMS[state.adapterProblem.code] ?? ADAPTER_PROBLEMS.gone)(state.adapterProblem);
        return { ...view, connected: Boolean(adapter) };
    }
    if (state.bootDevice) {
        return { tone: 'warn', text: 'El adaptador está en modo de actualización, listo para el firmware.', primary: [installLabel(), onAdapterInstall] };
    }
    if (!adapter) return { text: 'Conecta el adaptador a este ordenador.', primary: ['Conectar', () => onAdapterConnect()] };
    const info = state.adapterInfo;
    const bundled = state.manifest?.adapter.version;
    if (!info?.wireless) {
        return { connected: true, tone: 'warn', text: 'El firmware de este adaptador todavía no tiene el modo adaptador inalámbrico.', primary: [installLabel(), onAdapterInstall] };
    }
    if (bundled && info.version && newer(bundled, info.version)) {
        return { connected: true, tone: 'warn', text: `El firmware ${info.version} está instalado; hay ${bundled} disponible.`, primary: ['Actualizar el firmware', onAdapterInstall] };
    }
    if (state.customUf2) {
        return { connected: true, text: `${state.customUf2.name} está listo para instalar.`, primary: [installLabel(), onAdapterInstall] };
    }
    return { connected: true, done: true, tone: 'good', text: `GB-Link · firmware ${info.version ?? 'desconocido'} · modo adaptador inalámbrico` };
}

function installLabel() {
    return state.customUf2 ? `Instalar ${state.customUf2.name}` : 'Instalar el firmware';
}

// ---------------------------------------------------------------- adapter: doing things

async function onAdapterConnect(kind = GbLinkUsb.available() ? 'usb' : 'serial') {
    if (state.adapterPhase !== 'idle' || state.adapter || state.install) return;
    state.adapterProblem = null;
    if (kind === 'usb') {
        let device = await rememberedAdapter();
        if (!device) {
            state.adapterPhase = 'choosing';
            render();
            device = await choose(() => GbLinkUsb.requestDevice());
            state.adapterPhase = 'idle';
        }
        if (!device) { render(); return; }
        if (device.vendorId === BOOTROM_VENDOR_ID) {
            state.bootDevice = device;
            render();
            return;
        }
        await openAdapter(new GbLinkUsb(), device);
    } else {
        state.adapterPhase = 'choosing';
        render();
        const port = await choose(() => GbLinkSerial.requestPort());
        state.adapterPhase = 'idle';
        if (port) await openAdapter(new GbLinkSerial(), port);
        else render();
    }
}

async function rememberedAdapter() {
    if (state.askForAdapter) return null;
    let devices = [];
    try { devices = await navigator.usb.getDevices(); } catch {}
    devices = devices.filter((device) => device.vendorId === GBLINK_VENDOR_ID);
    return devices.length === 1 ? devices[0] : null;
}

async function openAdapter(adapter, handle) {
    state.adapterPhase = 'connecting';
    state.bootDevice = null;
    render();
    try {
        await adapter.open(handle);
        const info = await adapter.identify();
        state.adapter = adapter;
        state.adapterInfo = info;
        state.askForAdapter = false;
        state.adapterProblem = null;
        adapter.addEventListener('disconnected', () => { if (state.adapter === adapter) dropAdapter({ code: 'gone', tone: 'warn', text: 'Han desenchufado el adaptador.' }); });
        adapter.addEventListener('resetloop', (event) => { if (state.adapter === adapter) onResetLoop(event.detail); });
        $('adapter-version').textContent = info.version ?? 'Desconocido';
        $('adapter-wireless').textContent = info.wireless ? 'Sí' : 'No';
        $('adapter-kind').textContent = adapter.kind === 'usb' ? 'WebUSB' : 'Serial';
    } catch (error) {
        await adapter.close();
        state.askForAdapter = true;
        const denied = error?.name === 'SecurityError' || /access denied/i.test(describe(error));
        state.adapterProblem = denied ? { code: 'denied' }
            : error.code === 'port-lost' ? { code: 'port-lost' }
            : { code: 'gone', tone: 'bad', text: 'No se pudo abrir el adaptador.', hint: describe(error) };
    } finally {
        state.adapterPhase = 'idle';
        render();
    }
}

// The adapter noticed the game resetting it over and over. Shown where the player is
// looking, because from the GBA's side it is a freeze with no message.
function onResetLoop({ looping, startedUp }) {
    state.resetLoop = looping;
    if (looping) log('adapter', `el juego reinicia el adaptador inalámbrico sin parar (${startedUp ? 'sus órdenes no llegan' : 'no se reconoce el adaptador'})`);
    renderSession();
}

async function dropAdapter(problem = null) {
    const adapter = state.adapter;
    if (state.bridge) await stopBridge('El adaptador ha desaparecido.');
    state.adapter = null;
    state.adapterInfo = null;
    state.bootDevice = null;
    state.resetLoop = false;
    state.adapterProblem = problem;
    await adapter?.close();
    render();
}

async function adapterImage() {
    if (state.customUf2) return state.customUf2.image;
    const { parseUf2 } = await import('./flash-pico.js');
    return parseUf2(await fetchBytes(state.manifest.base + state.manifest.adapter.path));
}

// Firmware goes on through the adapter's USB bootloader, which is a different USB device
// from the running adapter: the browser has to be given access a second time. The steps
// on the card walk through that.
async function onAdapterInstall() {
    if (state.install || state.adapterPhase !== 'idle') return;
    if (!GbLinkUsb.available()) {
        $('adapter-more').open = true;
        state.adapterProblem = { code: 'no-webusb' };
        render();
        return;
    }
    state.adapterProblem = null;
    $('adapter-more').open = false;
    let image;
    try {
        if (!state.manifest && !state.customUf2) throw new Error('no se pudo cargar el firmware incluido con esta página');
        image = await adapterImage();
    } catch (error) {
        state.adapterProblem = { code: 'install-failed', hint: describe(error) };
        render();
        return;
    }
    if (state.bootDevice) {
        const { bootloaderFrom } = await import('./flash-pico.js');
        state.install = { step: 'write', manual: false, image };
        await flashBootloader(bootloaderFrom(state.bootDevice));
        return;
    }
    const adapter = state.adapter;
    const install = (state.install = { step: 'restart', manual: !adapter, image });
    render();
    if (!adapter) return;
    if (state.bridge) await stopBridge();
    // Let go of it first: it drops off the bus as it restarts, which is not an unplugging.
    state.adapter = null;
    state.adapterInfo = null;
    try {
        await adapter.rebootToBootloader();
        await sleep(200);
    } catch (error) {
        log('page', `el adaptador no se reinició: ${describe(error)}`);
        install.manual = true;
    }
    await adapter.close();
    if (state.install === install && !install.started) install.step = install.manual ? 'restart' : 'choose';
    render();
}

function cancelAdapterInstall() {
    const install = state.install;
    if (!install || install.started) return;
    state.install = null;
    state.adapterProblem = install.manual ? null : { code: 'cancelled' };
    render();
}

// A bootloader this page already has permission for announces itself; otherwise the
// button opens the chooser.
async function onUsbConnect(event) {
    const install = state.install;
    if (event.device?.vendorId !== BOOTROM_VENDOR_ID || !install || install.started) return;
    const { bootloaderFrom } = await import('./flash-pico.js');
    let picoboot;
    try { picoboot = bootloaderFrom(event.device); } catch { return; }
    await flashBootloader(picoboot);
}

async function onAdapterSelect() {
    const install = state.install;
    if (!install || install.started) return;
    const { chooseBootloader } = await import('./flash-pico.js');
    let picoboot;
    try {
        picoboot = await chooseBootloader();
    } catch (error) {
        if (error?.name !== 'NotFoundError') log('page', describe(error));
        return;
    }
    await flashBootloader(picoboot);
}

async function flashBootloader(picoboot) {
    const install = state.install;
    if (!install || install.started) return;
    install.started = true;
    install.step = 'write';
    render();
    try {
        const { flashAdapter } = await import('./flash-pico.js');
        await flashAdapter(picoboot, install.image, {
            onStatus: (text) => log('flasher', text),
            onProgress: (fraction) => setProgress('adapter-progress', fraction),
        });
        log('page', `firmware del adaptador instalado: ${state.customUf2?.name ?? `incluido ${state.manifest?.adapter.version ?? ''}`.trim()}`);
        state.bootDevice = null;
        state.customUf2 = null;
        $('adapter-file').value = '';
        install.step = 'reconnect';
        render();
        await reconnectAdapter();
    } catch (error) {
        log('page', `la instalación del adaptador falló: ${describe(error)}`);
        state.install = null;
        state.adapterProblem = { code: 'install-failed', hint: describe(error) };
        render();
    }
}

// The running firmware is a different USB device from the bootloader; permission for it
// exists if it was connected here before.
async function reconnectAdapter() {
    for (let attempt = 0; attempt < 8; attempt++) {
        await sleep(700);
        let devices = [];
        try { devices = await navigator.usb.getDevices(); } catch {}
        const device = devices.find((candidate) => candidate.vendorId === GBLINK_VENDOR_ID);
        let ports = [];
        try { ports = (await navigator.serial?.getPorts()) ?? []; } catch {}
        const port = ports.find((candidate) => candidate.getInfo().usbVendorId === GBLINK_VENDOR_ID);
        if (device || (port && attempt >= 3)) {
            await openAdapter(device ? new GbLinkUsb() : new GbLinkSerial(), device ?? port);
            state.install = null;
            render();
            return;
        }
    }
    state.install = null;
    state.adapterProblem = { code: 'gone', tone: 'good', text: 'Instalado. Conecta el adaptador para continuar.' };
    render();
}

async function onAdapterFile(file) {
    if (!file) return;
    try {
        const { parseUf2 } = await import('./flash-pico.js');
        state.customUf2 = { name: file.name, image: parseUf2(new Uint8Array(await file.arrayBuffer())) };
        state.adapterProblem = null;
        $('adapter-more').open = false;
        state.uf2Note = null;
    } catch (error) {
        state.customUf2 = null;
        $('adapter-file').value = '';
        state.uf2Note = `Ese no es un archivo .uf2 utilizable (${describe(error)}).`;
    }
    render();
}

// ---------------------------------------------------------------- play

function bridgeBlocker() {
    if (state.trade) return 'Esta página está intercambiando con la propia Switch. Desconecta allí primero.';
    if (!state.esp?.attached) return 'Conecta la placa ESP32 del paso 1.';
    if (!state.adapter) return 'Conecta el adaptador del paso 2.';
    if (state.esp.info?.transport === 'UART' && state.esp.baudRate < FAST_BAUD) return 'El firmware de esta placa usa su consola a 115200 baudios, que no puede con el enlace. Actualízalo en el paso 1.';
    if (!state.adapterInfo?.wireless) return 'El adaptador necesita el firmware del paso 2.';
    if (!state.keys?.complete) return 'La placa necesita sus claves del paso 1.';
    return null;
}

async function onBridgeStart() {
    if (state.bridge || bridgeBlocker()) return;
    const bridge = new Bridge(state.esp, state.adapter);
    bridge.addEventListener('failed', (event) => stopBridge(`Detenido: ${describe(event.detail)}`, 'bad'));
    state.bridgeNote = null;
    setLine('bridge-status', 'Arrancando…');
    try {
        await bridge.start();
    } catch (error) {
        state.bridgeNote = { text: describe(error), tone: 'bad' };
        render();
        return;
    }
    state.bridge = bridge;
    state.bridgeTimer = setInterval(renderBridge, 1000);
    log('page', 'transportando el enlace entre las placas');
    render();
    renderBridge();
    pollSoon();
}

async function stopBridge(message = null, tone = '') {
    const bridge = state.bridge;
    if (!bridge) return;
    state.bridge = null;
    clearInterval(state.bridgeTimer);
    await bridge.stop();
    state.bridgeNote = message ? { text: message, tone } : null;
    log('page', 'ya no transporta el enlace');
    render();
}

function renderBridge() {
    const stats = state.bridge?.stats;
    if (!stats) return;
    $('bridge-out').textContent = `${stats.toAdapterFrames.toLocaleString()} ${stats.toAdapterFrames === 1 ? 'fotograma' : 'fotogramas'}`;
    $('bridge-in').textContent = `${(stats.fromAdapterBytes / 1024).toFixed(1)} KB`;
    $('bridge-sessions').textContent = String(stats.reattached);
}

// The adapter answers whichever side spoke to it last. One that is also connected to
// this page has been answering over USB, so a silent first listen is followed by asking
// the board to speak on the wires again, which is left alone while a GBA is linked.
async function onWiringCheck() {
    const esp = state.esp;
    if (!esp?.attached || state.bridge) return;
    const note = (text, tone) => { state.wiringNote = { text, tone }; render(); };
    note('Escuchando en los cables…');
    const frames = async () => {
        const lines = await esp.command('LDN_PICO_STATS');
        const match = lines.join(' ').match(/rx_frames=(\d+)/);
        return match ? Number(match[1]) : null;
    };
    const heard = async (milliseconds) => {
        const before = await frames();
        await sleep(milliseconds);
        const after = await frames();
        return before === null || after === null ? null : after > before;
    };
    try {
        let result = await heard(2000);
        if (result === false && state.session?.child !== '1') {
            await esp.command('LDN_PICO_MODE');
            result = await heard(1500);
        }
        if (result === null) note('La placa no informó de su enlace.', 'warn');
        else if (result) note('La placa oye el adaptador por los cables.', 'good');
        else note('No llega nada del adaptador. Puede que los dos cables de enlace estén al revés: cámbialos y vuelve a comprobar. Si no, revisa la masa, y que el adaptador tenga corriente y el firmware del paso 2.', 'bad');
    } catch (error) {
        note(describe(error), 'bad');
    }
}

// ---------------------------------------------------------------- which tree is on show

// This build of the page leaves the Game Boy Advance tree out: no adapter card and no
// play card, so the board is only ever used to trade with the Switch from here. The code
// that drives the adapter and the play card is still in this file and is skipped rather
// than removed, so it comes back on its own if those two cards are put back into
// index.html. gbaTree() is what everything below asks before touching their elements.
const PATHS = ['switch'];
const PATH_STORE = 'gblink-switch-path';

const gbaTree = () => Boolean($('adapter-card'));

function remembered(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function remember(key, value) {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {}
}

function pathBusy() {
    return Boolean(state.bridge || state.trade);
}

function choosePath(path, { keep = true } = {}) {
    if (!PATHS.includes(path) || (path !== state.path && pathBusy())) return;
    state.path = path;
    if (keep) {
        remember(PATH_STORE, path);
        history.replaceState(null, '', `${location.pathname}${location.search}#${path}`);
    }
    render();
}

function renderPaths() {
    for (const tab of $('paths').children) {
        const chosen = tab.dataset.path === state.path;
        tab.setAttribute('aria-selected', String(chosen));
        tab.disabled = !chosen && pathBusy();
        tab.title = tab.disabled ? (state.trade ? 'Desconecta de la Switch primero.' : 'Deja de transportar el enlace primero.') : '';
    }
    for (const card of document.querySelectorAll('main > [data-path]')) card.hidden = card.dataset.path !== state.path;
}

// ---------------------------------------------------------------- trading from here

const SOURCE_STORE = 'gblink-switch-source';
const SERVER_STORE = 'gblink-switch-pool-server';
const KEPT_STORE = 'gblink-switch-kept';
// The trade card offers one thing only: the player's own party, filled from a save file.
// The pool is still in this file and comes back on its own if its button and its notes
// are put back into index.html.
const SOURCES = ['party'];

const pooling = () => state.source === 'pool';

// The board does the wireless; this card only needs it ready and something to trade.
function tradeBlocker() {
    if (!state.esp) return 'Conecta primero la placa ESP32 del paso 1.';
    if (!state.esp.info) return 'Instala primero el firmware del paso 1.';
    if (!state.keys?.complete) return 'La placa necesita sus claves antes de poder leer la red inalámbrica de la Switch.';
    if (state.bridge) return 'Esta página está transportando el enlace de una Game Boy Advance. Detenlo primero.';
    if (pooling()) return poolServer() ? null : 'La dirección del servidor de la bolsa tiene que empezar por wss:// o ws://.';
    if (!state.party.canTrade) return 'Hacen falta dos Pokémon: uno para ofrecer y otro para quedarte.';
    return null;
}

function poolServer() {
    const address = state.poolServer.trim();
    return /^wss?:\/\/\S+$/.test(address) ? address : null;
}

// tools: [act, glyph, what it does to this Pokémon] for the buttons beside each one.
function drawSlots(id, mons, { pick = false, marked = -1, mark = 'chosen', tools = [], empty = '–', drag = false } = {}) {
    const box = $(id);
    box.replaceChildren();
    mons.forEach((pk, index) => {
        const slot = document.createElement('div');
        slot.className = `slot${pick ? '' : ' theirs'}${pk ? '' : ' empty'}`;
        slot.dataset.slot = String(index);
        if (index === marked) slot.classList.add(mark);
        if (drag && pk) {
            slot.draggable = true;
            slot.addEventListener('dragstart', (event) => {
                event.dataTransfer.setData('application/x-pk3-hex', toHex(pk.export()));
                event.dataTransfer.effectAllowed = 'copy';
            });
        }
        const face = document.createElement(pick ? 'button' : 'div');
        face.className = 'slot-pick';
        if (pick) { face.type = 'button'; face.dataset.act = 'pick'; }
        if (pk) {
            const about = describeMon(pk);
            const image = document.createElement('img');
            image.alt = about.kind;
            image.loading = 'lazy';
            image.src = spriteUrl(pk) ?? '';
            image.addEventListener('error', () => {
                const fallback = spriteFallbackUrl(pk);
                if (fallback && image.src !== fallback) image.src = fallback;
                else image.replaceWith(Object.assign(document.createElement('div'), { className: 'empty-art' }));
            }, { once: true });
            const who = document.createElement('div');
            who.className = 'who';
            who.append(text('div', 'name', about.name));
            const line = text('div', 'about', `${about.kind}${about.level ? ` · ${about.level}` : ''}${about.gender ? ` ${about.gender}` : ''}`);
            if (about.shiny) line.append(text('span', 'shiny', ' ★'));
            who.append(line);
            face.append(image, who);
        } else {
            face.append(text('div', 'empty-art', ''), text('div', 'name', empty));
        }
        slot.append(face);
        if (pk && tools.length) slot.append(slotTools(tools, describeMon(pk).name));
        box.append(slot);
    });
}

// Saving and replacing sit on the Pokémon itself, so neither changes what is on offer.
function slotTools(tools, name) {
    const box = document.createElement('div');
    box.className = 'slot-tools';
    for (const [act, glyph, what, disabled] of tools) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tool';
        button.dataset.act = act;
        button.textContent = glyph;
        button.disabled = Boolean(disabled);
        button.title = disabled || what.replace('%', name);
        button.setAttribute('aria-label', what.replace('%', name));
        box.append(button);
    }
    return box;
}

function text(tag, className, content) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = content;
    return node;
}

function renderTrade() {
    const running = Boolean(state.trade);
    const blocker = tradeBlocker();
    for (const button of $('trade-source').children) {
        button.setAttribute('aria-pressed', String(button.dataset.source === state.source));
        button.disabled = running;
    }
    $('source-note-party').hidden = false;

    drawSlots('their-slots', state.opponent?.party ?? [null, null, null, null, null, null]);
    $('their-name').textContent = state.opponent?.name ?? 'La Switch';
    // The party is what the Switch was shown, so it changes only between visits.
    const locked = running ? 'Desconecta para poner aquí otro Pokémon.' : '';
    drawSlots('our-slots', state.party.slots, {
        pick: true, empty: 'Vacío',
        marked: state.party.selected, mark: running && state.offered === state.party.selected ? 'offered' : 'chosen',
        tools: [['save', '↓', 'Guardar % como archivo .pk3'], ['swap', '↑', 'Reemplazar % desde un archivo .pk3', locked], ['clear', '×', 'Quitar %', locked]],
    });

    // What happened last time stays on the card until something is in the way of the next.
    const idle = 'Crea una sala de Centro de Intercambio en la Switch y conecta.';
    const status = running ? state.tradePhase : blocker ?? (state.tradePhase || idle);
    setLine('trade-status', status, running ? state.tradeTone : blocker ? 'warn' : state.tradeTone);
    $('trade-hint').textContent = state.partyNote;
    $('trade-dot').className = `dot ${running ? state.tradeTone || 'busy' : blocker ? '' : 'good'}`.trim();
    $('trade-connect').hidden = running;
    $('trade-connect').disabled = Boolean(blocker);
    $('trade-decline').hidden = !running || state.tradeDeclining || !state.opponent;
    $('trade-decline').disabled = state.trading;
    $('trade-stop').hidden = !running;
    renderFolder();
}

// ---------------------------------------------------------------- boxes, from a .sav

async function onSavFile(file) {
    if (!file) return;
    try {
        state.boxes = readBoxes(new Uint8Array(await file.arrayBuffer()));
        state.box = 0;
        state.boxesNote = null;
    } catch (error) {
        state.boxes = null;
        state.boxesNote = { text: describe(error), tone: 'bad' };
    }
    renderBoxes();
}

function chooseBox(index) {
    if (!state.boxes || index < 0 || index >= state.boxes.length) return;
    state.box = index;
    renderBoxes();
}

function renderBoxes() {
    const tabs = $('box-tabs');
    tabs.replaceChildren();
    if (state.boxes) {
        state.boxes.forEach((_, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.box = String(index);
            button.setAttribute('aria-pressed', String(index === state.box));
            button.textContent = String(index + 1);
            tabs.append(button);
        });
    }
    drawSlots('box-slots', state.boxes?.[state.box] ?? [], { pick: true, drag: true, empty: 'Vacío' });
    setLine('boxes-status', state.boxesNote?.text, state.boxesNote?.tone);
}

// Puts a box Pokémon straight into the party's currently selected slot: no picker,
// no second click. Pick a different slot first by clicking a filled one in the party
// grid below, or drag a box Pokémon onto any slot instead.
function onBoxSlotClick(event) {
    if (!event.target.closest('[data-act="pick"]')) return;
    const slot = event.target.closest('.slot');
    if (!slot || state.trade) return;
    const pk = state.boxes?.[state.box]?.[Number(slot.dataset.slot)];
    if (!pk) return;
    const target = state.party.selected;
    state.party.set(target, pk);
    state.party.select(target);
    state.partyNote = '';
    renderTrade();
}

function chooseSource(source) {
    if (state.trade || !SOURCES.includes(source) || source === state.source) return;
    state.source = source;
    state.tradePhase = '';
    state.tradeTone = '';
    remember(SOURCE_STORE, source);
    renderTrade();
}

function setPoolServer(address) {
    state.poolServer = address.trim() || POOL_SERVER;
    remember(SERVER_STORE, state.poolServer === POOL_SERVER ? null : state.poolServer);
    renderTrade();
}

async function onTradeConnect() {
    if (state.trade || tradeBlocker()) return;
    const pool = pooling();
    const controller = new AbortController();
    state.tradeStop = controller;
    state.tradePhase = 'Pidiendo a la placa su enlace con el adaptador';
    state.tradeTone = '';
    state.tradeDeclining = false;
    state.opponent = null;
    state.poolMon = null;
    state.menuOpen = false;
    state.trading = false;
    state.partyNote = '';
    state.trades = 0;
    state.offered = -1;
    clearInterval(state.pollTimer);
    const session = new TradeSession({
        device: state.esp,
        party: pool ? null : state.party.export(),
        selected: state.party.selected,
        pool: pool ? new PoolClient(poolServer()) : null,
        emit: onTradeEvent,
    });
    state.trade = session;
    render();
    try {
        await session.run(controller.signal);
        const count = state.trades === 1 ? 'Un Pokémon' : `${state.trades} Pokémon`;
        state.tradePhase = state.trades === 0 ? 'Terminado sin intercambiar.' : pool ? `Terminado. ${count} fueron a la Switch desde la bolsa.` : `Terminado. ${count} llegaron.`;
        state.tradeTone = state.trades > 0 ? 'good' : '';
    } catch (error) {
        const stopped = error instanceof CancelledError;
        const gone = !state.esp;
        state.tradePhase = stopped ? 'Desconectado.' : gone ? 'La placa ESP32 dejó de responder durante el intercambio.' : describe(error);
        state.tradeTone = stopped ? '' : 'bad';
        if (!stopped) log('trade', describe(error));
    } finally {
        // The board may have gone away during the session, which is what ended it.
        state.trade = null;
        state.tradeStop = null;
        state.opponent = null;
        state.poolMon = null;
        state.menuOpen = false;
        state.trading = false;
        state.tradeDeclining = false;
        state.offered = -1;
        clearInterval(state.pollTimer);
        state.pollTimer = setInterval(pollSession, POLL_MS);
        pollSoon();
        render();
    }
}

function readMon(bytes) {
    try { return bytes ? parsePk3(bytes) : null; } catch { return null; }
}

function onTradeEvent(event) {
    const pool = pooling();
    switch (event.event) {
        case 'phase':
            state.tradePhase = event.message;
            state.tradeTone = event.tone || (state.opponent ? 'good' : '');
            break;
        case 'log':
            log('trade', event.message);
            return;
        case 'opponent_party':
            state.opponent = { name: event.name, party: event.party.map(readMon) };
            state.tradeTone = 'good';
            break;
        case 'menu': {
            // Nothing is on offer until the player here says so, which is what lets the
            // Switch leave the menu with a single cancel.
            state.menuOpen = true;
            const name = state.poolMon ? describeMon(state.poolMon).name : 'el Pokémon de la bolsa';
            state.tradePhase = pool
                ? `El menú de intercambio está abierto. Pulsa Aceptar intercambio para ${name}; para otro distinto, CANCELAR en la Switch y siéntate de nuevo.`
                : `El menú de intercambio está abierto${state.trades ? ' otra vez' : ''}. Haz clic en un Pokémon para ofrecerlo.`;
            state.tradeTone = 'good';
            break;
        }
        case 'offer': {
            const pk = pool ? state.poolMon : state.party.slots[event.slot];
            if (event.taken && pk) {
                state.offered = event.slot;
                state.tradePhase = pool
                    ? `Intercambio aceptado. Elige qué dar por ${describeMon(pk).name} en la Switch.`
                    : `Ofreciendo ${describeMon(pk).name}. Elige uno en la Switch.`;
                state.tradeTone = 'good';
            } else if (!state.opponent) {
                state.tradePhase = 'Siéntate primero en la mesa de intercambio de la Switch.';
            }
            break;
        }
        case 'trading':
            state.trading = true;
            state.tradePhase = 'El intercambio está en marcha.';
            state.tradeTone = 'good';
            break;
        case 'declining':
            state.tradeDeclining = event.value;
            if (event.value) state.offered = -1;
            break;
        case 'room':
            state.menuOpen = state.trading = false;
            state.opponent = null;
            state.offered = -1;
            state.tradeDeclining = false;
            state.tradePhase = pool
                ? 'De vuelta en la sala. Siéntate otra vez en la mesa para otro Pokémon de la bolsa, o sal de la sala para terminar.'
                : 'De vuelta en la sala. Siéntate otra vez en la mesa para intercambiar más, o sal de la sala para terminar.';
            state.tradeTone = '';
            break;
        case 'received':
            try {
                state.menuOpen = state.trading = false;
                state.party.receive(event.slot, event.pk3);
                state.trades++;
                state.offered = -1;
                // La Switch's party has changed too; it sends the new one once both games have saved.
                state.opponent = null;
                state.tradePhase = `Intercambiado. ${describeMon(state.party.slots[event.slot]).name} está ahora en la casilla ${event.slot + 1}.`;
                state.tradeTone = 'good';
                keepInFolder(state.party.slots[event.slot]);
            } catch (error) {
                state.tradePhase = describe(error);
                state.tradeTone = 'bad';
            }
            break;
        case 'pool_mon':
            state.poolMon = readMon(event.pk3);
            state.offered = -1;
            break;
        case 'pool_traded': {
            const gave = readMon(event.gave), got = readMon(event.got);
            state.menuOpen = state.trading = false;
            state.trades++;
            state.offered = -1;
            state.poolMon = null;
            state.opponent = null;
            const names = `${got ? describeMon(got).name : 'El Pokémon de la bolsa'} fue a la Switch`;
            if (event.sealed) {
                state.tradePhase = `Intercambiado. ${names}, y ${gave ? describeMon(gave).name : 'el de la Switch'} está en la bolsa.`;
                state.tradeTone = 'good';
            } else {
                if (gave) keep(gave);
                state.tradePhase = `${names}, pero la bolsa no confirmó el cambio. ${gave ? describeMon(gave).name : 'Lo que dio la Switch'} se guarda abajo: guárdalo como archivo.`;
                state.tradeTone = 'warn';
            }
            break;
        }
        default:
            break;
    }
    renderTrade();
}

function onSlotClick(event) {
    const button = event.target.closest('[data-act]');
    const slot = event.target.closest('.slot');
    if (!button || !slot || button.disabled) return;
    const index = Number(slot.dataset.slot);
    if (pooling()) return;
    if (button.dataset.act === 'save') { savePk3(state.party.slots[index]); return; }
    if (button.dataset.act === 'swap') { openPk3Picker(index); return; }
    if (button.dataset.act === 'clear') { twice(button, '¿Seguro?', () => { state.party.set(index, null); renderTrade(); }); return; }
    if (!state.party.slots[index]) {
        if (!state.trade) openPk3Picker(index);
        return;
    }
    state.party.select(index);
    state.partyNote = '';
    if (state.trade) state.trade.offerSlot(index);
    renderTrade();
}

function openPk3Picker(slot = state.party.selected) {
    if (state.trade) return;
    state.pickerSlot = slot;
    $('trade-file').value = '';
    $('trade-file').click();
}

async function onPk3File(file, slot = state.pickerSlot) {
    if (!file || state.trade) return;
    try {
        state.party.set(slot, parsePk3(new Uint8Array(await file.arrayBuffer())));
        state.party.select(slot);
        state.partyNote = '';
    } catch (error) {
        state.partyNote = describe(error);
    }
    renderTrade();
}

function savePk3(pk) {
    if (!pk) return;
    const blob = new Blob([pk.export()], { type: 'application/octet-stream' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${describeMon(pk).name || pk.speciesName}.pk3`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

// What the Switch gave in a swap the pool did not confirm. It belongs to the player, so
// it stays in this browser until they have saved it.
function keep(pk) {
    state.kept.push(pk);
    storeKept();
}

function storeKept() {
    remember(KEPT_STORE, state.kept.length ? JSON.stringify(state.kept.map((pk) => toHex(pk.export()))) : null);
}

function loadKept() {
    try { state.kept = JSON.parse(remembered(KEPT_STORE) ?? '[]').map((hex) => parsePk3(fromHex(hex))); }
    catch { state.kept = []; }
}

function onKeptClick(event) {
    const button = event.target.closest('[data-act]');
    const slot = event.target.closest('.slot');
    if (!button || !slot) return;
    const index = Number(slot.dataset.slot);
    if (button.dataset.act === 'save') savePk3(state.kept[index]);
    else if (button.dataset.act === 'forget') twice(button, '¿Seguro?', () => { state.kept.splice(index, 1); storeKept(); renderTrade(); });
}

// ---------------------------------------------------------------- the .pk3 folder

// A Pokémon that arrives from the Switch is worth keeping as a file, so it is written
// into the chosen folder without anyone pressing anything. The trade does not wait for
// the disk: the file lands a moment later, and the line under the buttons says so.
function keepInFolder(pk) {
    if (!state.folder?.ready || !pk) return;
    Pk3Folder.save(pk, describeMon(pk).name).then((name) => {
        if (name) state.folderNote = `Guardado ${name} en la carpeta.`;
        renderTrade();
    }).catch((error) => {
        state.folderNote = `No se pudo guardar el archivo: ${describe(error)}`;
        renderTrade();
    });
}

function renderFolder() {
    const onServer = Pk3Folder.backend() === 'server';
    const usable = Pk3Folder.available();
    const folder = state.folder;
    // On the project's own server there is nothing to choose and nothing to remember.
    $('folder-actions').hidden = !usable || onServer;
    $('folder-pick').textContent = folder && !folder.ready ? 'Reactivar el guardado en la carpeta' : folder ? 'Cambiar la carpeta' : 'Elegir la carpeta';
    $('folder-forget').hidden = !folder || onServer;
    $('folder-note').hidden = !folder;
    if (!folder) return;
    const where = onServer ? `la carpeta ${Pk3Folder.subfolder} del proyecto` : `${folder.name}/${Pk3Folder.subfolder}`;
    $('folder-note').textContent = state.folderNote || (folder.ready
        ? `Los Pokémon que lleguen se guardan en ${where}.`
        : `Chrome tiene que dar permiso otra vez para escribir en ${where}.`);
}

async function onFolderPick() {
    try {
        const chosen = state.folder && !state.folder.ready ? await Pk3Folder.resume() : await Pk3Folder.pick();
        if (!chosen) return;
        state.folder = chosen;
        state.folderNote = '';
    } catch (error) {
        // Closing the picker without choosing is not a failure worth reporting.
        if (error?.name !== 'AbortError') state.folderNote = describe(error);
    }
    renderTrade();
}

async function onFolderForget() {
    await Pk3Folder.forget();
    state.folder = null;
    state.folderNote = '';
    renderTrade();
}

// ---------------------------------------------------------------- rendering

let espActions = {};
let adapterActions = {};

function drawCard(prefix, view) {
    const card = $(`${prefix}-card`);
    card.classList.toggle('done', Boolean(view.done));
    $(`${prefix}-dot`).className = `dot ${view.busy ? 'busy' : view.dot ?? view.tone ?? ''}`.trim();
    setLine(`${prefix}-status`, view.text, view.tone);
    $(`${prefix}-hint`).textContent = view.hint ?? '';
    const primary = $(`${prefix}-primary`);
    primary.hidden = !view.primary;
    if (view.primary && !armed.has(primary)) primary.textContent = view.primary[0];
    const secondary = $(`${prefix}-secondary`);
    secondary.hidden = !view.secondary;
    if (view.secondary) secondary.textContent = view.secondary[0];
    $(`${prefix}-actions`).classList.toggle('empty', !view.primary && !view.secondary);
    return { primary: view.primary?.[1], secondary: view.secondary?.[1] };
}

function render() {
    renderPaths();
    const esp = espView();
    espActions = drawCard('esp', esp);
    setProgress('esp-progress', esp.progress ?? null);
    $('keys-panel').hidden = !esp.keys;
    const keys = keysLine();
    setLine('keys-status', keys.text, keys.tone);
    $('esp-details').hidden = !esp.connected;
    $('esp-more').hidden = !esp.connected || esp.busy;
    $('keys-replace').hidden = !state.keys?.complete;
    if (!armed.has($('keys-replace'))) $('keys-replace').textContent = state.replacingKeys ? 'Conservar las claves guardadas' : 'Reemplazar las claves';
    $('keys-erase').hidden = !state.keys || !Object.keys(KEY_NAMES).some((flag) => state.keys[flag]);

    renderTrade();
    renderBoxes();

    if (gbaTree()) {
        const adapter = adapterView();
        adapterActions = drawCard('adapter', adapter);
        $('adapter-details').hidden = !adapter.connected;
        $('adapter-more').hidden = Boolean(adapter.busy);
        $('adapter-reinstall').hidden = !adapter.done;
        $('adapter-disconnect').hidden = !state.adapter && !state.bootDevice;
        $('adapter-connect-serial').hidden = Boolean(state.adapter) || !GbLinkSerial.available() || !GbLinkUsb.available();
        $('adapter-file-clear').hidden = !state.customUf2;
        setLine('adapter-file-status', state.uf2Note, 'bad');
        $('adapter-bootsel').hidden = !state.adapter;
        drawSteps();

        const pins = LINK_PINS[state.esp?.info?.chip];
        const labels = LINK_PIN_LABELS[state.esp?.info?.chip];
        const pin = (index) => `GPIO${pins[index]}${labels ? ` (${labels[index]})` : ''}`;
        $('wiring').hidden = Boolean(pins);
        $('wires').hidden = !pins;
        if (pins) {
            $('wire-tx').textContent = pin(0);
            $('wire-rx').textContent = pin(1);
        }
        $('wiring-check').disabled = !state.esp?.attached || Boolean(state.bridge);
        setLine('wiring-status', state.wiringNote?.text, state.wiringNote?.tone);

        const blocker = bridgeBlocker();
        $('bridge-start').hidden = Boolean(state.bridge);
        $('bridge-start').disabled = Boolean(blocker);
        $('bridge-stop').hidden = !state.bridge;
        $('bridge-facts').hidden = !state.bridge;
        if (state.bridge) setLine('bridge-status', 'Transportando el enlace. Mantén esta pestaña abierta y visible.', 'good');
        else if (state.bridgeNote) setLine('bridge-status', state.bridgeNote.text, state.bridgeNote.tone);
        else setLine('bridge-status', blocker ?? 'Listo.');
        renderSession();
    }
}

function drawSteps() {
    const list = $('adapter-steps');
    const install = state.install;
    list.hidden = !install;
    if (!install) return;
    const order = ['restart', 'choose', 'write', 'reconnect'];
    const at = order.indexOf(install.step);
    $('adapter-step-restart').textContent = install.manual
        ? 'Mantén pulsado BOOTSEL del adaptador mientras lo enchufas'
        : 'Reiniciar el adaptador en modo de actualización';
    for (const item of list.children) {
        const index = order.indexOf(item.dataset.step);
        // By hand, the first two steps are both the user's and both wait on the button.
        const current = index === at || (install.manual && install.step === 'restart' && index <= 1);
        item.className = current ? 'current' : index < at ? 'done' : '';
    }
}

// ---------------------------------------------------------------- start-up

function wireUp() {
    const statusIds = ['esp-status', 'keys-status', 'trade-status', 'boxes-status'];
    if (gbaTree()) statusIds.push('adapter-status', 'adapter-file-status', 'bridge-status', 'wiring-status');
    for (const id of statusIds) $(id).dataset.base = 'status';

    $('esp-primary').addEventListener('click', () => espActions.primary?.());
    $('esp-secondary').addEventListener('click', () => espActions.secondary?.());
    $('esp-reinstall').addEventListener('click', () => onEspInstall());
    $('esp-wipe').addEventListener('click', (event) => twice(event.currentTarget, 'Pulsa otra vez: esto también borra las claves', () => onEspInstall(true)));
    $('esp-disconnect').addEventListener('click', () => dropEsp());
    $('keys-replace').addEventListener('click', () => { state.replacingKeys = !state.replacingKeys; state.keysNote = null; render(); });
    $('keys-erase').addEventListener('click', (event) => twice(event.currentTarget, 'Pulsa otra vez para borrar las claves', onKeysErase));
    $('keys-file').addEventListener('change', (event) => {
        onKeysFile(event.target.files[0]);
        event.target.value = '';
    });
    const drop = $('keys-drop');
    for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('over'); });
    for (const name of ['dragleave', 'drop']) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (event) => onKeysFile(event.dataTransfer?.files?.[0]));
    // A file dropped beside the target would otherwise replace the page.
    for (const name of ['dragover', 'drop']) window.addEventListener(name, (event) => event.preventDefault());

    if (gbaTree()) {
        $('adapter-primary').addEventListener('click', () => adapterActions.primary?.());
        $('adapter-secondary').addEventListener('click', () => adapterActions.secondary?.());
        $('adapter-select').addEventListener('click', onAdapterSelect);
        $('adapter-reinstall').addEventListener('click', onAdapterInstall);
        $('adapter-connect-serial').addEventListener('click', () => onAdapterConnect('serial'));
        $('adapter-disconnect').addEventListener('click', () => dropAdapter());
        $('adapter-file').addEventListener('change', (event) => onAdapterFile(event.target.files[0]));
        $('adapter-file-clear').addEventListener('click', () => {
            state.customUf2 = null;
            $('adapter-file').value = '';
            render();
        });
        $('adapter-bootsel').addEventListener('click', async () => {
            const adapter = state.adapter;
            if (!adapter) return;
            if (state.bridge) await stopBridge();
            await adapter.rebootToBootloader();
            await sleep(200);
            await dropAdapter({ code: 'gone', text: 'El adaptador se está reiniciando en modo de actualización; debería aparecer una unidad RPI-RP2.' });
        });
    }

    $('paths').addEventListener('click', (event) => choosePath(event.target.closest('[data-path]')?.dataset.path));
    window.addEventListener('hashchange', () => choosePath(location.hash.slice(1), { keep: false }));
    $('trade-source').addEventListener('click', (event) => chooseSource(event.target.closest('[data-source]')?.dataset.source));
    $('folder-pick').addEventListener('click', onFolderPick);
    $('folder-forget').addEventListener('click', onFolderForget);
    $('trade-connect').addEventListener('click', onTradeConnect);
    $('trade-decline').addEventListener('click', () => { state.trade?.declineTrade(); state.tradeDeclining = true; renderTrade(); });
    $('trade-stop').addEventListener('click', () => state.tradeStop?.abort());
    $('our-slots').addEventListener('click', onSlotClick);
    $('trade-file').addEventListener('change', (event) => onPk3File(event.target.files[0]));
    $('our-slots').addEventListener('dragover', (event) => {
        const slot = event.target.closest('.slot');
        if (!slot || state.trade || pooling()) return;
        event.preventDefault();
        slot.classList.add('drop-target');
    });
    $('our-slots').addEventListener('dragleave', (event) => event.target.closest('.slot')?.classList.remove('drop-target'));
    $('our-slots').addEventListener('drop', (event) => {
        const slot = event.target.closest('.slot');
        if (!slot || state.trade || pooling()) return;
        event.preventDefault();
        slot.classList.remove('drop-target');
        const index = Number(slot.dataset.slot);
        const hex = event.dataTransfer?.getData('application/x-pk3-hex');
        if (hex) {
            try {
                state.party.set(index, parsePk3(fromHex(hex)));
                state.party.select(index);
                state.partyNote = '';
            } catch (error) {
                state.partyNote = describe(error);
            }
            renderTrade();
            return;
        }
        onPk3File(event.dataTransfer?.files?.[0], index);
    });

    $('sav-file').addEventListener('change', (event) => {
        onSavFile(event.target.files[0]);
        event.target.value = '';
    });
    $('box-tabs').addEventListener('click', (event) => {
        const box = event.target.closest('[data-box]');
        if (box) chooseBox(Number(box.dataset.box));
    });
    $('box-slots').addEventListener('click', onBoxSlotClick);

    if (gbaTree()) {
        $('bridge-start').addEventListener('click', onBridgeStart);
        $('bridge-stop').addEventListener('click', () => stopBridge());
        $('wiring-check').addEventListener('click', onWiringCheck);
    }

    $('log-clear').addEventListener('click', () => {
        logLines.length = 0;
        lastLogged = { key: '', count: 0 };
        $('log').textContent = '';
    });
    $('log-copy').addEventListener('click', () => navigator.clipboard?.writeText(logLines.join('\n')));

    // A tab the browser is not showing has its timers slowed to about one a second,
    // which is far too slow to hold the Switch's link.
    document.addEventListener('visibilitychange', () => {
        if (!state.trade) return;
        if (document.hidden) state.hiddenAt = Date.now();
        else if (state.hiddenAt) {
            const away = Math.round((Date.now() - state.hiddenAt) / 1000);
            state.hiddenAt = 0;
            if (away >= 2) {
                state.tradePhase = `Esta pestaña estuvo en segundo plano ${away}s, lo que corta el enlace. Mantenla visible mientras intercambias.`;
                state.tradeTone = 'warn';
                renderTrade();
            }
        }
    });

    navigator.usb?.addEventListener('connect', onUsbConnect);
    // Hand the adapter port back if the page goes away while it carries the link.
    window.addEventListener('pagehide', () => { if (state.bridge) state.bridge.stop(); });
}

async function start() {
    wireUp();
    // A link to one of the trees wins over the one used last.
    const asked = location.hash.slice(1);
    state.path = PATHS.includes(asked) ? asked : PATHS.includes(remembered(PATH_STORE)) ? remembered(PATH_STORE) : 'switch';
    state.source = 'party';
    state.poolServer = remembered(SERVER_STORE) || POOL_SERVER;
    loadKept();
    state.folder = await Pk3Folder.restore();
    const serial = EspDevice.available();
    if (!serial || !window.isSecureContext) {
        const notice = $('unsupported');
        notice.hidden = false;
        notice.textContent = serial
            ? 'Los navegadores solo dan acceso a dispositivos USB desde páginas https:// o desde localhost.'
            : 'Este navegador no tiene Web Serial, que esta página necesita para llegar a las placas. Usa Chrome, Edge u otro navegador Chromium en un ordenador.';
    }
    try {
        state.partyNote = (await state.party.load()) === 'empty' ? 'Suelta un archivo .pk3 en una casilla para añadir un Pokémon.' : '';
    } catch (error) {
        log('page', describe(error));
    }
    try {
        state.manifest = await loadManifest();
        const adapter = state.manifest.adapter;
        if (gbaTree()) {
            $('adapter-download').href = state.manifest.base + adapter.path;
            $('adapter-download').textContent = `el archivo de firmware (${adapter.version})`;
        }
    } catch (error) {
        log('page', describe(error));
    }
    render();
    if (!serial) for (const id of ['esp-primary']) $(id).disabled = true;
}

start();
