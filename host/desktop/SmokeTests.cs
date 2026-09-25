using System.Runtime.InteropServices;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Input;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Threading;

namespace Frlg.Trade.Desktop;

public static class SmokeTests
{
    public static bool Active { get; private set; }
    private static int checks;
    private static void Require(bool condition, string message)
    { checks++; if (!condition) throw new InvalidOperationException(message); }

    // Pictures for the checks are drawn here and kept in a folder of the checks' own, so
    // neither the network nor local/sprites is touched. Called before the window loads
    // its party.
    private static int downloads;
    private static bool offline, garbled;
    public static void Prepare()
    {
        string folder = Path.Combine(Paths.Local, "ui-checks", "sprites");
        if (Directory.Exists(folder)) Directory.Delete(folder, true);
        Sprites.Use(folder, species =>
        {
            downloads++;
            if (offline) throw new HttpRequestException("The UI checks have no network");
            return Task.FromResult(garbled ? "<html>not a picture</html>"u8.ToArray() : Picture(species));
        });
    }
    // A square in the middle of a larger transparent image, as the real pictures are padded.
    private static byte[] Picture(int species)
    {
        const int size = 16;
        var pixels = new byte[size * size * 4];
        for (int y = 4; y < 12; y++) for (int x = 4; x < 12; x++)
        {
            int at = (y * size + x) * 4;
            pixels[at] = (byte)species; pixels[at + 1] = (byte)(species >> 8); pixels[at + 2] = 200; pixels[at + 3] = 255;
        }
        using var bitmap = new WriteableBitmap(new PixelSize(size, size), new Vector(96, 96), PixelFormat.Bgra8888, AlphaFormat.UnprSooral);
        using (var frame = bitmap.Lock()) Marshal.Copy(pixels, 0, frame.Address, pixels.Length);
        using var stream = new MemoryStream();
        bitmap.Save(stream, new PngBitmapEncoderOptions());
        return stream.ToArray();
    }
    private static async Task<bool> Until(Func<bool> done)
    {
        for (int i = 0; i < 150 && !done(); i++) await Task.Delay(20);
        return done();
    }

    public static async Task Run(MainWindow window)
    {
        Active = true;
        var stateFile = Path.Combine(Paths.Local, "party.json");
        var settingsFile = Path.Combine(Paths.Local, "desktop.json");
        byte[]? previous = File.Exists(stateFile) ? File.ReadAllBytes(stateFile) : null;
        byte[]? previousSettings = File.Exists(settingsFile) ? File.ReadAllBytes(settingsFile) : null;
        string output = Path.Combine(Paths.Local, "ui-checks");
        Directory.CreateDirectory(output);
        try
        {
            // The first two built-in Pokémon go to slots 0 and 1, which the clicks below target.
            window.LocalParty.LoadDefault();
            var builtIn = window.LocalParty.Slots.Where(s => s.Occupied).Select(s => s.Pokemon!).ToArray();
            Require(builtIn.Length >= 2 && window.LocalParty.Slots[window.LocalParty.Selected].Occupied, "Built-in party can start a trade");
            for (int i = 0; i < 6; i++) window.LocalParty.Slots[i].Set(i < 2 ? builtIn[i] : null);
            int before = downloads;
            Require(await Sprites.For(150) != null && downloads == before + 1 && File.Exists(Path.Combine(Sprites.Folder, "150.png")), "A picture is downloaded once and kept");
            offline = true;
            Sprites.Use(Sprites.Folder, Sprites.Download);
            Require(await Sprites.For(150) != null && downloads == before + 1, "A kept picture needs no network");
            Require(await Sprites.For(151) == null, "No network and no copy means no picture");
            offline = false;
            Require(await Sprites.For(151) != null, "The download is tried again the next time");
            garbled = true;
            Require(await Sprites.For(152) == null && !File.Exists(Path.Combine(Sprites.Folder, "152.png")), "A reply that is not a picture is not kept");
            garbled = false;
            window.LocalParty.Select(1);
            Require(window.OpponentSlots.All(s => !s.Occupied), "Disconnected opponents must be blank");
            Require(window.ConnectButton.IsEnabled && !window.DisconnectButton.IsEnabled && !window.CancelTradeButton.IsEnabled, "Initial button state");
            Require(await Until(() => window.LocalParty.Slots.Take(2).All(s => s.Sprite != null)), "Default sprites");
            Require(window.LocalParty.Slots[0].Sprite!.Size == new Size(8, 8), "Pictures are cropped to what is drawn");
            await Capture(window, output, "disconnected");

            await Click(window, window.LocalGrid, 0);
            Require(window.LocalParty.Selected == 0, "Click selects the offered slot");
            await Click(window, window.OpponentGrid, 3);
            Require(window.LocalParty.Selected == 0, "Click on the partner side changes nothing");
            await Click(window, window.LocalGrid, 1);
            Require(window.LocalParty.Selected == 1, "Click selects another slot");

            var pk = window.LocalParty.Slots[0].Pokemon!;
            var trainer = new TrainerIdentity(12345, 54321, "ALICE", 1);
            var edited = PokemonData.WithTrainer(pk, trainer);
            var readback = PokemonData.Parse(PokemonData.Export(edited));
            Require(TrainerIdentity.From(readback) == trainer && readback.ChecksumValid, "Trainer edit roundtrip");
            Require(readback.PID == pk.PID && readback.Species == pk.Species && readback.IV32 == pk.IV32, "OT update preserves unrelated fields");
            var damaged = PokemonData.Export(pk); damaged[40] ^= 0x77;
            try { PokemonData.Parse(damaged); throw new Exception("Damaged PK3 accepted"); }
            catch (InvalidDataException) { checks++; }
            window.SetState(ConnectionState.Connecting);
            Require(!window.ConnectButton.IsEnabled && window.DisconnectButton.IsEnabled, "Connecting is cancellable");
            using (var ready = JsonDocument.Parse("{\"event\":\"phase\",\"message\":\"Authenticating\"}"))
                window.HandleEvent(ready.RootElement);
            Require(window.DisconnectButton.IsEnabled, "Native authentication remains cancellable");
            window.SetState(ConnectionState.Connected);
            var party = new string[6];
            ushort[] species = [386, 5, 15, 12, 41, 386];
            string[] nicknames = ["DEOXYS", "CHARMELEON", "BEEDRILL", "BUTTERFREE", "ZUBAT", "DEOXYS"];
            for (int i = 0; i < 6; i++)
            {
                var sample = pk.Clone(); sample.Species = species[i]; sample.Nickname = nicknames[i]; sample.CurrentLevel = (byte)(i == 0 ? 100 : 8 + i);
                sample = PokemonData.WithTrainer(sample, i < 4 ? trainer : trainer with { Sid = 11111 });
                party[i] = Convert.ToHexString(PokemonData.Export(sample));
            }
            var auto = window.AutoOt.IsChecked; window.AutoOt.IsChecked = false;
            using (var doc = JsonDocument.Parse(JsonSerializer.Serialize(new { @event = "opponent_party", name = "ezwd", party })))
                window.HandleEvent(doc.RootElement);
            Require(window.OpponentSlots.All(s => s.Occupied) && await Until(() => window.OpponentSlots.All(s => s.Sprite != null)), "Live event fills all six sprites");
            Require(window.CancelTradeButton.IsEnabled, "Cancel trade enabled in the trade menu");
            using (var yes = JsonDocument.Parse("{\"event\":\"declining\",\"value\":true}")) window.HandleEvent(yes.RootElement);
            Require(!window.CancelTradeButton.IsEnabled, "Cancel trade disabled while declining");
            using (var no = JsonDocument.Parse("{\"event\":\"declining\",\"value\":false}")) window.HandleEvent(no.RootElement);
            Require(window.CancelTradeButton.IsEnabled, "Cancel trade enabled again after the offer returns");

            window.BeginSession(window.LocalParty.Snapshot());
            await Click(window, window.LocalGrid, 0);
            Require(window.LastLiveOffer == 0 && !window.PendingChanges && window.StatusText.Text!.Contains(window.LocalParty.Slots[0].Nickname), "Click while connected sends a live offer");
            await Click(window, window.LocalGrid, 1);
            Require(window.LastLiveOffer == 1 && window.LocalParty.Selected == 1, "Second live offer");
            var arrival = pk.Clone(); arrival.Species = 19; arrival.Nickname = "RATTATA"; arrival.RefreshChecksum();
            using (var got = JsonDocument.Parse(JsonSerializer.Serialize(new { @event = "received", slot = 1, pk3 = Convert.ToHexString(PokemonData.Export(arrival)) })))
                window.HandleEvent(got.RootElement);
            Require(window.LocalParty.Slots[1].Nickname == "RATTATA" && window.LocalParty.Selected == 1, "Received Pokémon takes the traded slot and stays offered");
            Require(!window.CancelTradeButton.IsEnabled, "Cancel trade disabled after a trade until the menu reopens");
            await Click(window, window.LocalGrid, 0);
            Require(window.LastLiveOffer == 0 && !window.PendingChanges, "Live offer after a trade");
            await Click(window, window.LocalGrid, 1);
            Require(window.GetTrainers().Length == 2, "OT identity dedup includes SID");
            var snapshot = window.LocalParty.Snapshot();
            window.LocalParty.ApplyTrainer(trainer); window.MarkChanged();
            Require(PokemonData.Parse(Convert.FromHexString(snapshot[0]!)).OriginalTrainerName == pk.OriginalTrainerName, "Connected snapshot remains unchanged");
            Require(window.PendingChanges && window.PendingText.Text!.Contains("next connection"), "Connected edits staged");
            Require(window.LocalParty.Slots.Where(s => s.Occupied).All(s => TrainerIdentity.From(s.Pokemon!) == trainer), "OT updates every local occupied slot");
            await Capture(window, output, "connected");
            window.Width = 900; window.Height = 700;
            await Capture(window, output, "compact");
            var dropped = Path.Combine(output, "drop.pk3"); File.WriteAllBytes(dropped, PokemonData.Export(edited));
            window.ImportFiles(window.LocalParty.Slots[5], [dropped]);
            Require(window.LocalParty.Slots[5].Occupied, "Import reaches sixth slot");
            window.SetState(ConnectionState.Disconnected);
            Require(window.OpponentSlots.All(s => !s.Occupied) && window.ConnectButton.IsEnabled && !window.DisconnectButton.IsEnabled && !window.CancelTradeButton.IsEnabled,
                "Unexpected exit resets party and buttons");
            var client = new BridgeClient();
            var exited = new TaskCompletionSource<int>();
            client.Exited += code => Dispatcher.UIThread.Post(() => { window.HandleExit(code); exited.TrySetResult(code); });
            window.SetState(ConnectionState.Connecting);
            try
            {
                // Invalid party exercises the native worker failure path before serial access.
                await client.StartAsync("none", new string?[6], 0);
                Require(await exited.Task.WaitAsync(TimeSpan.FromSeconds(10)) != 0, "Backend failure is observed");
                Require(window.State == ConnectionState.Disconnected && window.ConnectButton.IsEnabled && !window.DisconnectButton.IsEnabled,
                    "Real backend exit restores controls");
            }
            finally { await client.StopAsync(); }
            // Made-up keys, imported into a folder of its own, never the program directory.
            string keysFolder = Path.Combine(output, "keys-setup");
            if (Directory.Exists(keysFolder)) Directory.Delete(keysFolder, true);
            Directory.CreateDirectory(keysFolder);
            string wholeFile = Path.Combine(output, "made-up.keys"), uselessFile = Path.Combine(output, "useless.keys");
            File.WriteAllLines(wholeFile, Frlg.Trade.Core.KeyFile.Used.Select((name, i) => $"{name} = {new string((char)('1' + i), 32)}").Append("header_key = " + new string('f', 64)));
            File.WriteAllText(uselessFile, "header_key = " + new string('f', 64) + "\n");
            var setup = new KeysPrompt(keysFolder);
            Require(!setup.TryImport(uselessFile) && setup.Problem!.Contains("cannot be used") && !File.Exists(Path.Combine(keysFolder, "prod.keys")), "Unusable key file is refused with a reason");
            var dialog = setup.Build();
            dialog.Show();
            await Task.Delay(120);
            await Dispatcher.UIThread.InvokeAsync(dialog.UpdateLayout, DispatcherPriority.Background);
            Render((Control)dialog.Content!, Path.Combine(output, "keys-setup.png"));
            dialog.Close();
            Require(setup.TryImport(wholeFile) && !File.ReadAllText(Path.Combine(keysFolder, "prod.keys")).Contains("header_key"), "Key import keeps only the used entries");
            Directory.Delete(keysFolder, true); File.Delete(wholeFile); File.Delete(uselessFile);
            window.AutoOt.IsChecked = auto;
            File.WriteAllText(Path.Combine(output, "result.json"), JsonSerializer.Serialize(new { checks, passed = true, pkhex = "26.8.26" }));
        }
        finally
        {
            if (previous is null) { if (File.Exists(stateFile)) File.Delete(stateFile); }
            else File.WriteAllBytes(stateFile, previous);
            if (previousSettings is null) { if (File.Exists(settingsFile)) File.Delete(settingsFile); }
            else File.WriteAllBytes(settingsFile, previousSettings);
        }
    }

    private static async Task Click(MainWindow window, ItemsControl grid, int index)
    {
        var tile = grid.ContainerFromIndex(index) ?? throw new InvalidOperationException("A party tile is missing");
        var point = tile.TranslatePoint(new Point(tile.Bounds.Width / 2, tile.Bounds.Height / 2), window)
            ?? throw new InvalidOperationException("A party tile is outside the window");
        window.MouseMove(point);
        window.MouseDown(point, MouseButton.Left);
        window.MouseUp(point, MouseButton.Left);
        await Dispatcher.UIThread.InvokeAsync(() => { }, DispatcherPriority.Background);
    }

    private static async Task Capture(MainWindow window, string directory, string name)
    {
        await Task.Delay(120);
        await Dispatcher.UIThread.InvokeAsync(window.UpdateLayout, DispatcherPriority.Background);
        var root = window.Root;
        foreach (var grid in new[] { window.OpponentGrid, window.LocalGrid })
        {
            var bounds = new List<Rect>();
            for (int i = 0; i < 6; i++)
            {
                var element = grid.ContainerFromIndex(i) ?? throw new InvalidOperationException("A party tile is missing");
                Require(element.Bounds.Width > 100 && element.Bounds.Height > 100, "Stable tile dimensions");
                var origin = element.TranslatePoint(new Point(0, 0), root) ?? throw new InvalidOperationException("A party tile is outside the window");
                var rect = new Rect(origin, element.Bounds.Size);
                Require(bounds.All(other => !HasArea(other.Intersect(rect))), "Tiles do not overlap");
                bounds.Add(rect);
            }
        }
        Render(root, Path.Combine(directory, name + ".png"));
    }
    private static void Render(Control root, string file)
    {
        var size = new PixelSize((int)root.Bounds.Width, (int)root.Bounds.Height);
        using var bitmap = new RenderTargetBitmap(size, new Vector(96, 96));
        bitmap.Render(root);
        var pixels = new byte[size.Width * size.Height * 4];
        var pinned = GCHandle.Alloc(pixels, GCHandleType.Pinned);
        try { bitmap.CopyPixels(new PixelRect(size), pinned.AddrOfPinnedObject(), pixels.Length, size.Width * 4); }
        finally { pinned.Free(); }
        Require(pixels.Distinct().Count() > 100, "Rendered image contains content");
        bitmap.Save(file, new PngBitmapEncoderOptions());
    }
    private static bool HasArea(Rect rect) => rect.Width > 0.1 && rect.Height > 0.1;
}
