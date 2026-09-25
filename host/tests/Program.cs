using System.Runtime.InteropServices;
using System.Text.Json;
using Frlg.Trade.Core;
using PKHeX.Core;

string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
int checks = 0;
void Check(bool condition, string label) { checks++; if (!condition) throw new Exception(label); }
void Equal(byte[] a, byte[] b, string label) => Check(a.AsSpan().SequenceEqual(b), label);
void Reject(Action action, string label)
{
    try { action(); }
    catch (Exception e) when (e is InvalidDataException or System.Security.Cryptography.CryptographicException or Org.BouncyCastle.Crypto.InvalidCipherTextException)
    { checks++; return; }
    throw new Exception(label);
}

if (args.Length >= 2 && args[0] == "--device")
{
    using var device = new SerialDevice(args[1], CancellationToken.None);
    device.Handshake(); Console.WriteLine($"Device handshake: {device.Model}; bridge firmware {device.Firmware}; protocol v1");
    device.Command("LDN_SCAN 1"); Console.WriteLine("Dynamic scan: OK");
    try { device.Command("LDN_TEST_UNKNOWN"); throw new Exception("Unknown command accepted"); }
    catch (ConnectionException e) when (e.Message.Contains("UNKNOWN_COMMAND")) { Console.WriteLine("Unknown command rejection: OK"); }
    try { device.Command("LDN_CONFIG invalid"); throw new Exception("Invalid config accepted"); }
    catch (ConnectionException) { Console.WriteLine("Invalid config rejection: OK"); }
    device.Command("LDN_SCAN 1"); Console.WriteLine("Command recovery: OK");
    device.Stop(); Console.WriteLine("Stop: OK"); return;
}
// local/party.json (six hex PK3 slots + offered index), else the built-in assets/party.json.
string partyFile = Path.Combine(root, "local/party.json"), builtInParty = Path.Combine(root, "assets/party.json");
(byte[]?[] Slots, int Selected) ReadParty(string file)
{
    var slots = new byte[]?[6];
    using var doc = JsonDocument.Parse(File.ReadAllText(file));
    var entries = doc.RootElement.GetProperty("slots").EnumerateArray().ToArray();
    if (entries.Length != 6) throw new InvalidDataException($"{file} must have six slots");
    for (int i = 0; i < 6; i++) slots[i] = entries[i].ValueKind == JsonValueKind.Null ? null : Convert.FromHexString(entries[i].GetString()!);
    int selected = doc.RootElement.GetProperty("selected").GetInt32();
    if (selected < 0 || selected > 5 || slots[selected] == null) selected = Math.Max(0, Array.FindIndex(slots, x => x != null));
    return (slots, selected);
}
(byte[]?[] Slots, int Selected) LoadParty() => ReadParty(File.Exists(partyFile) ? partyFile : builtInParty);
void SaveParty(byte[]?[] slots, int selected)
{
    Directory.CreateDirectory(Path.GetDirectoryName(partyFile)!);
    string temp = partyFile + ".tmp";
    File.WriteAllText(temp, JsonSerializer.Serialize(new { selected, slots = slots.Select(x => x == null ? null : Convert.ToHexString(x)).ToArray() }));
    File.Move(temp, partyFile, true);
}
string Describe(byte[] data)
{
    var pk = TradeEngine.Parse(data);
    return $"{pk.Nickname} ({SpeciesName.GetSpeciesName(pk.Species, 2)} Lv.{pk.CurrentLevel}, OT {pk.OriginalTrainerName} {pk.TID16:D5})";
}
void PrintParty(byte[]?[] slots, int selected)
{
    Console.WriteLine(File.Exists(partyFile) ? $"Party from {partyFile}:" : "Party from the default assets (no local/party.json yet):");
    for (int i = 0; i < 6; i++) Console.WriteLine($"  {i + 1}: {(slots[i] == null ? "(empty)" : Describe(slots[i]!))}{(i == selected ? "   <- offered" : "")}");
}
int Slot(string text) => int.TryParse(text, out int n) && n is >= 1 and <= 6 ? n - 1 : throw new ArgumentException("Slot must be 1-6");

if (args.Length >= 1 && args[0] == "--party")
{
    var (slots, selected) = LoadParty(); PrintParty(slots, selected); return;
}
if (args.Length >= 3 && args[0] == "--party-set")
{
    var (slots, selected) = LoadParty(); int slot = Slot(args[1]);
    var pk = TradeEngine.Parse(File.ReadAllBytes(args[2])); pk.RefreshChecksum(); slots[slot] = pk.Data.ToArray();
    SaveParty(slots, selected); PrintParty(slots, selected); return;
}
if (args.Length >= 2 && args[0] == "--party-clear")
{
    var (slots, selected) = LoadParty(); int slot = Slot(args[1]); slots[slot] = null;
    if (selected == slot) selected = Math.Max(0, Array.FindIndex(slots, x => x != null));
    SaveParty(slots, selected); PrintParty(slots, selected); return;
}
if (args.Length >= 2 && args[0] == "--party-offer")
{
    var (slots, _) = LoadParty(); int slot = Slot(args[1]);
    if (slots[slot] == null) throw new ArgumentException($"Slot {slot + 1} is empty");
    SaveParty(slots, slot); PrintParty(slots, slot); return;
}
if (args.Length >= 2 && args[0] is "--gblink" or "--leader")
{
    // --gblink <port>: enter wireless mode and print status/telemetry (no beacons); --leader <port>: M1 fake Leader.
    string leaderName = "PC"; byte activity = 4; bool started = false, accept = true; double seconds = args[0] == "--gblink" ? 8 : 600;
    for (int i = 2; i + 1 < args.Length; i++)
    {
        if (args[i] == "--name") leaderName = args[i + 1];
        else if (args[i] == "--activity") activity = Convert.ToByte(args[i + 1], 16);
        else if (args[i] == "--started") started = args[i + 1] == "1";
        else if (args[i] == "--seconds") seconds = double.Parse(args[i + 1]);
        else if (args[i] == "--accept") accept = args[i + 1] == "1";
    }
    using var cancellation = new CancellationTokenSource();
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
    using var gblink = new GbLinkDevice(args[1]);
    new LeaderBridge(gblink, Console.WriteLine).Run(leaderName, activity, started, args[0] == "--leader", accept, seconds, cancellation.Token);
    return;
}
if (args.Length >= 2 && args[0] == "--bridge")
{
    // --bridge <ldn port> [gblink port] [--name LEADER]: real GBA on the GB-Link joins the Switch's
    // Leader room. Omit the GB-Link port when it is wired to the LDN device instead of this PC.
    string? leaderName = null;
    string? gblinkPort = args.Length >= 3 && !args[2].StartsWith("--") ? args[2] : null;
    for (int i = 2; i + 1 < args.Length; i++) if (args[i] == "--name") leaderName = args[i + 1];
    using var cancellation = new CancellationTokenSource();
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
    // Also cancel on SIGTERM, so a restart from a supervisor still runs the shutdown that leaves the
    // Switch's room. Killed without it, our membership lingers and the Switch drops the next join.
    using var term = PosixSignalRegistration.Create(PosixSignal.SIGTERM, context =>
    {
        context.Cancel = true; cancellation.Cancel();
        for (int i = 0; i < 50 && !SwitchBridge.ShutdownComplete; i++) Thread.Sleep(100);
    });
    string path = Path.Combine(root, "local/runs", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "-bridge");
    Console.WriteLine($"run: {path}");
    new SwitchBridge(Console.WriteLine).Run(args[1], gblinkPort, leaderName, path, cancellation.Token);
    return;
}
if (args.Length >= 2 && args[0] == "--replay-bridge")
{
    // Offline check of the relay mappings against a captured session: every host WT frame must map to a HOST_SEND
    // payload of the adapter send length, and every child payload must re-wrap into the captured WT frame.
    string? ssidHex = null; PiaCrypto? crypto = null; int hostFrames = 0, childFrames = 0, mismatches = 0; var lengths = new SortedDictionary<int, int>();
    foreach (string line in File.ReadLines(args[1]))
    {
        using var doc = JsonDocument.Parse(line); var r = doc.RootElement;
        if (r.GetProperty("rec").GetString() == "meta") { ssidHex = r.GetProperty("ssid_hex").GetString(); crypto = new PiaCrypto(Convert.FromHexString(ssidHex!)); continue; }
        if (crypto == null) continue;
        string dir = r.GetProperty("dir").GetString()!; string src = r.GetProperty("src").GetString()!.Split(':')[0]; var data = Convert.FromHexString(r.GetProperty("hex").GetString()!);
        byte[] plain; try { plain = crypto.Decrypt(data, src); } catch (Exception) { continue; }
        plain = plain[..(plain.Length - (data[5] >> 4) - data[12])]; byte[] app = (data[5] & 1) != 0 ? crypto.Decompress(plain) : plain;
        foreach (var m in PiaCrypto.Messages(app))
        {
            if (m.Protocol != 10) continue; var q = m.Payload; if (q.Length < 8 || (q[0] & 1) == 0) continue;
            var inner = q[8..Math.Min(q.Length, 8 + Bin.B16(q, 1))]; if (inner.Length < 12 || inner[0] != 0x57 || inner[1] != 0x54) continue;
            if (dir == "in")
            {
                var payload = RelayLink.HostPayloadOf(inner); hostFrames++; lengths[payload.Length] = lengths.GetValueOrDefault(payload.Length) + 1;
                var frame = Rfu1.HostSendFrame(payload);
                if ((Bin.B32(frame, 8) & 0x7F) != payload.Length || !frame.AsSpan(12, payload.Length).SequenceEqual(payload)) mismatches++;
            }
            else
            {
                int blen = inner[9]; var payload = inner[12..Math.Min(inner.Length, 12 + blen)]; childFrames++;
                var rewrapped = Rfu.Wrap(payload, Bin.U32(inner, 4));
                if (!rewrapped.AsSpan().SequenceEqual(inner)) { mismatches++; if (mismatches <= 5) Console.WriteLine($"child mismatch: captured {Convert.ToHexString(inner)} rewrapped {Convert.ToHexString(rewrapped)}"); }
            }
        }
    }
    Console.WriteLine($"host WT frames: {hostFrames} (adapter lengths: {string.Join(", ", lengths.Select(k => $"{k.Key}B x{k.Value}"))}); child WT frames: {childFrames}; mismatches: {mismatches}");
    return;
}
if (args.Length >= 2 && args[0] == "--decode-pia")
{
    // Offline decoder for a session's pia.jsonl: decrypts every datagram with the real PiaCrypto and prints
    // the reliable-stream frames ("W" frames are the Sooralated wireless-adapter traffic).
    int limit = args.Length >= 3 ? int.Parse(args[2]) : int.MaxValue; string? ssidHex = null; PiaCrypto? crypto = null; int shown = 0;
    var kinds = new Dictionary<string, int>();
    foreach (string line in File.ReadLines(args[1]))
    {
        using var doc = JsonDocument.Parse(line); var r = doc.RootElement;
        if (r.GetProperty("rec").GetString() == "meta") { ssidHex = r.GetProperty("ssid_hex").GetString(); crypto = new PiaCrypto(Convert.FromHexString(ssidHex!)); continue; }
        if (crypto == null || r.GetProperty("rec").GetString() != "pkt") continue;
        string dir = r.GetProperty("dir").GetString()!; double t = r.GetProperty("t").GetDouble();
        string src = r.GetProperty("src").GetString()!.Split(':')[0]; var data = Convert.FromHexString(r.GetProperty("hex").GetString()!);
        byte[] plain;
        try { plain = crypto.Decrypt(data, src); } catch (Exception e) { Console.WriteLine($"{t,8:F3} {dir,-3} decrypt failed: {e.GetType().Name}"); continue; }
        int padding = data[5] >> 4, footer = data[12]; plain = plain[..(plain.Length - padding - footer)];
        byte[] app = (data[5] & 1) != 0 ? crypto.Decompress(plain) : plain;
        foreach (var m in PiaCrypto.Messages(app))
        {
            if (m.Protocol != 10) { kinds[$"pia{m.Protocol}"] = kinds.GetValueOrDefault($"pia{m.Protocol}") + 1; continue; }
            var q = m.Payload; if (q.Length < 8) continue;
            int flags = q[0], len = Bin.B16(q, 1), seq = Bin.B16(q, 3), low = Bin.B16(q, 5); var inner = q[8..Math.Min(q.Length, 8 + len)];
            string kind = (flags & 1) == 0 ? "ACK" : inner.Length >= 2 && inner[0] == 0x57 ? "W" + (char)inner[1] : $"data{(inner.Length >= 2 ? Convert.ToHexString(inner[..2]) : "")}";
            kinds[kind] = kinds.GetValueOrDefault(kind) + 1;
            if (shown++ >= limit) continue;
            if (kind.StartsWith("W") && inner.Length >= 12)
                Console.WriteLine($"{t,8:F3} {dir,-3} seq={seq:x4} {kind} len={Bin.U16(inner, 2)} time={Bin.U32(inner, 4):x8} hdr={Convert.ToHexString(inner[8..12])} payload={Convert.ToHexString(inner[12..])}");
            else Console.WriteLine($"{t,8:F3} {dir,-3} seq={seq:x4} {kind} flags={flags:x2} low={low:x4} {Convert.ToHexString(inner)}");
        }
    }
    Console.WriteLine("frame kinds: " + string.Join(", ", kinds.OrderByDescending(k => k.Value).Select(k => $"{k.Key}={k.Value}")));
    return;
}
if (args.Length >= 2 && args[0] == "--live")
{
    var (party, offered) = LoadParty();
    for (int i = 2; i + 1 < args.Length; i++) if (args[i] == "--offer") offered = Slot(args[i + 1]);
    if (party[offered] == null) throw new ArgumentException($"Slot {offered + 1} is empty");
    if (party.Count(x => x != null) < 2) throw new ArgumentException("The party needs at least two Pokémon; add one with --party-set <slot> <file.pk3>");
    PrintParty(party, offered);
    using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(8));
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
    string path = Path.Combine(root, "local/runs", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "-native-console");
    Directory.CreateDirectory(path); File.WriteAllBytes(Path.Combine(path, "offered.pk3"), party[offered]!);
    new TradeSession(e =>
    {
        var message = JsonSerializer.SerializeToElement(e); string kind = message.GetProperty("event").GetString()!;
        if (kind is "log" or "phase") Console.WriteLine(message.GetProperty("message").GetString());
        else Console.WriteLine(kind);
        if (kind == "received")
        {
            // Like the desktop app: the received Pokémon takes the offered slot, so the next trade sends it back.
            int slot = message.GetProperty("slot").GetInt32(); party[slot] = Convert.FromHexString(message.GetProperty("pk3").GetString()!);
            SaveParty(party, offered); Console.WriteLine($"Party slot {slot + 1} is now {Describe(party[slot]!)}; saved to {partyFile}");
        }
    }).Run(args[1], party, offered, path, cancellation.Token);
    return;
}

foreach (int size in new[] { 0, 1, 254, 255, 1476, 4080 })
{
    var payload = Enumerable.Range(0, size).Select(i => (byte)i).ToArray();
    var frame = new SerialFrame(4, 123, 456, payload); var bytes = SerialCodec.Encode(frame);
    var read = SerialCodec.Decode(bytes.AsSpan(0, bytes.Length - 1));
    Check(read != null && read.Session == 456 && read.Request == 123, "Serial header roundtrip"); Equal(payload, read!.Payload, "Serial payload roundtrip");
    bytes[bytes.Length / 2] ^= 0x22; Check(SerialCodec.Decode(bytes.AsSpan(0, bytes.Length - 1)) == null, "CRC rejects damaged frames");
}
Check(Bin.Crc32(System.Text.Encoding.ASCII.GetBytes("123456789")) == 0xcbf43926, "Standard CRC32 vector");
Reject(() => SerialCodec.Encode(new(1, 1, 1, new byte[4081])), "Oversized serial payload accepted");
Check(SerialCodec.Decode([0]) == null && SerialCodec.Decode([255, 1]) == null, "Malformed COBS rejected");
var sender = new ReliableLink { Next = 65534, Low = 65534 };
var receiver = new ReliableLink { ReceiveNext = 65534 };
foreach (int expected in new[] { 65534, 65535, 0 }) Check(sender.Queue([1], 7, 0).Sequence == expected, "Reliable sequence wraps");
receiver.Receive(0); receiver.Receive(0); receiver.Receive(65535);
Check(receiver.ReceiveNext == 65534 && receiver.HasGap, "Gap and duplicate do not advance receive cursor");
for (int i = 0; i < 3; i++) sender.Acknowledge(receiver.Ack(), 10);
Check(sender.Pending.Count == 3 && sender.Pending[0].Acked && sender.Pending[65535].Acked, "Selective ACK retains missing head");
var resent = sender.Retransmit(11, 2);
Check(resent.Count == 1 && resent[0].Sequence == 65534, "Three gap ACKs retransmit only missing packet");
receiver.Receive(65534); receiver.Receive(65535);
Check(receiver.ReceiveNext == 1 && !receiver.HasGap, "Contiguous receive catches up across wrap");
sender.Acknowledge(receiver.Ack(), 20);
Check(sender.Pending.Count == 0 && sender.SendLow == 1, "Cumulative ACK drains send window");
var shifted = new ReliableLink();
shifted.Receive(0x12, 0x11);
Check(shifted.ReceiveNext == 0x11 && shifted.HasGap, "Peer send-window base preserves missing first packet");
shifted.Receive(0x11, 0x11);
Check(shifted.ReceiveNext == 0x13 && !shifted.HasGap && Bin.B16(shifted.Ack(), 2) == 0x13, "Non-default peer sequence advances cumulative ACK");
shifted.Receive(0x11, 0x11);
shifted.Receive(0x15, 0x15);
Check(shifted.ReceiveNext == 0x13 && shifted.HasGap, "Later window bases and duplicates cannot reset receive state");
shifted.Receive(0x13, 0x13); shifted.Receive(0x14, 0x14);
Check(shifted.ReceiveNext == 0x16 && !shifted.HasGap, "Missing packets still close later receive gaps");
var shiftedWrap = new ReliableLink();
shiftedWrap.Receive(0, 65535); shiftedWrap.Receive(65535, 65535);
Check(shiftedWrap.ReceiveNext == 1 && !shiftedWrap.HasGap, "Peer-selected receive base wraps correctly");
sender.Queue([2], 7, 100);
Check(sender.Retransmit(100 + sender.Rto - 1, 1).Count == 0, "No premature retransmit");
Check(sender.Retransmit(100 + sender.Rto + 1, 1).Count == 1, "RTO recovers unacknowledged packet");
string temp = Path.Combine(Path.GetTempPath(), "frlg-native-test-" + Guid.NewGuid());
Directory.CreateDirectory(temp);
try
{
    string exe = Path.Combine(temp, "app"), home = Path.Combine(temp, "home");
    Directory.CreateDirectory(exe); Directory.CreateDirectory(Path.Combine(home, ".switch"));
    try { KeyFile.Find(exe, home); throw new Exception("Missing keys accepted"); } catch (MissingKeysException) { checks++; }
    string homeFile = Path.Combine(home, ".switch", "prod.keys"), exeFile = Path.Combine(exe, "prod.keys");
    File.WriteAllText(homeFile, "placeholder"); Check(KeyFile.Find(exe, home) == homeFile, "Home fallback");
    File.WriteAllText(exeFile, "invalid"); Check(KeyFile.Find(exe, home) == exeFile, "Exe takes precedence");
    try { new KeyFile(KeyFile.Find(exe, home)); throw new Exception("Invalid keys accepted"); } catch (InvalidDataException) { checks++; }
    using var vectors = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "host/tests/fixtures/vectors.json")));
    var v = vectors.RootElement;
    File.WriteAllLines(exeFile, v.GetProperty("keys").EnumerateObject().Select(p => p.Name + " = " + p.Value.GetString()));
    var keys = new KeyFile(exeFile);
    {
        // KeyFile.Import
        string dump = Path.Combine(temp, "dump.keys"), setup = Path.Combine(temp, "setup");
        File.WriteAllLines(dump, File.ReadAllLines(exeFile).Prepend("# a console's key file").Append("header_key = " + new string('a', 64)).Append("titlekek_source = " + new string('b', 32)));
        var imported = KeyFile.Import(dump, setup);
        string kept = File.ReadAllText(Path.Combine(setup, "prod.keys"));
        Check(KeyFile.Locate(setup, home) == imported.SourcePath && KeyFile.Used.Where(name => v.GetProperty("keys").TryGetProperty(name, out _)).All(kept.Contains),
            "Imported key file is found");
        Check(!kept.Contains("header_key") && !kept.Contains("titlekek_source") && kept.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length <= KeyFile.Used.Length,
            "Import keeps only the used entries");
        Equal(imported.Get("aes_kek_generation_source"), keys.Get("aes_kek_generation_source"), "Imported keys read back unchanged");
        if (!OperatingSystem.IsWindows())
            Check(File.GetUnixFileMode(Path.Combine(setup, "prod.keys")) == (UnixFileMode.UserRead | UnixFileMode.UserWrite), "Imported key file has mode 600");
        string bad = Path.Combine(temp, "bad.keys"), untouched = Path.Combine(temp, "untouched");
        File.WriteAllText(bad, "master_key_00 = " + new string('c', 32) + "\n");
        try { KeyFile.Import(bad, untouched); throw new Exception("Unusable key file imported"); } catch (InvalidDataException) { checks++; }
        Check(!File.Exists(Path.Combine(untouched, "prod.keys")), "Failed import writes nothing");
    }
    foreach (var a in v.GetProperty("advertisements").EnumerateArray())
    {
        var raw = Bin.Hex(a.GetProperty("raw").GetString()!); var network = LdnKeys.Decode(keys, raw, Bin.Hex("020000000001"), 1);
        Check(network.Protocol == a.GetProperty("protocol").GetInt32() && network.AppVersion == 88 && network.Members.Count == 1, "LDN advertisement fields");
        Equal(new LdnKeys(keys, network.Protocol).Data(network), Bin.Hex(a.GetProperty("dataKey").GetString()!), "LDN data key matches reference");
        raw[^1] ^= 1;
        Reject(() => LdnKeys.Decode(keys, raw, Bin.Hex("020000000001"), 1), "Tampered LDN advertisement accepted");
        if (network.Protocol == 3)
        {
            var derived = new LdnKeys(keys, 3); var auth = new LdnAuthentication(network, derived);
            byte[] header = auth.Request[6..78], requestKey = derived.Derive(header[56..72]);
            var plain = Bin.Gcm(requestKey, header[..12], Bin.Join(auth.Request[94..], auth.Request[78..94]), header, false);
            var response = new byte[388];
            plain.AsSpan(164, 16).CopyTo(response.AsSpan(188, 16));
            System.Security.Cryptography.HMACSHA256.HashData(LdnKeys.ChallengeKey, response.AsSpan(180)).CopyTo(response, 136);
            header[1] = 132; header[4] = 1; header[3] = 1;
            byte[] WrapResponse(byte[] payload)
            {
                var encrypted = Bin.Gcm(requestKey, header[..12], payload, header, true);
                return Bin.Join(Bin.Hex("0022aa010200"), header, encrypted[^16..], encrypted[..^16]);
            }
            var valid = WrapResponse(response); auth.Accept(valid); checks++;
            var damaged = (byte[])valid.Clone(); damaged[78] ^= 1;
            Reject(() => auth.Accept(damaged), "Tampered authentication tag accepted");
            damaged = (byte[])valid.Clone(); damaged[46] ^= 1;
            Reject(() => auth.Accept(damaged), "Foreign authentication session accepted");
            response[188] ^= 1;
            System.Security.Cryptography.HMACSHA256.HashData(LdnKeys.ChallengeKey, response.AsSpan(180)).CopyTo(response, 136);
            Reject(() => auth.Accept(WrapResponse(response)), "Validly signed but foreign challenge accepted");
        }
    }
    Equal(Rfu.PlayerBlock(), Bin.Hex(v.GetProperty("player").GetString()!), "LinkPlayer fixture");
    Equal(Rfu.TrainerCard(), Bin.Hex(v.GetProperty("card").GetString()!), "Trainer card fixture");
    var ni = Rfu.GameData(); foreach (var n in v.GetProperty("ni").EnumerateArray()) Equal(ni.Dequeue(), Bin.Hex(n.GetString()!), "NI fixture");
    var party = new byte[]?[] { File.ReadAllBytes(Path.Combine(root, "host/tests/fixtures/mewtwo.pk3")), File.ReadAllBytes(Path.Combine(root, "host/tests/fixtures/deoxys.pk3")), null, null, null, null };
    for (int i = 0; i < 2; i++) Equal(TradeEngine.ToWire(party[i]!), Bin.Hex(v.GetProperty("party")[i].GetString()!), "PK3 wire encoding fixture");
    using var crypto = new PiaCrypto(Enumerable.Range(0, 16).Select(i => (byte)i).ToArray());
    using (var sim = new Simulator(Enumerable.Range(0, 16).Select(i => (byte)i).ToArray(),
        Bin.Hex("020000000002"), Bin.Hex("020000000001"), "169.254.1.2", "169.254.1.1", new TradeEngine(party, 1), (_, _) => { }))
    {
        var peer = new ReliableLink { Next = 0x11, Low = 0x11 };
        var first = peer.Queue([0, 0], 15, 0);
        var message = PiaCrypto.Message(new(10, peer.Wrap(first)));
        var datagram = crypto.Encrypt(message, "169.254.1.1", 0xc493, 0x7620, 1, 1, 0, 0);
        sim.Receive(datagram, "169.254.1.1");
        Check(sim.ReceivedPackets == 1 && sim.Reliable.ReceiveNext == 0x12 && !sim.Reliable.HasGap,
            "Authenticated Pia packet initializes peer sequence instead of waiting for fff0");
        sim.Receive(datagram, "169.254.1.1");
        Check(sim.Reliable.ReceiveNext == 0x12, "Retransmitted opening packet does not reset peer sequence");
    }
    foreach (var row in v.GetProperty("pia").EnumerateArray())
    {
        var plain = Bin.Hex(row.GetProperty("plain").GetString()!); var encrypted = Bin.Hex(row.GetProperty("encrypted").GetString()!);
        Equal(crypto.Decrypt(encrypted, "169.254.1.1"), plain, "Pia GCM8 decryption fixture");
        Equal(crypto.Encrypt(plain, "169.254.1.1", 0x7620, 0xc493, 0, (ulong)plain.Length + 1, 0x50, 2), encrypted, "Pia GCM8 encryption fixture");
        Equal(crypto.Decompress(Bin.Hex(row.GetProperty("compressed").GetString()!)), plain, "Zstd decompression fixture");
        Equal(crypto.Decompress(crypto.Compress(plain)), plain, "Native zstd roundtrip");
        encrypted[21] ^= 1;
        Reject(() => crypto.Decrypt(encrypted, "169.254.1.1"), "Tampered Pia tag accepted");
    }
    string path = Path.Combine(root, "local/native-tests/engine.json");
    if (File.Exists(path))
    {
        using var records = JsonDocument.Parse(File.ReadAllText(path)); var engine = new TradeEngine(party, 1); int index = 0;
        foreach (var record in records.RootElement.EnumerateArray())
        {
            index++;
            if (record.TryGetProperty("slots", out var slots)) engine.Feed(slots.EnumerateArray().Select(s => Bin.Hex(s.GetString()!)).ToArray());
            else if (record.TryGetProperty("tick", out var words))
            {
                var actual = engine.Tick(); var expected = words.EnumerateArray().Select(w => w.GetInt32()).ToArray();
                Check(actual.SequenceEqual(expected), $"Trade engine differs at step {index}: {string.Join(',', actual)} expected {string.Join(',', expected)}");
            }
            else engine.Sit();
        }
        Console.WriteLine($"Trade engine replay: {index} steps, commits={engine.Commits}");
    }
    else Console.WriteLine("Private trade replay skipped: local/native-tests/engine.json is not present");
}
finally { Directory.Delete(temp, true); }

// Built-in party (assets/party.json)
{
    var (slots, offered) = ReadParty(builtInParty);
    Check(slots.Count(x => x != null) >= 2 && slots[offered] != null, "Built-in party can start a trade");
    foreach (var slot in slots) if (slot != null) { TradeEngine.Parse(slot); checks++; }
    _ = new TradeEngine(slots, offered); checks++;
}

// Trade menu: cancel, live offer, repeated trades
{
    byte[] Mon(string file, string? nickname = null)
    {
        var pk = TradeEngine.Parse(File.ReadAllBytes(Path.Combine(root, "host/tests/fixtures", file)));
        if (nickname != null) { pk.Nickname = nickname; pk.RefreshChecksum(); }
        return pk.Data.ToArray();
    }
    var mons = new byte[]?[] { Mon("mewtwo.pk3"), Mon("deoxys.pk3"), null, null, null, null };
    byte[] hostMon = TradeEngine.ToWire(Mon("mewtwo.pk3", "HOSTMON")), hostOther = TradeEngine.ToWire(Mon("deoxys.pk3", "HOSTTWO"));

    var bench = new EngineBench(mons, 1, hostMon, hostOther);
    Check(bench.Sent.SequenceEqual([(TradeEngine.Ready, 1)]), "Menu opens with Ready for the offered slot");

    bench.Host(TradeEngine.Cancel); bench.Host(TradeEngine.PlayerCancel); bench.Run(90);
    Check(bench.Engine.Declining && bench.Sent[^1] == (TradeEngine.Cancel, 0) && bench.Sent.Count == 2,
        "Leader Cancel is answered with Cancel");
    bench.Host(TradeEngine.PartnerCancel); bench.Run(90);
    Check(!bench.Engine.Declining && bench.Sent[^1] == (TradeEngine.Ready, 1) && bench.Sent.Count == 3,
        "PartnerCancel restores the offer");

    bench.Host(TradeEngine.SetMons, 2); bench.Run(30);
    Check(bench.Sent[^1] == (TradeEngine.InitBlock, 0), "SetMons is confirmed with InitBlock");
    bench.Host(TradeEngine.ReadyCancel); bench.Host(TradeEngine.PlayerCancel); bench.Run(90);
    Check(!bench.Engine.Declining && bench.Sent[^1] == (TradeEngine.Ready, 1), "ReadyCancel from the leader keeps the offer");

    bench.Engine.Decline(); bench.Run(40);
    Check(bench.Engine.Declining && bench.Sent[^1] == (TradeEngine.Cancel, 0), "Decline sends Cancel over a standing Ready");
    bench.Host(TradeEngine.Cancel); bench.Host(TradeEngine.BothCancel); bench.Run(5);
    Check(bench.Engine.State == 6, "BothCancel ends the menu");

    var race = new EngineBench(mons, 0, hostMon, hostOther);
    race.Engine.Decline(); race.Host(TradeEngine.SetMons, 1); race.Run(30);
    Check(race.Sent.Contains((TradeEngine.ReadyCancel, 0)) && !race.Sent.Contains((TradeEngine.InitBlock, 0)),
        "Decline racing SetMons answers ReadyCancel");

    // Live offer
    var live = new EngineBench(mons, 1, hostMon, hostOther);
    Check(!live.Engine.Offer(3) && live.Engine.Offered == 1, "Empty slot is not offered");
    Check(live.Engine.Offer(0), "Offer accepts an occupied slot"); live.Run(40);
    Check(live.Sent.SequenceEqual([(TradeEngine.Ready, 1), (TradeEngine.Ready, 0)]), "Offer re-sends Ready with the new cursor");
    live.Host(TradeEngine.SetMons, 0); live.Run(30);
    Check(live.Engine.Offer(1), "Offer during confirmation is accepted"); live.Run(40);
    Check(live.Sent[^1] == (TradeEngine.InitBlock, 0), "Offer during confirmation sends nothing");
    live.Host(TradeEngine.InitBlock); live.Host(TradeEngine.Start); live.Run(live.Engine.AnimationFrames + 40);
    live.Host(TradeEngine.ReadyFinish); live.Host(TradeEngine.ConfirmFinish); live.Run(5);
    Check(live.Received.SequenceEqual([("HOSTMON", 0)]) && live.Engine.Offered == 1, "Commit uses the sent cursor; the later choice stays offered");

    // Trade and trade back in one connection
    var back = new EngineBench(mons, 1, hostMon, hostOther);
    back.Trade(0);
    Check(back.Received.SequenceEqual([("HOSTMON", 1)]) && back.Engine.Commits == 1, "Commit stores the received Pokémon in the traded slot");
    byte[] given = TradeEngine.ToWire(mons[1]!);
    back.Open(given, hostOther);
    Check(back.Blocks.Last(b => b.Length == 204 && b.Take(200).Any(x => x != 0)).AsSpan(100, 100).SequenceEqual(hostMon),
        "Re-sent party carries the received Pokémon");
    Check(!back.Engine.Declining && back.Sent[^1] == (TradeEngine.Ready, 1) && !back.Sent.Contains((TradeEngine.Cancel, 0)),
        "After a trade the menu opens with Ready, not Cancel");
    back.Trade(0);
    Check(back.Received.Count == 2 && back.Received[1] == (TradeEngine.Parse(mons[1]!).Nickname, 1) && back.Engine.Commits == 2,
        "Second trade in one connection commits");
    back.Open(hostMon, hostOther);
    back.Host(TradeEngine.Cancel); back.Host(TradeEngine.PlayerCancel); back.Run(90);
    Check(back.Engine.Declining && back.Sent[^1] == (TradeEngine.Cancel, 0), "Leader Cancel after trades is answered with Cancel");
    back.Host(TradeEngine.Cancel); back.Host(TradeEngine.BothCancel); back.Run(5);
    Check(back.Engine.State == 6, "BothCancel after trades ends the menu");

    var again = new EngineBench(mons, 1, hostMon, hostOther);
    again.Trade(1); again.Open(hostMon, given);
    Check(again.Sent[^1] == (TradeEngine.Ready, 1), "After a trade the traded slot stays offered");
    Check(again.Engine.Offer(0), "Offer after a trade is accepted"); again.Run(40);
    Check(!again.Engine.Declining && again.Sent[^1] == (TradeEngine.Ready, 0), "Offer after a trade re-sends Ready");
    again.Engine.Decline(); again.Run(40);
    Check(again.Sent[^1] == (TradeEngine.Cancel, 0), "Decline after a trade sends Cancel");
}

// ProgramDirectory
Check(ProgramDirectory.Find("/opt/frlg/", null, null) == "/opt/frlg/", "Program directory without AppImage");
Check(ProgramDirectory.Find("/tmp/.mount_FRLGab/usr/bin/", "/home/ash/Apps/FRLG.AppImage", "/tmp/.mount_FRLGab") == "/home/ash/Apps",
    "Program directory of an AppImage is the AppImage's folder");
Check(ProgramDirectory.Find("/opt/frlg/", "/home/ash/Apps/Other.AppImage", "/tmp/.mount_Otherx") == "/opt/frlg/",
    "Inherited AppImage variables are ignored");

// Handshake against FakeBoard
{
    var board = new FakeBoard { BootMs = 1300 };
    using var device = new SerialDevice(board, CancellationToken.None);
    device.Handshake();
    Check(device.Model == "esp32s3" && device.Firmware == "2.0.0", "Handshake retries while the board boots");
    Check(board.Commands.SequenceEqual(["LDN_HELLO", "LDN_BEGIN", "LDN_INFO", "LDN_BRIDGE_STOP"]) && !board.BridgeRunning,
        "Handshake stops the firmware bridge");
    device.Command("LDN_SCAN 1");
    device.Stop();
    Check(board.BridgeRunning && board.Commands.TakeLast(2).SequenceEqual(["LDN_STOP", "LDN_BRIDGE_START"]), "Stop restarts the firmware bridge");
}
{
    using var device = new SerialDevice(new FakeBoard { Version = null }, CancellationToken.None);
    try { device.Handshake(); throw new Exception("Pre-2.0 firmware accepted"); }
    catch (ConnectionException e) when (e.Message.Contains("before 2.0")) { checks++; }
}
{
    using var device = new SerialDevice(new FakeBoard { BootMs = 60000 }, CancellationToken.None);
    var waited = System.Diagnostics.Stopwatch.StartNew();
    try { device.Handshake(); throw new Exception("Silent port accepted"); }
    catch (ConnectionException e) when (e.Message.Contains("No bridge firmware answered")) { checks++; }
    Check(waited.Elapsed.TotalSeconds is > 7 and < 12, "Silent port times out after about 8 s");
}
Console.WriteLine($"PASS {checks} checks");
