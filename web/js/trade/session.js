// A visit to the Switch's trade room, with the board doing the wireless. The page asks
// to be the board's adapter, then plays the second game: the board finds the room, joins
// it and decrypts everything, and this side only answers the frames it passes on.
//
// The Pokémon on offer are either the player's own or, with a pool, whatever the trade
// pool hands out: the Switch's choice goes to the pool in exchange, and leaving the
// menu and sitting down again brings a different one.

import { ConnectionError } from './bytes.js';
import { GB_CHANNEL, GbFrameParser } from '../wire.js';
import { FrameReader, toGbFrames } from './adapter.js';
import { AdapterLink } from './link.js';
import { TradeEngine } from './engine.js';
import { Pk3 } from './pk3.js';
import { PoolError, poolRecord } from './pool.js';

const SILENT_S = 30;          // connected, but the Switch has stopped sending
const POLL_MS = 1000;         // how often the board is asked what it is doing
const POOL_PATIENCE_MS = 8000;   // how long the party is held back for the pool's next Pokémon
const FIRST_TRIES = 3;        // for the pool's first Pokémon, without which there is no party
const MAIL_SIZE = 36;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CancelledError extends Error {
    constructor() { super('Cancelled'); this.name = 'CancelledError'; }
}

export class TradeSession {
    // party and selected are the player's own; with a pool they are not used.
    constructor({ device, party = null, selected = 0, emit, pool = null }) {
        this.device = device;
        this.emit = emit;
        this.pool = pool;
        this.party = party;
        this.selected = selected;
        this.engine = null;
        this.poolMon = null;          // what the pool is offering: { record, wire, pk, mail }
        this.given = null;            // the Switch's Pokémon the pool has agreed to take
        this.poolBusy = Promise.resolve();
        this.poolAsked = false;       // the pool's first Pokémon has been asked for
        this.poolLost = false;
        this.declineRequested = false;
        this.offerRequested = -1;
        this.failure = null;
    }

    declineTrade() { this.declineRequested = true; }
    offerSlot(slot) { this.offerRequested = slot; }

    phase(message, tone = '') { this.emit({ event: 'phase', message, tone }); }
    log(message) { this.emit({ event: 'log', message }); }

    async run(signal) {
        const device = this.device;
        // The pool is reached before the board is asked for anything, so a pool that is
        // down costs nothing. No Pokémon is taken from it yet: one that is on offer to
        // this connection is kept from everyone else.
        if (this.pool) {
            this.phase('Contactando con la bolsa de intercambio');
            await this.pool.connect();
        }
        const engine = this.engine = this.pool
            ? new TradeEngine([null, null, null, null, null, null], 0, { minimum: 0 })
            : new TradeEngine(this.party, this.selected);
        engine.onLog = (message) => this.log(message);
        engine.onNotice = (message) => this.phase(message);
        engine.onDecliningChanged = (value) => this.emit({ event: 'declining', value });
        engine.onMenuOpen = () => this.emit({ event: 'menu' });
        engine.onTradeStart = () => this.emit({ event: 'trading' });
        engine.onOpponentParty = (party, name) => this.emit({ event: 'opponent_party', name, party });
        engine.onRoom = () => {
            this.emit({ event: 'room', traded: engine.commits });
            if (this.pool) this.replaceFromPool(signal, true);
        };
        if (this.pool) {
            engine.holdParty();
            engine.onHostChoice = (cursor) => this.consultPool(cursor, signal);
            engine.onCommitted = (data) => this.sealWithPool(data, signal);
        } else {
            engine.onCommitted = (data, slot) => this.emit({ event: 'received', slot, pk3: data });
        }

        const link = new AdapterLink({ engine, send: (frame) => device.sendAdapter(toGbFrames(frame)) });
        link.onLog = (message) => this.log(message);
        const gb = new GbFrameParser(512);
        const reader = new FrameReader();
        let taken = false;
        try {
            const reply = await device.command('LDN_ADAPTER host', 3000);
            if (!reply.includes('LDN_ADAPTER host')) throw new ConnectionError('La placa no cedió su enlace con el adaptador. Instala el firmware del paso 1 y vuelve a intentarlo.');
            taken = true;
            this.emit({ event: 'device', model: device.info?.chip, firmware: device.info?.version });
            // Frames arrive as the board sends them, so the page answers at the link's
            // own pace instead of keeping a clock of its own.
            device.onAdapterFrame = (payload) => {
                try {
                    for (const frame of gb.push(payload)) {
                        if (frame.channel !== GB_CHANNEL.DATA) continue;
                        for (const rfu of reader.push(frame.payload)) link.feed(rfu);
                    }
                } catch (error) { this.failure ??= error; }
            };
            this.phase('Esperando a que la placa encuentre la sala');
            await this.pump(link, signal);
        } finally {
            device.onAdapterFrame = null;
            this.pool?.close();
            if (taken) {
                try { link.leave(); } catch {}
                // The board's own bridge takes its link back, unless it is restarting,
                // which it does by itself once the Switch has left the room.
                try { await device.command('LDN_ADAPTER uart', 2000); } catch (error) { this.log(`La placa no recuperó su enlace con el adaptador: ${error.message}`); }
            }
        }
    }

    async pump(link, signal) {
        const device = this.device, engine = this.engine;
        const started = performance.now();
        const seconds = () => (performance.now() - started) / 1000;
        let nextPoll = 0, lastFrames = 0, lastMoved = 0, announced = '';
        while (!link.disconnected) {
            if (signal?.aborted) throw new CancelledError();
            if (this.failure) throw this.failure;
            // The board restarts itself when a room ends; that is the visit finishing.
            if (!device.attached) { this.log('La placa se está reiniciando, como hace al terminar la sala.'); break; }
            if (this.declineRequested) { this.declineRequested = false; engine.decline(); }
            if (this.offerRequested >= 0) {
                const slot = this.offerRequested;
                this.offerRequested = -1;
                this.emit({ event: 'offer', slot, taken: engine.offer(slot) });
            }
            // The two games have introduced themselves, which they do once the player on
            // the Switch has let this one into the group. The trade table is still a walk
            // away, so the pool's Pokémon is there before the parties are exchanged.
            if (this.pool && !this.poolAsked && engine.established) { this.poolAsked = true; this.firstFromPool(signal); }
            if (this.pool?.closed && this.poolAsked && !this.poolLost) this.poolDropped(signal);
            const now = seconds();
            if (link.hostFrames !== lastFrames) { lastFrames = link.hostFrames; lastMoved = now; }
            if (link.connected && lastMoved > 0 && now - lastMoved > SILENT_S)
                throw new ConnectionError(`La Switch dejó de responder durante ${SILENT_S}s, así que se cerró el enlace. Sal de la sala en la Switch y conecta de nuevo.`);
            if (now >= nextPoll && !link.connected) {
                nextPoll = now + POLL_MS / 1000;
                const line = await this.describe(link);
                if (line && line !== announced) { announced = line; this.phase(line); }
            }
            await sleep(30);
        }
    }

    // What the board says it is doing, until the games take over the story.
    async describe(link) {
        let status = null;
        try { status = await this.device.bridgeStatus(); } catch { return null; }
        if (!status) return null;
        if (status.state === 'scan') {
            if (this.device.hearsUnreadableRoom) return 'La placa oye una sala de la Switch pero no puede leerla: las claves que tiene no coinciden. Reemplaza las claves del paso 1 con un prod.keys de tu propia Switch.';
            return 'La placa busca una sala de Rojo Fuego o Verde Hoja. Abre el Centro de Intercambio en la Switch como líder del grupo.';
        }
        if (status.state === 'stopped' || status.state === 'idle') return 'La placa no busca ninguna sala. Desenchúfala y vuelve a enchufarla.';
        if (status.state !== 'run') return 'La placa se está uniendo a la sala de la Switch.';
        return link.room === null ? 'En la sala. Esperando a que se ofrezca para intercambiar.' : 'En la sala, uniéndose al intercambio.';
    }

    // ---- the trade pool

    // One thing at a time with the pool: its answers are counted, so two conversations
    // at once would take each other's.
    poolStep(work) {
        const step = this.poolBusy.then(work);
        this.poolBusy = step.catch(() => {});
        return step;
    }

    showPoolMon() {
        const { wire, mail } = this.poolMon;
        this.engine.setPartyMon(0, wire, mail);
        this.emit({ event: 'pool_mon', pk3: wire });
    }

    // Without a first Pokémon there is no party to show the Switch, so the party stays
    // held back through a few tries and the visit ends if none of them brings one.
    firstFromPool(signal) {
        return this.poolStep(async () => {
            for (let attempt = 1; ; attempt++) {
                try {
                    if (this.pool.closed) await this.pool.connect();
                    this.poolMon = await this.pool.fetchMon(deadline(signal, POOL_PATIENCE_MS));
                    this.poolLost = false;
                    this.showPoolMon();
                    this.engine.releaseParty();
                    return;
                } catch (error) {
                    this.log(`Bolsa de intercambio: ${error.message}`);
                    if (signal?.aborted) return;
                    if (attempt >= FIRST_TRIES || !(error instanceof PoolError)) {
                        this.failure ??= new ConnectionError(`${error.message} Sin ella no hay nada que intercambiar, así que la visita terminó.`);
                        return;
                    }
                    await sleep(1000);
                }
            }
        });
    }

    // The Switch has chosen: the pool says whether it will take that Pokémon, and only
    // then is the trade confirmed.
    consultPool(cursor, signal) {
        const engine = this.engine;
        return this.poolStep(async () => {
            let accepted = false;
            try {
                const wire = engine.hostMon(cursor);
                const index = new Pk3(wire).hasMail ? wire[0x55] : -1;
                const mail = index >= 0 && engine.hostMail ? engine.hostMail.subarray(index * MAIL_SIZE, (index + 1) * MAIL_SIZE) : null;
                this.given = { wire, record: poolRecord(wire, { mail, game: engine.hostGame, ribbons: engine.hostRibbons }) };
                accepted = await this.pool.propose(this.given.record, deadline(signal, POOL_PATIENCE_MS));
                if (!accepted) this.phase('La bolsa de intercambio no acepta ese Pokémon. Elige otro en la Switch.', 'warn');
            } catch (error) {
                this.log(`Bolsa de intercambio: ${error.message}`);
                this.phase('La bolsa de intercambio dejó de responder, así que se canceló este intercambio. Sal del menú de intercambio en la Switch y siéntate de nuevo.', 'warn');
            }
            engine.verdict(accepted);
        });
    }

    // The games have traded: the pool is told, and its next Pokémon takes the place of
    // the one that went. The party is held back until it has arrived.
    sealWithPool(received, signal) {
        const given = this.given, taken = this.poolMon;
        this.engine.holdParty();
        return this.poolStep(async () => {
            let sealed = false;
            try { sealed = await this.pool.complete(new Pk3(given.wire), taken.pk, deadline(signal, POOL_PATIENCE_MS)); }
            catch (error) { this.log(`Bolsa de intercambio: ${error.message}`); }
            this.emit({ event: 'pool_traded', gave: received, got: taken.wire, sealed });
            // A swap the pool did not seal leaves it offering the Pokémon that has just
            // gone to the Switch, which only a new connection changes.
            await this.nextPoolMon(signal, !sealed);
        });
    }

    // A different Pokémon from the pool, which only a finished trade or a new connection
    // brings. The Switch sees it the next time the parties are exchanged, and that
    // exchange waits for it.
    replaceFromPool(signal, reconnect) {
        this.engine.holdParty();
        return this.poolStep(() => this.nextPoolMon(signal, reconnect));
    }

    async nextPoolMon(signal, reconnect) {
        if (!this.poolMon) return;   // the first one never came, and the visit is ending
        try {
            const limit = deadline(signal, POOL_PATIENCE_MS);
            if (reconnect || this.pool.closed) await this.pool.connect();
            this.poolLost = false;
            this.poolMon = await this.pool.fetchMon(limit);
            this.showPoolMon();
        } catch (error) {
            if (!(error instanceof PoolError) && error?.name !== 'DataError') this.failure ??= error;
            this.log(`Bolsa de intercambio: ${error.message}`);
            this.poolLost = true;
            this.phase('No se pudo contactar con la bolsa para otro Pokémon. Desconecta y conecta de nuevo.', 'warn');
        } finally {
            this.engine.releaseParty();
        }
    }

    // The pool's connection has gone, and with it the hold on the Pokémon on show. A
    // menu that is open keeps showing it, so that one has to be left first.
    poolDropped(signal) {
        this.poolLost = true;
        const engine = this.engine;
        if (engine.menuComplete || engine.sentParty > 0) {
            this.phase('La bolsa de intercambio cortó la conexión. Sal del menú de intercambio en la Switch y siéntate de nuevo para otro Pokémon.', 'warn');
            return;
        }
        this.replaceFromPool(signal, true);
    }
}

// An abort signal that also fires after a while, for steps that must not hold the games up.
function deadline(signal, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); controller.abort(); }, { once: true });
    return controller.signal;
}
