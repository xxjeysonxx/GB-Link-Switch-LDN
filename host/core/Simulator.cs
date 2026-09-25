namespace Frlg.Trade.Core;

// Sooralated GBA running FireRed: the librfu name exchange followed by the trade engine, over PiaLink.
public sealed class Simulator : PiaLink
{
    public TradeEngine Engine { get; }
    private readonly Queue<byte[]> ni = Rfu.GameData();
    private byte[]? niAck, emittedAck;
    private bool uni, niDone, seated, exiting;
    private int tag, heldCount, heldKey;
    public Simulator(byte[] ssid, byte[] ourMac, byte[] hostMac, string ourIp, string hostIp, TradeEngine engine, Action<byte[], string> send)
        : base(ssid, ourMac, hostMac, ourIp, hostIp, send) => Engine = engine;
    protected override bool SlowRetransmit => Engine.InSeatPhase;
    protected override void Deliver(byte[] p)
    {
        int length = p[8]; var slots = new List<byte[]>();
        if (length > 1)
        {
            if (length < 3 || 12 + length > p.Length) throw new InvalidDataException("Invalid parent LLSF");
            int f = p[12] | p[13] << 8 | p[14] << 16, state = (f >> 14) & 15;
            if (state == 4)
            {
                uni = true;
                for (int o = 15; o + 14 <= 12 + length; o += 14) slots.Add(p[o..(o + 14)]);
            }
            else if (((f >> 13) & 1) == 0)
            {
                if (state == 2 && length > 3 && p[15] != 5) throw new ConnectionException($"Host rejected RFU join: {p[15]}");
                if (state is 1 or 2 or 3) niAck = Rfu.Ni(state, (f >> 11) & 3, (f >> 9) & 3, 1, []);
            }
        }
        Engine.Feed(slots);
    }
    protected override byte[]? Next()
    {
        if (!niDone)
        {
            if (ni.TryDequeue(out var slot)) return Rfu.Wrap(slot, NextTime());
            if (niAck != null && (emittedAck == null || !niAck.AsSpan().SequenceEqual(emittedAck)))
            { emittedAck = niAck; return Rfu.Wrap(niAck, NextTime()); }
            if (!uni) return null;
            niDone = true; Emit("RFU NI complete");
        }
        int[] words = Engine.Tick();
        if (words[0] == 0 && Engine.Established && Engine.HostInSeat && Engine.InSeatPhase)
        {
            heldCount = (heldCount + 1) & 255; words = Rfu.Words(0xbe00, (heldCount << 8) | (heldKey == 0 ? 17 : heldKey)); heldKey = 0;
        }
        var command = new byte[16]; Bin.W16(command, 0, 0x100e);
        if (words[0] != 0) { words[0] |= tag << 5; tag = (tag + 1) & 7; for (int i = 0; i < 7; i++) Bin.W16(command, 2 + i * 2, words[i]); }
        return Rfu.Wrap(command, NextTime());
    }
    protected override void OnSendSkipped() => Engine.PollSendDone();
    protected override void AfterTick()
    {
        if (!seated && Engine.Established && Engine.HostReady && Engine.InSeatPhase)
        { seated = true; Engine.Sit(); heldKey = 22; Emit("Taking the right seat"); }
        if (Engine.HostExiting && !exiting) { exiting = true; heldKey = 23; Emit("Responding to host exit"); }
    }
}
