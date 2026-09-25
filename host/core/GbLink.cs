using System.IO.Ports;

namespace Frlg.Trade.Core;

// GB-Link adapter over its CDC serial channel: "GB" | channel | length (LE16) | payload, with channels
// 0 = command, 1 = data, 2 = status. In wireless mode (0x05) the data channel carries the RFU1 frame
// stream in 64-byte chunks; shorter data frames are the firmware's telemetry.
public sealed class GbLinkDevice : IDisposable
{
    public const byte ChannelCommand = 0, ChannelData = 1, ChannelStatus = 2;
    public const byte SetMode = 0x00, Cancel = 0x01, GetFirmwareInfo = 0x0F, ModeWireless = 0x05;
    private readonly SerialPort? port;
    private readonly Action<byte[]>? tunnel;
    private readonly Thread? reader;
    private readonly object writeLock = new();
    private readonly Queue<byte[]> data = [];
    private readonly Queue<ushort> statuses = [];
    private volatile bool running = true;
    public int BadFrames { get; private set; }
    public GbLinkDevice(string name)
    {
        port = new(name, 115200) { DtrEnable = false, RtsEnable = false, ReadTimeout = 50, WriteTimeout = 2000, ReadBufferSize = 65536 };
        port.Open(); port.DiscardInBuffer();
        reader = new(ReadLoop) { IsBackground = true, Name = "gblink-reader" }; reader.Start();
    }
    // Tunnelled: the adapter is wired to the LDN device rather than this PC, so the same frames
    // ride that link instead of a port of our own. Frames arrive by Feed, not a reader thread.
    public GbLinkDevice(Action<byte[]> write) => tunnel = write;
    private int state, channel, length, position;
    private readonly byte[] payload = new byte[65536];
    // Frame reassembly, driven either by our own reader thread or by whoever owns the tunnel.
    public void Feed(ReadOnlySpan<byte> bytes)
    {
        foreach (byte b in bytes)
        {
            switch (state)
            {
                case 0: if (b == (byte)'G') state = 1; break;
                case 1: state = b == (byte)'B' ? 2 : b == (byte)'G' ? 1 : 0; break;
                case 2: channel = b; state = 3; break;
                case 3: length = b; state = 4; break;
                case 4:
                    length |= b << 8; position = 0;
                    if (length > payload.Length) { BadFrames++; state = 0; }
                    else if (length == 0) { Dispatch(channel, []); state = 0; }
                    else state = 5;
                    break;
                case 5:
                    payload[position++] = b;
                    if (position == length) { Dispatch(channel, payload[..length]); state = 0; }
                    break;
            }
        }
    }
    private void ReadLoop()
    {
        var chunk = new byte[4096];
        while (running)
        {
            // A port being torn down or re-enumerated can report a negative count; treat anything
            // non-positive as "nothing to read" rather than handing it to Read.
            int available, count;
            try { available = port!.BytesToRead; } catch (Exception) { break; }
            if (available <= 0) { Thread.Sleep(1); continue; }
            try { count = port.Read(chunk, 0, Math.Min(available, chunk.Length)); }
            catch (TimeoutException) { continue; }
            catch (Exception) { break; }
            if (count <= 0) continue;
            Feed(chunk.AsSpan(0, count));
        }
    }
    private void Dispatch(int channel, byte[] payload)
    {
        lock (data)
        {
            if (channel == ChannelStatus && payload.Length >= 2) statuses.Enqueue((ushort)(payload[0] | payload[1] << 8));  // little-endian LinkStatus
            else if (channel == ChannelData) data.Enqueue(payload);
        }
    }
    public void Send(byte channel, ReadOnlySpan<byte> payload)
    {
        var frame = new byte[5 + payload.Length];
        frame[0] = (byte)'G'; frame[1] = (byte)'B'; frame[2] = channel; frame[3] = (byte)payload.Length; frame[4] = (byte)(payload.Length >> 8);
        payload.CopyTo(frame.AsSpan(5));
        lock (writeLock) { if (tunnel != null) tunnel(frame); else port!.Write(frame, 0, frame.Length); }
    }
    public void Command(params byte[] bytes) => Send(ChannelCommand, bytes);
    // The firmware's data receive buffer is one 64-byte transport chunk; its RFU1 parser reassembles across chunks.
    public void SendData(ReadOnlySpan<byte> bytes)
    { for (int o = 0; o < bytes.Length; o += 64) Send(ChannelData, bytes.Slice(o, Math.Min(64, bytes.Length - o))); }
    public bool TryDequeueData(out byte[] frame) { lock (data) return data.TryDequeue(out frame!); }
    public bool TryDequeueStatus(out ushort status) { lock (data) return statuses.TryDequeue(out status); }
    // Set when tunnelled: frames only arrive while the link's owner is pumped, so any wait here
    // has to drive it rather than sleeping through the reply.
    public Action? Pump { get; set; }
    public byte[]? FirmwareInfo(double timeout = 1.5)
    {
        Command(GetFirmwareInfo); var watch = System.Diagnostics.Stopwatch.StartNew();
        while (watch.Elapsed.TotalSeconds < timeout)
        {
            Pump?.Invoke();
            if (TryDequeueData(out var frame)) { if (frame.Length >= 4 && frame[0] == GetFirmwareInfo) return frame; continue; }
            Thread.Sleep(2);
        }
        return null;
    }
    public static string StatusName(ushort status) => status switch
    {
        0xFF00 => "GameboyConnected", 0xFF01 => "GameboyDisconnected", 0xFF02 => "AwaitMode", 0xFF03 => "HandshakeReceived",
        0xFF04 => "HandshakeFinished", 0xFF05 => "LinkConnected", 0xFF06 => "LinkReconnecting", 0xFF07 => "LinkClosed",
        0xFF08 => "DeviceReady", 0xFF09 => "SooraTradeSessionFinished", 0xFF0A => "GBModeActive", 0xFF0B => "GBPrinterModeActive",
        0xFF0C => "GBSessionFinished", 0xFF0D => "WrongCable", 0xFFFF => "StatusDebug", _ => $"status 0x{status:x4}",
    };
    public void Dispose() { running = false; try { port?.Dispose(); } catch (Exception) { } }
}

// gpsp-compatible "RFU1" inter-adapter frames (the firmware's network side). Header words are big-endian;
// data payloads are the wireless adapter's raw bytes; broadcast payloads are the game's six 32-bit words.
public static class Rfu1
{
    public const uint Broadcast = 0, ConnectReq = 1, ConnectAck = 2, ConnectNack = 3, Disconnect = 4, HostSend = 5, ClientSend = 6, ClientAck = 7, FlowCtl = 8;
    public static readonly byte[] Magic = "RFU1"u8.ToArray();
    public sealed record Frame(uint Type, uint Header, byte[] Payload)
    {
        public string Name => Type switch { 0 => "BROADCAST", 1 => "CONNECT_REQ", 2 => "CONNECT_ACK", 3 => "CONNECT_NACK", 4 => "DISCONNECT", 5 => "HOST_SEND", 6 => "CLIENT_SEND", 7 => "CLIENT_ACK", 8 => "FLOWCTL", _ => $"ptype{Type}" };
        // Broadcast payloads arrive as six big-endian words; the game's 24 packet bytes are each word little-endian.
        public byte[] BroadcastBytes() { var b = new byte[24]; for (int i = 0; i < 6; i++) Bin.W32(b, i * 4, Bin.B32(Payload, i * 4)); return b; }
        public int DataLength => Type == HostSend ? (int)(Header & 0x7F) : Type == ClientSend ? (int)(Header >> 24) : 0;
        public byte[] Data => Payload[..Math.Min(Payload.Length, DataLength)];
    }
    public static int Size(uint type) => type switch { 0 => 36, 5 or 6 => 104, 1 or 2 or 3 or 4 or 7 or 8 => 16, _ => -1 };
    private static byte[] Head(int size, uint type, uint header)
    { var f = new byte[size]; Magic.CopyTo(f, 0); Bin.WB32(f, 4, type); Bin.WB32(f, 8, header); return f; }
    public static byte[] Cmd(uint type, uint header) => Head(16, type, header);
    public static byte[] Bcast(ushort devid, byte nextSlot, ReadOnlySpan<byte> packet24)
    {
        var f = Head(36, Broadcast, (uint)(devid | nextSlot << 16));
        for (int i = 0; i < 6; i++) Bin.WB32(f, 12 + i * 4, Bin.U32(packet24, i * 4));
        return f;
    }
    public static byte[] Data(uint type, uint header, ReadOnlySpan<byte> bytes)
    { var f = Head(104, type, header); bytes[..Math.Min(bytes.Length, 92)].CopyTo(f.AsSpan(12)); return f; }
    public static byte[] HostSendFrame(ReadOnlySpan<byte> bytes) => Data(HostSend, (uint)bytes.Length & 0x7F, bytes);

    public sealed class Parser
    {
        private readonly List<byte> buffer = [];
        public IEnumerable<Frame> Feed(byte[] chunk)
        {
            buffer.AddRange(chunk);
            while (true)
            {
                int at = -1;
                for (int i = 0; i + 4 <= buffer.Count; i++)
                    if (buffer[i] == Magic[0] && buffer[i + 1] == Magic[1] && buffer[i + 2] == Magic[2] && buffer[i + 3] == Magic[3]) { at = i; break; }
                if (at < 0) { if (buffer.Count > 3) buffer.RemoveRange(0, buffer.Count - 3); yield break; }
                if (at > 0) buffer.RemoveRange(0, at);
                if (buffer.Count < 12) yield break;
                var head = buffer.GetRange(0, 12).ToArray(); uint type = Bin.B32(head, 4); int size = Size(type);
                if (size < 0) { buffer.RemoveRange(0, 4); continue; }
                if (buffer.Count < size) yield break;
                var frame = buffer.GetRange(0, size).ToArray(); buffer.RemoveRange(0, size);
                yield return new(type, Bin.B32(frame, 8), frame[12..]);
            }
        }
    }
}

// Decodes the wireless firmware's sub-64-byte telemetry frames (tags 0x0E, 0x1D, 0x2E, 0x2F).
public static class RfuTelemetry
{
    public static readonly string[] ComState = ["idWait", "idDance", "waitCmd", "waitDat", "respCmd", "respDat", "respErr", "respErr2", "waitEvent", "waitResp"];
    public static readonly string[] WifiState = ["idle", "host", "connecting", "client"];
    private static string Name(string[] names, int i) => i >= 0 && i < names.Length ? names[i] : i.ToString();
    public static string? Describe(byte[] f)
    {
        if (f.Length == 16 && f[0] == 0x0E)
            return $"detect: anyRx={f[1]} nintendo={f[2]} com={Name(ComState, f[3])} firstRx={Bin.U32(f, 4):x8} lastRx={Bin.U32(f, 8):x8} transfers={Bin.U32(f, 12)}";
        if (f.Length == 62 && f[0] == 0x2E)
        {
            var ring = string.Join(" ", Enumerable.Range(0, f[7]).Select(i => f[8 + i].ToString("x2")));
            return $"core: com={Name(ComState, f[1])} wifi={Name(WifiState, f[2])} role={(f[3] == 0 ? "gbaMaster" : "adapterMaster")} flags={f[4]:x2} lastCmd={f[5]:x2}/{f[6]} ring=[{ring}] " +
                   $"slaveXfers={Bin.U32(f, 16)} masterXfers={Bin.U32(f, 20)} waitEvents={Bin.U32(f, 24)} cmds={Bin.U32(f, 28)} aborts={Bin.U32(f, 32)} loginRestarts={Bin.U32(f, 36)} errResp={Bin.U32(f, 40)} lastRx={Bin.U32(f, 44):x8} " +
                   $"rev=[{Bin.U32(f, 48):x8} {Bin.U32(f, 52):x8}] delivFail={f[56]:x2} so={f[57]} retries={Bin.U32(f, 58)}";
        }
        if (f.Length == 25 && f[0] == 0x1D)
            return $"events: data={f[1]} rtx={f[2]} timeo={f[3]} disc={f[4]} lastEvent={Bin.U32(f, 5):x8} linkPwrZero={f[9]} lastLinkPwr={Bin.U32(f, 10):x8} sd={f[14]} wipes={f[15]:x2}{f[16]:x2} resetWipe/occupancy={f[17]:x2} parkedDrops={f[18]} rxDropFull={f[19]} fifoHigh={f[20]} flow={f[21]:x2} sheds={f[22]} idleRetx={f[23]} cmdCounter={f[24]}";
        if (f.Length == 10 && f[0] == 0x2F)
            return $"stall: lines={f[2]:x2} smPc={f[3]} txLvl={f[4]} rxLvl={f[5]} lastRx={Bin.U32(f, 6):x8}";
        return null;
    }
}
