# Web client

The page at <https://switch.gblink.io>. It sets up the boards, and then either carries
the link between them or trades with the Switch itself. It is a static site: no build
step, no server side, everything over Web Serial and WebUSB in the browser.

Two modes, chosen at the top of the page and remembered; `#gba` and `#switch` in the
address open one directly.

**GBA to Switch** needs the ESP32 board and a GB-Link adapter.

1. **ESP32 board** – connects, installs or updates the firmware (the chip is detected,
   so one button serves the ESP32-S3, C6, C3 and the original ESP32), and stores the
   four console keys from a `prod.keys` dropped on the page.
2. **GB-Link adapter** – connects over WebUSB or serial, checks for the wireless adapter
   mode, and installs the firmware that has it.
3. **Play** – shows what the board is doing, checks the wiring for standalone use, or
   carries the adapter's traffic between the two boards over USB.

**PC to Switch** needs only the ESP32 board.

1. **ESP32 board** – the same card.
2. **Trade** – *Wonder Trade* with the pool of <https://pokemon.gblink.io>
   (`wss://pokemon-gb-online-trades.herokuapp.com`, path `/pool3`; changeable under
   *More options*), or *PK3 files*, a party of your own kept in the browser.
   `assets/party.json` here is the party a first visit starts from, a copy of the one in
   the repository root; replace both before publishing if you would rather not ship
   your own Pokémon.

### Why the page never offers by itself

The Switch is the link leader, and the leader:

- acts only once both players have answered,
- never sends its own player's pick over the link, only its cancel,
- cannot take an offer back.

So the page cannot wait for the Switch's pick and answer it. An offer made first costs
the Switch a second CANCEL to leave the menu; one held back makes the pick wait. The
page therefore offers nothing until you say so: click a Pokémon, or press *Accept
trade* / *Cancel trade* under the pool's Pokémon, before or after choosing on the
Switch. Nothing changes once the trade is under way. CANCEL in the menu returns both
players to the room; sitting down again opens a new menu, which with the pool brings a
different Pokémon.

With the pool, no Pokémon is taken until the Switch has let the page into the group,
because one on offer to a connection is kept from everyone else, and the pool is asked
before a trade is confirmed, so a Pokémon it will not take never leaves the Switch.
Keep the tab in view: a browser slows a hidden tab, and a game that stops answering is
dropped. The pictures come from [PokeAPI](https://github.com/PokeAPI/sprites).

The first two cards show one line of status and at most one button for whatever comes
next on that board. A board that is ready shrinks to a single line; installing again,
erasing, a `.uf2` of your own, connecting over serial and disconnecting are under
*More options*.

**The board does all the wireless, trading included.** It finds the room, joins it,
decrypts everything and runs the session, for the page just as for a real Game Boy
Advance. The page asks to stand in for the adapter (`LDN_ADAPTER host`) and answers the
plain frames the board passes on, so it holds no key and needs no firmware beyond what
it installs.

## Running it

Browsers only expose USB devices to pages served over `https://` or from `localhost`.
Any static host works (GitHub Pages included). Locally, `run.bat` — or `serve.py` by hand —
serves `web/` and gives the page somewhere to put the Pokémon it trades:

```
python3 serve.py 8000
```

then open <http://localhost:8000> in Chrome, Edge or another Chromium browser on a
computer.

`serve.py` answers `GET /api/pk3` and `POST /api/pk3/<name>`, and writes what it is sent
into `PK3/` at the project root, so a Pokémon that arrives from the Switch leaves a `.pk3`
behind without anything being pressed. Served by a plain static server instead, the page
falls back to the File System Access API and asks for a folder once.

| Browser | ESP32 board | Adapter | Installing adapter firmware |
| --- | --- | --- | --- |
| Chrome, Edge, other Chromium (desktop) | yes | WebUSB or serial | yes |
| Firefox 151 and later | yes | serial only | by hand (`.uf2` onto the `RPI-RP2` drive) |
| Safari, mobile browsers | no | no | no |

### Linux

- The serial ports need the usual group membership (`dialout` on Fedora, Debian and
  Ubuntu; `uucp` on Arch).
- WebUSB access to the adapter and to its bootloader needs udev rules; the GB-Link
  firmware repository installs them with `scripts/setup-linux-permissions.sh`.
  Connecting the adapter over serial works without them.
- A serial port keeps its line settings between programs. After a tool built on pyserial
  has used a port (`esptool.py`, `idf.py monitor`, the scripts in `firmware/tools/`),
  Chrome reports the port as lost the moment it opens it. The page recognises this and
  says so; unplugging the board and plugging it back in clears it, as does
  `stty -F /dev/ttyACM0 min 1`.

## What the steps do

### ESP32 board

*Connect* uses a port the page was given before without asking again, and otherwise
opens the browser's list. Running firmware answers within milliseconds, so the page
only waits on a board that is visibly starting up; a chip that prints its ROM's
"invalid header" or "waiting for download", or the boot log of some other project, is
reported as having no firmware after about two seconds, with *Install firmware* as the
one button. On a board with a USB-UART chip the page lets RTS go before DTR after
opening the port: reset is RTS without DTR, and a CP2102 moves the two pins one after
the other, so releasing both at once restarts the board.

*Install firmware* puts the chip in its bootloader, identifies it, and writes the three
images listed for it in `firmware/manifest.json` with
[esptool-js](https://github.com/espressif/esptool-js), verifying each by MD5. The flash
size in the bootloader header is set to what the chip reports. The images are written
separately rather than as one merged file, so the key store between them survives an
update; *Erase everything and install*, under *More options*, wipes it as well. A board
that does not enter its bootloader on its own needs BOOT held while RESET is pressed.
The page resets the chip itself afterwards, because the hard reset in esptool-js 0.6.1
never asserts RTS, and then reconnects.

The keys: the page reads the `prod.keys` you give it, takes
`aes_kek_generation_source`, `aes_key_generation_source`, `master_key_00` and
`master_key_12`, and sends those four values to the board over USB. Nothing is
uploaded, stored by the page or written to the log, and the board never sends a key
back: it only reports which of the four it holds.

### GB-Link adapter

The adapter sits in the GBA's link port on a Game Boy Color cable. A Game Boy Advance
cable does not connect both data lines at once, and the wireless adapter mode, the only
full-duplex mode the adapter has, needs both; the card says so.

The adapter answers a statistics command (`0x4c`) only when its firmware has the
wireless adapter mode, which is how the page tells. *Install firmware* walks through
four steps on the card: the page restarts the adapter in its USB bootloader, you pick
"RP2 Boot" in the browser's list (the bootloader is a different USB device, so the
browser has to be given access once more; that click is the only one needed), the page
writes the bundled `.uf2` with [picoflash](https://github.com/picoflash/picoflash), and
it reconnects to the restarted adapter. An adapter that is already in its bootloader
can be picked with *Connect* and goes straight to writing. A `.uf2` of your own can be
installed instead, and the manual route (BOOTSEL, then copy the file to the `RPI-RP2`
drive) always works; both are under *More options*.

### Play

Standalone, the two boards are joined by three wires and need no computer: the page only
shows which pins to join and checks whether the board hears the adapter. Through the
computer, the page asks the ESP32 board for its adapter port (`LDN_ADAPTER host`) and
relays GB-Link frames both ways (message kinds 6 and 7 of [the serial
protocol](../docs/SERIAL_PROTOCOL.md)). The board restarts after every session, which
drops that setting; the page notices the boot banner, repeats the handshake and takes
the port again, so consecutive sessions need no clicks. Keep the tab open and visible
while playing. While it carries the link the page also watches how often the game resets
the adapter: a game that cannot get a command through does so about four times a second
and blocks meanwhile, which on the GBA is a freeze with no message, so the page says
what is happening and that the cable must be a Game Boy Color one.

A chip's own USB port ignores the baud rate. A board behind a USB-UART bridge (the
original ESP32) runs its console at 921600 from the first line it prints, because a
browser cannot change the rate of a port it has open and the adapter's traffic needs
more than 115200 gives; the page opens such ports at 921600 and falls back to 115200,
where it finds firmware from before that (which can be updated but cannot carry the
link) and can read what a chip's bootloader prints.

## Firmware images

`firmware/` holds what the page installs: per-chip bootloader, partition table and
application for the ESP32 board, and the adapter's `.uf2`, listed in
`firmware/manifest.json`. After building, refresh them with

```
firmware/tools/package_web.py
firmware/tools/package_web.py --adapter-uf2 path/to/zephyr.uf2 --adapter-version 2.2.5
```

The offsets come from each build's `flasher_args.json`.

## Code

| File | |
| --- | --- |
| `js/wire.js` | COBS framing, CRC-32 and the message layout of the console protocol; GB-Link frames |
| `js/esp.js` | a session with the bridge firmware: handshake, commands, adapter frames, re-attaching after a restart |
| `js/gblink.js` | the adapter over WebUSB (endpoints framed and unframed here) or serial |
| `js/bridge.js` | relays frames between the two |
| `js/flash-esp.js`, `js/md5.js` | installing the bridge firmware |
| `js/flash-pico.js` | installing the adapter firmware |
| `js/keys.js` | picking the four values out of `prod.keys` |
| `js/manifest.js` | the bundled firmware list |
| `js/pk3-folder.js` | where a traded Pokémon is written: through `serve.py` into `PK3/`, or, on any other host, through the File System Access API into a folder the user picks once |
| `js/app.js` | the page: the two trees, and each card drawn from one view of its state (status line, hint, one button) |
| `js/trade/` | trading without a Game Boy Advance: `adapter.js` (the wireless adapter's frames, as the board relays them), `link.js` (joining the room and answering each frame), `rfu.js` and `engine.js` (the games' link protocol and the trade itself), `pk3.js` with the generated `pk3-data.js` (Pokémon data), `pool.js` (the trade pool's server), `party.js`, `sprites.js`, `session.js` (a visit to the room, with either) and `bytes.js` |
| `js/launcher-return.js` | the "Launcher" button shown when the page is opened from the [GB-Link launcher](https://launcher.gblink.io) (`?from=gblink-launcher`); the same file the other GB-Link web clients carry |

`firmware/tools/host_bridge.py` does the same relay from a terminal and is the reference
the JavaScript was checked against. Three suites run without hardware:

```
node web/tests/run.mjs            # framing, and a session against a stand-in console
node web/tests/trade.mjs          # the trade code against the reference host
node web/tests/session-test.mjs   # a whole trade against a stand-in Switch
```

`run.mjs` checks the framing against vectors from that Python (`tests/make_vectors.py`
regenerates them) and the session logic against stand-ins for the firmware's console:
restarts, a board behind a USB-UART chip whose reset hangs off DTR and RTS, and what a
blank, foreign or crashing chip prints.

`trade.mjs` checks the trading code against the C# host in `host/`, which has made real
trades: the Pokémon data against PKHeX through 93 generated Pokémon, the adapter's
frames through a torn and padded stream, and the trade engine by replaying recorded
scenarios of the host's own engine call by call. It also checks the trade pool's client
against a stand-in for the pool's server (`tests/fake-pool.mjs`, which follows
`serving.py` of [PokemonGB_Online_Trades_and_Battles](https://github.com/Lorenzooone/PokemonGB_Online_Trades_and_Battles)
message for message).
`dotnet run --project host/tests -c Release -- --web-vectors` regenerates
`web/tests/trade-vectors.json` and `web/js/trade/pk3-data.js` from that host.

`session-test.mjs` runs the page's session code against a stand-in board that relays the
Switch's game (`tests/fake-port.mjs`, with the leader's side in `tests/fake-switch.mjs`):
one trade, two trades in a row, leaving without trading, changing which Pokémon is
offered while connected, and leaving the menu and sitting down again. With the stand-in
pool it runs a pool trade, the different Pokémon that follows a trade or a return to the
table, a Pokémon taken from the pool only once the Switch has let the page in, an offer
held back until the page makes it, an empty pool, mail travelling both ways, a Pokémon the pool refuses, and a swap the pool never confirms. It goes through the same `EspDevice` and framing the page uses.
That stand-in board also runs in the browser, so the page itself can be driven without
hardware:

```js
const { FakeBoardPort, installFakeSerial } = await import('/tests/fake-port.mjs');
const party = (await (await fetch('/tests/trade-vectors.json')).json()).engine.hostParty
    .map((hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16)));
const port = new FakeBoardPort({ hostParty: party });
port.onLinkUp = (leader) => leader.greet().sit().open(party);
installFakeSerial(port);
```

then use the page as usual: connect in step 1, then trade under *PC to Switch*.
`port.leader` takes the Switch's next moves, such as `command(0xdddd, 0)` to choose its
first Pokémon (the values are `LINK` in `js/trade/engine.js`), and `port.leaveRoom()`
ends the visit. The stand-in keeps its pace in a tab that is not on show, which the page
it drives does not.

## Third-party code

- `vendor/esptool-js` – [esptool-js](https://github.com/espressif/esptool-js) 0.6.1,
  Apache-2.0
- `vendor/picoflash` – [picoflash](https://github.com/picoflash/picoflash), MIT,
  © Piers Finlayson
