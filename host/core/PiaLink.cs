using System.Security.Cryptography;

namespace Frlg.Trade.Core;

// Pia session plumbing shared by the Sooralated GBA (Simulator) and the GB-Link relay: connection setup,
// the reliable stream, K acknowledgements, host polling credits, and the Sooralated wireless adapter's
// "W" frames (WC connect, WA accepted, WT data, WD disconnect). Subclasses supply and consume the
// adapter payloads.
public abstract class PiaLink : IDisposable
{
    public PiaConnection Connection { get; }
    public ReliableLink Reliable { get; } = new();
    private readonly PiaCrypto crypto;
    private readonly Action<byte[], string> send;
    private readonly string ours, host;
    private readonly Dictionary<int, int> packetIds = [];
    private readonly HashSet<int> seen = [], kInflight = [];
    private readonly Queue<int> seenOrder = [];
    // Reliable frames are handed on in strict sequence order, never arrival order: Pia is selective
    // repeat, so a retransmit arrives late, and the games' link layer validates a +1-mod-8 sequence on
    // the frames it receives — one reordered pair desyncs it permanently.
    private readonly Dictionary<int, byte[]> resequence = [];
    private int nextDeliver = -1;
    public int Reordered { get; private set; }
    public int Resequencing => resequence.Count;
    private readonly HashSet<uint> ackedTimes = [];
    private readonly Queue<uint> timeOrder = [];
    private readonly Queue<(uint Sequence, uint Time)> pendingK = [];
    private bool opened, connectSent, ackOwed;
    private int credits, lastAck = -100;
    protected int tick;
    private ulong nonce = Bin.B64(RandomNumberGenerator.GetBytes(8)) | 1;
    private uint timestamp = 0x362e, kSequence;
    private readonly byte[] connectId = RandomNumberGenerator.GetBytes(2);
    public bool Accepted { get; private set; }
    public bool HostDisconnected { get; private set; }
    public int ReceivedPackets { get; private set; }
    public int DecryptFailures { get; private set; }
    public int SentPackets { get; private set; }
    public event Action<string>? Log;
    protected void Emit(string message) => Log?.Invoke(message);
    protected PiaLink(byte[] ssid, byte[] ourMac, byte[] hostMac, string ourIp, string hostIp, Action<byte[], string> send)
    {
        crypto = new(ssid); ours = ourIp; host = hostIp; this.send = send;
        Connection = new(ourMac, hostMac, ours); connectId[0] |= 1;
    }
    // Whether to send the WC connect request now (the relay waits for the real GBA's connect).
    protected virtual bool WantConnect => true;
    // A WT data frame from the host, host framing: byte 8 = adapter send length, payload from byte 12.
    protected abstract void Deliver(byte[] frame);
    // The next WT frame to send, already wrapped with Rfu.Wrap, or null when nothing is pending.
    protected abstract byte[]? Next();
    // Called on ticks where the host is connected but no send is possible (window full or no credit).
    protected virtual void OnSendSkipped() { }
    protected virtual void AfterTick() { }
    protected uint NextTime() => timestamp++;
    protected int Credits => credits;

    public void Receive(byte[] data, string source)
    {
        if (source != host || data.Length < 29 || !data.AsSpan(0, 4).SequenceEqual(Bin.Hex("32ab9864"))) return;
        byte[] plaintext;
        try { plaintext = crypto.Decrypt(data, source); }
        catch (Org.BouncyCastle.Crypto.InvalidCipherTextException) { DecryptFailures++; return; }
        // Learn station identifiers only after authenticating the packet.
        if (Connection.HostId == 0 && Bin.B16(data, 8) != 0) Connection.HostId = Bin.B16(data, 8);
        int padding = data[5] >> 4, footer = data[12];
        if (padding + footer > plaintext.Length) throw new InvalidDataException("Invalid Pia footer");
        plaintext = plaintext[..(plaintext.Length - padding - footer)];
        byte[] app = (data[5] & 1) != 0 ? crypto.Decompress(plaintext) : plaintext;
        foreach (var m in PiaCrypto.Messages(app))
        {
            if (m.Protocol != 10) { Connection.Feed(m, tick); continue; }
            byte[] p = m.Payload;
            if (p.Length < 8 || Bin.B16(p, 1) > p.Length - 8 || p[7] != 0) throw new InvalidDataException("Invalid reliable frame");
            int seq = Bin.B16(p, 3); var inner = p[8..(8 + Bin.B16(p, 1))];
            if ((p[0] & 1) == 0) { Reliable.Acknowledge(inner, tick * (1000.0 / 59.727)); continue; }
            ackOwed = true;
            if (seen.Add(seq))
            {
                seenOrder.Enqueue(seq); while (seenOrder.Count > 4096) seen.Remove(seenOrder.Dequeue());
                Resequence(seq, inner);
            }
            Reliable.Receive(seq, Bin.B16(p, 5));
        }
        ReceivedPackets++;
    }
    private void Resequence(int seq, byte[] inner)
    {
        if (nextDeliver < 0) nextDeliver = seq;
        if (seq != nextDeliver)
        {
            // Ahead of the gap: hold it until the missing frame is retransmitted. Behind it: already handed on.
            if (Bin.Less(nextDeliver, seq) && ((seq - nextDeliver) & 65535) < 4096) { resequence[seq] = inner; Reordered++; }
            return;
        }
        Hand(inner); nextDeliver = (nextDeliver + 1) & 65535;
        while (resequence.Remove(nextDeliver, out var held)) { Hand(held); nextDeliver = (nextDeliver + 1) & 65535; }
    }
    private void Hand(byte[] inner) { if (inner.Length >= 4 && inner[0] == 0x57) FeedGba(inner); }
    private void FeedGba(byte[] p)
    {
        if (p.Length != Bin.U16(p, 2) + 4) throw new InvalidDataException("Invalid Sooralator frame");
        if (p[1] == 0x41) { Accepted = true; Emit("Host accepted RFU connection"); return; }
        if (p[1] == 0x44) { HostDisconnected = true; return; }
        if (p[1] != 0x54 || p.Length < 9) return;
        uint time = Bin.U32(p, 4);
        if (ackedTimes.Add(time))
        {
            timeOrder.Enqueue(time); while (timeOrder.Count > 8192) ackedTimes.Remove(timeOrder.Dequeue());
            pendingK.Enqueue((++kSequence, time)); while (pendingK.Count > 32) pendingK.Dequeue();
        }
        credits = Math.Min(credits + 1, 2);
        Deliver(p);
    }
    private void SendMessages(IReadOnlyList<PiaMessage> messages, int dst, int src, bool compress = false, bool footer = true, bool establishing = false, int? packet = null, int? footerId = null)
    {
        if (messages.Count == 0) return;
        var body = Bin.Join(messages.Select(PiaCrypto.Message).ToArray());
        bool zipped = compress || body.Length >= 62; if (zipped) body = crypto.Compress(body);
        if (footer) { var id = new byte[2]; Bin.WB16(id, 0, footerId ?? dst); body = Bin.Join(body, id); }
        int padding = (-body.Length) & 15; body = Bin.Pad(body, body.Length + padding, 255);
        int pid = packet ?? packetIds.GetValueOrDefault(dst, 1);
        if (!packet.HasValue) packetIds[dst] = pid == 65535 ? 1 : pid + 1;
        byte[] datagram = crypto.Encrypt(body, ours, dst, src, pid, nonce++, (padding << 4) | (zipped ? 1 : 0) | (establishing ? 2 : 0), footer ? 2 : 0);
        if (nonce == 0) nonce = 1;
        send(datagram, host); SentPackets++;
    }
    private void Batch(List<ReliablePacket> frames)
    {
        foreach (var batch in frames.Chunk(9)) SendMessages(batch.Select(p => new PiaMessage(10, Reliable.Wrap(p), p.Flags == 0 ? 0x40 : null)).ToArray(), Connection.HostId, Connection.OurId);
    }
    public void Tick()
    {
        tick++;
        while (Connection.Rtt.TryDequeue(out double rtt)) Reliable.AddRtt(rtt);
        Connection.Tick(tick);
        foreach (var p in Connection.Outbox) SendMessages([p.Message], p.Dst, p.Src, p.Compress, p.Footer, p.Establishing, p.Packet, p.FooterId);
        Connection.Outbox.Clear();
        if (!Connection.Connected) return;
        double now = tick * (1000.0 / 59.727);
        if (!opened)
        {
            var metadata = Bin.Join(Bin.Hex("4a002a005801004c656166477265656e5f65"), new byte[28]);
            Batch([Reliable.Queue(metadata, 15, now)]); opened = true; return;
        }
        if (!connectSent)
        {
            if (!WantConnect) { Keepalive(now); return; }
            Batch([Reliable.Queue(Bin.Join(Bin.Hex("57430200"), connectId), 7, now)]); connectSent = true; return;
        }
        var batch = Reliable.Retransmit(now, Accepted && !SlowRetransmit ? 1 : 2);
        kInflight.IntersectWith(Reliable.Pending.Keys);
        int middle = 0;
        while (pendingK.Count > 0 && Reliable.Pending.Count < 6 && middle < 3 && kInflight.Count < 3)
        {
            var k = pendingK.Dequeue(); var packet = Reliable.Queue(Rfu.Ack(k.Sequence, ++middle, k.Time), 7, now);
            kInflight.Add(packet.Sequence); batch.Add(packet);
        }
        if (Accepted)
        {
            if (Reliable.Pending.Count < 6 && credits > 0)
            { var p = Next(); if (p != null) { credits--; batch.Add(Reliable.Queue(p, 7, now)); } }
            else OnSendSkipped();
        }
        if (tick - lastAck >= 2 && (ackOwed || Reliable.HasGap))
        { batch.Add(new(0xfff0, 0, Reliable.Ack())); ackOwed = false; lastAck = tick; }
        Batch(batch);
        AfterTick();
    }
    // Retransmission pacing: the Sooralated GBA slows retransmits while seated in the trade room.
    protected virtual bool SlowRetransmit => false;
    // Before WC is sent the host still expects acknowledgements of its stream.
    private void Keepalive(double now)
    {
        var batch = Reliable.Retransmit(now, 2);
        if (tick - lastAck >= 2 && (ackOwed || Reliable.HasGap))
        { batch.Add(new(0xfff0, 0, Reliable.Ack())); ackOwed = false; lastAck = tick; }
        Batch(batch);
    }
    public void Dispose() => crypto.Dispose();
}
