#include "pia_bridge.h"
#include "pia_link.h"
#include "pico_link.h"
#include "trade_shim.h"
#include "ldn_control.h"
#include "ldn_session.h"
#include "ldn_udp.h"
#include "ldn_wire.h"

#include <stdio.h>
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_attr.h"

/* In binary mode bare text would land between frames and corrupt the next one. */
#define printf ldn_wire_printf

#define RFU1_HOST_SEND 5u
#define RFU1_CLIENT_SEND 6u
#define RFU1_CONNECT_REQ 1u
#define RFU1_CONNECT_ACK 2u
#define RFU1_DISCONNECT 4u
#define RFU1_BROADCAST 0u

enum { BR_IDLE, BR_SCAN, BR_AUTH, BR_MEMBER, BR_NET, BR_RUN };

/* pokefirered constants/union_room.h: trade, single battle, double battle. */
#define GROUP_COUNT 3
static const uint8_t kGroupActivity[GROUP_COUNT] = {4, 1, 2};

static struct
{
    int state;
    bool started;
    ldn_network_t net;
    ldn_auth_t auth;
    pia_link_t link;
    uint8_t our_mac[6];
    char our_ip[16], host_ip[16];
    int64_t next_scan, next_auth, next_beacon, deadline;
    int64_t next_tick_us, tick_fraction;   /* the Pia tick at the GBA's 59.727 Hz, in microseconds plus parts per 59727 */
    uint16_t stall_low;
    int64_t stall_since;
    bool stall_reported;
    uint8_t net_type;
    uint32_t net_seq;
    bool net_unacked_noted;
    int channel_index, auth_attempts;
    bool authenticated, have_room, child_connected, session_up;
    int64_t last_host_frame_ms;
    uint32_t last_host_time;
    uint16_t host_skips, host_long_skips;
    int unzip_seen;
    int64_t last_unzip_ms;
    bool host_silent;
    uint16_t child_devid;
    /* One advertised group per activity, each under its own devid. A joining game
       lists only the leader whose activity matches what its player chose, and the
       connect request names the devid it picked, so the bridge need not know what
       the Switch is hosting, only follow the GBA. */
    uint16_t group_devid[GROUP_COUNT];
    uint8_t beacon[GROUP_COUNT][24];
    int group;                          /* the one the GBA connected to, -1 none */
    int frames_to_gba, frames_from_gba;
} g;

/* A room whose handshake went nowhere is left alone for a while, doubling each time.
   Every attempt joins with a new station address, and a Switch that has stopped
   answering only collects more dead stations from a bridge that keeps knocking. Rooms
   are told apart by SSID, which is new for each one, so a fresh room is never held
   back. Kept across the restart that follows the failure. */
static RTC_NOINIT_ATTR struct { uint32_t magic; uint8_t ssid[16]; uint8_t failures; } s_retry;
#define RETRY_MAGIC 0x52455452u

static int64_t retry_hold_ms(void)
{
    if (s_retry.magic != RETRY_MAGIC || s_retry.failures == 0) return 0;
    const int step = s_retry.failures > 4 ? 3 : s_retry.failures - 1;
    return 15000LL << step;   /* 15, 30, 60, 120 s */
}

static const unsigned kChannels[] = {1, 6, 11, 2, 3, 4, 5, 7, 8, 9, 10};
#define CHANNEL_COUNT (sizeof(kChannels) / sizeof(kChannels[0]))

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/* ---- RFU1 framing ---------------------------------------------------------- */

static const uint8_t kRfu1[4] = {'R', 'F', 'U', '1'};

static int rfu1_size(uint32_t type)
{
    if (type == RFU1_BROADCAST) return 36;
    if (type == RFU1_HOST_SEND || type == RFU1_CLIENT_SEND) return 104;
    return 16;
}

static void to_pico(const uint8_t *frame, size_t length)
{
    /* The adapter's data receive buffer is one 64-byte transport chunk; its parser
       reassembles across chunks. */
    for (size_t o = 0; o < length; o += 64)
    {
        size_t n = length - o < 64 ? length - o : 64;
        pico_link_send(PICO_LINK_CHANNEL_DATA, frame + o, n);
    }
    ++g.frames_to_gba;
}

static void send_command(uint32_t type, uint32_t header)
{
    uint8_t f[16] = {0};
    memcpy(f, kRfu1, 4);
    bin_wb32(f + 4, type);
    bin_wb32(f + 8, header);
    to_pico(f, sizeof(f));
}

static void send_host_frame(const uint8_t *payload, size_t length)
{
    uint8_t f[104] = {0};
    memcpy(f, kRfu1, 4);
    bin_wb32(f + 4, RFU1_HOST_SEND);
    bin_wb32(f + 8, (uint32_t)(length & 0x7F));
    memcpy(f + 12, payload, length > 92 ? 92 : length);
    to_pico(f, sizeof(f));
}

static void send_beacon(void)
{
    for (int k = 0; k < GROUP_COUNT; ++k)
    {
        uint8_t f[36] = {0};
        memcpy(f, kRfu1, 4);
        bin_wb32(f + 4, RFU1_BROADCAST);
        const bool occupied = g.child_connected && g.group == k;
        bin_wb32(f + 8, (uint32_t)(g.group_devid[k] | (occupied ? 1u : 0u) << 16));
        for (int i = 0; i < 6; ++i) bin_wb32(f + 12 + i * 4, bin_u32(g.beacon[k] + i * 4));
        to_pico(f, sizeof(f));
    }
}

/* The union-room name encoding: letters and digits map into the game's charset. */
static void game_name(const char *name, uint8_t *out, int size)
{
    int n = 0;
    for (const char *c = name; *c && n < size - 1; ++c)
    {
        if (*c >= 'A' && *c <= 'Z') out[n++] = (uint8_t)(*c - 'A' + 0xbb);
        else if (*c >= 'a' && *c <= 'z') out[n++] = (uint8_t)(*c - 'a' + 0xd5);
        else if (*c >= '0' && *c <= '9') out[n++] = (uint8_t)(*c - '0' + 0xa1);
        else out[n++] = 0;
    }
    out[n] = 255;
}

#define BEACON_COMPATIBILITY (2 | (1 << 7) | (1 << 8) | (1 << 9) | (4 << 10))

static void build_beacon(uint8_t *beacon, const char *name, uint8_t activity)
{
    memset(beacon, 0, 24);
    bin_w16(beacon, 0x0002);                 /* RFU_SERIAL_GAME */
    bin_w16(beacon + 2, BEACON_COMPATIBILITY);
    bin_w16(beacon + 4, 0x1234);             /* trainer id */
    beacon[12] = activity;                   /* not started */
    uint8_t uname[8];
    game_name(name, uname, 8);
    memcpy(beacon + 16, uname, 8);
    int sum = 0;
    for (int i = 0; i < 8; ++i) sum += uname[i] + beacon[2 + i];
    beacon[15] = (uint8_t)~sum;
}

/* ---- callbacks ------------------------------------------------------------- */

static void on_send(const uint8_t *datagram, size_t length, const char *destination, void *user)
{
    (void)user;
    ldn_udp_send(destination, datagram, length);
}

static void on_deliver(const uint8_t *frame, size_t length, void *user)
{
    (void)user;
    /* Host framing: byte 8 is the adapter send length, payload from byte 12. */
    if (length < 12) return;
    size_t n = frame[8] & 0x7F;
    if (12 + n > length) n = length - 12;
    if (n > 92) n = 92;
    static uint8_t payload[92];
    memcpy(payload, frame + 12, n);
    int64_t now = now_ms();
    if (g.last_host_frame_ms && now - g.last_host_frame_ms > 250)
        trade_shim_note(now, TRADE_SHIM_NOTE_HOST_SILENCE, (uint16_t)(now - g.last_host_frame_ms), 1);
    g.host_silent = false;
    /* The Switch's adapter counts its Sooralated frames; a jump means the Sooralated
       game did not run those frames (a stall), and while stalled its link layer
       is not draining its 20-slot receive queue. */
    uint32_t stamp = bin_u32(frame + 4);
    uint32_t jump = stamp - g.last_host_time;
    if (g.last_host_time && jump >= 2 && jump < 1000)
    {
        if (jump == 2) ++g.host_skips;
        else
        {
            ++g.host_long_skips;
            trade_shim_note(now, TRADE_SHIM_NOTE_SWITCH_CLOCK_SKIP, (uint16_t)jump, (uint16_t)(now - g.last_host_frame_ms));
        }
    }
    g.last_host_time = stamp;
    g.last_host_frame_ms = now;
    static uint8_t pre[8 * 73];
    size_t r = trade_shim_host(payload, n, now, pre, sizeof(pre));
    for (size_t o = 0; o + 73 <= r; o += 73) send_host_frame(pre + o, 73);
    send_host_frame(payload, n);
}

static void on_log(const char *message, void *user) { (void)user; printf("LDN_BRIDGE %s\n", message); }

static void on_datagram(const char *ip, const uint8_t *data, size_t length)
{
    if (g.state == BR_RUN) pia_link_receive(&g.link, data, length, ip);
}

static void on_action(const uint8_t source[6], const uint8_t *body, size_t length)
{
    if (g.state != BR_AUTH || memcmp(source, g.net.host, 6) != 0) return;
    if (ldn_auth_accept(&g.auth, body, length))
    {
        g.authenticated = true;
        printf("LDN_BRIDGE auth verified\n");
    }
}

/* ---- inbound from the adapter ---------------------------------------------- */

static void connect_child(void)
{
    g.child_devid = (uint16_t)(esp_random() | 1);
    g.child_connected = true;
    /* No shim reset here: the GBA's link manager re-connects after a link-loss
       recovery while both games keep their round counters and the Switch keeps
       its sequence expectation. A new session goes through pia_bridge_start, which
       does reset. */
    trade_shim_note(now_ms(), TRADE_SHIM_NOTE_CHILD_CONNECT, g.child_devid, 0);
    send_command(RFU1_CONNECT_ACK, g.child_devid);
    printf("LDN_BRIDGE child connected devid=%04x\n", g.child_devid);
}

static void feed_rfu1(const uint8_t *frame, size_t length)
{
    if (length < 12 || memcmp(frame, kRfu1, 4) != 0) return;
    uint32_t type = bin_b32(frame + 4), header = bin_b32(frame + 8);
    if ((size_t)rfu1_size(type) != length) return;
    ++g.frames_from_gba;

    if (type == RFU1_CONNECT_REQ)
    {
        /* The request names the devid of the group the GBA's player picked. */
        for (int k = 0; k < GROUP_COUNT; ++k)
            if (g.group_devid[k] == (header & 0xFFFF) && g.group != k)
            {
                g.group = k;
                printf("LDN_BRIDGE GBA chose the activity %u group\n", kGroupActivity[k]);
            }
        pia_link_set_connect(&g.link, true);
        if (!g.child_connected && g.link.accepted) connect_child();
    }
    else if (type == RFU1_CLIENT_SEND)
    {
        size_t n = header >> 24;
        if (n > 92) n = 92;
        static uint8_t payload[92], reply[146];
        memcpy(payload, frame + 12, n);
        bool forward = true;
        size_t r = trade_shim_child(payload, n, now_ms(), reply, sizeof(reply), &forward);
        if (forward) pia_link_enqueue(&g.link, payload, n);
        for (size_t o = 0; o + 73 <= r; o += 73) send_host_frame(reply + o, 73);
    }
    else if (type == RFU1_DISCONNECT)
    {
        if (g.child_connected) trade_shim_note(now_ms(), TRADE_SHIM_NOTE_CHILD_DISCONNECT, 0, 0);
        g.child_connected = false;
    }
}

static void drain_adapter(void)
{
    static uint8_t gb[5 + PICO_LINK_MAX_PAYLOAD];
    static uint8_t stream[256];
    static size_t used;
    size_t length = 0;
    for (int i = 0; i < 32 && pico_link_poll_inbound(gb, sizeof(gb), &length); ++i)
    {
        if (length < 5 || gb[2] != PICO_LINK_CHANNEL_DATA) continue;
        size_t n = length - 5;
        /* RFU1 chunks are exactly 64 bytes, zero padded; anything shorter is
           the adapter's own telemetry. */
        if (n < 64) { trade_shim_adapter(now_ms(), gb + 5, n); continue; }
        if (used + n > sizeof(stream)) used = 0;
        memcpy(stream + used, gb + 5, n);
        used += n;
        /* Frames are fixed-size per type, so resynchronise on the magic. */
        size_t at = 0;
        while (used - at >= 12)
        {
            if (memcmp(stream + at, kRfu1, 4) != 0) { ++at; continue; }
            int size = rfu1_size(bin_b32(stream + at + 4));
            if (used - at < (size_t)size) break;
            feed_rfu1(stream + at, (size_t)size);
            at += (size_t)size;
        }
        if (at > 0) { memmove(stream, stream + at, used - at); used -= at; }
    }
}

/* ---- state machine --------------------------------------------------------- */

void pia_bridge_start(void)
{
    if (g.started) return;
    memset(&g, 0, sizeof(g));
    g.started = true;
    g.state = BR_SCAN;
    g.group = -1;
    for (int k = 0; k < GROUP_COUNT; ++k)
    {
        bool fresh;
        do
        {
            g.group_devid[k] = (uint16_t)(esp_random() | 1);
            fresh = true;
            for (int j = 0; j < k; ++j) fresh = fresh && g.group_devid[j] != g.group_devid[k];
        } while (!fresh);
    }
    trade_shim_reset();
    trade_shim_note(now_ms(), TRADE_SHIM_NOTE_BRIDGE_START, 0, 0);
    ldn_udp_set_handler(on_datagram);
    ldn_control_set_action_handler(on_action);
    /* Only enter the mode if no GBA is already talking to the adapter: re-entering
       resets it out from under a GBA that has already found it. */
    if (!pico_link_gba_active()) pico_link_set_mode();
    printf("LDN_BRIDGE scanning for a FireRed room\n");
}

void pia_bridge_stop(void)
{
    if (!g.started) return;
    trade_shim_note(now_ms(), TRADE_SHIM_NOTE_BRIDGE_STOP, (uint16_t)g.state, 0);
    ldn_udp_set_handler(NULL);
    ldn_control_set_action_handler(NULL);
    ldn_session_stop();
    g.started = false;
    g.state = BR_IDLE;
    printf("LDN_BRIDGE stopped\n");
}

/* An ended session or a failed join restarts the board: a fresh boot is the one start-up
   path exercised every time, and it resumes the room search. After a session the adapter
   first re-enters its mode, dropping the old room from its heard-group table (the GBA's
   join list); the room is gone, so no link is disturbed. After the restart that may be
   skipped: once a GBA has clocked it, dbgAnyRx stays set and pico_link leaves it alone. */
static void bridge_restart(bool session_ended)
{
    if (session_ended)
    {
        pico_link_set_mode();
        pico_link_flush();
        ldn_control_flush_adapter();
    }
    pia_bridge_stop();
    esp_restart();
}

bool pia_bridge_running(void) { return g.started; }
bool pia_bridge_in_session(void) { return g.started && g.state == BR_RUN; }

/* The reliable stream to the Switch has not moved for a while although frames are
   waiting: record both sides' view of it, once per stall. */
static void check_stall(int64_t now)
{
    const pia_link_t *l = &g.link;
    int pending = pia_reliable_pending(&l->reliable);
    if (pending == 0 || l->reliable.low != g.stall_low)
    {
        if (g.stall_reported) trade_shim_pia_recovered(now);
        g.stall_low = l->reliable.low;
        g.stall_since = now;
        g.stall_reported = false;
        return;
    }
    if (g.stall_reported || now - g.stall_since < 1500) return;
    g.stall_reported = true;
    trade_shim_pia_t p = {
        .our_low = l->reliable.low, .our_next = l->reliable.next, .our_pending = (uint16_t)pending,
        .peer_low = l->peer_low, .peer_ack_next = l->peer_ack_next, .receive_next = l->reliable.receive_next,
        .stalled_ms = now - g.stall_since,
        .peer_low_age_ms = l->peer_low_valid ? now - l->peer_low_moved_ms : -1,
        .peer_ack_age_ms = l->peer_ack_valid ? now - l->peer_ack_moved_ms : -1,
        .peer_ack_seen_age_ms = l->peer_ack_valid ? now - l->peer_ack_seen_ms : -1,
        .out_of_order = (uint16_t)l->reliable.ooo_count, .credits = (uint16_t)l->credits,
        .k_queued = (uint16_t)l->k_count, .k_inflight = (uint16_t)l->k_inflight_count,
        .out_queued = (uint16_t)l->out_count, .overflow = l->overflow, .idle_evicted = l->idle_evicted,
    };
    trade_shim_pia_stall(now, &p);
}

void pia_bridge_room(const ldn_network_t *net)
{
    if (!g.started) return;
    if (g.state == BR_SCAN)
    {
        if (net->communication_id != 0x01006fa0233f8000ULL) return;
        if (net->policy == 1 || net->member_count >= net->maximum) return;
        if (s_retry.magic == RETRY_MAGIC && memcmp(net->ssid, s_retry.ssid, 16) == 0 &&
            now_ms() < retry_hold_ms()) return;
        g.net = *net;
        g.have_room = true;
        return;
    }
    if (g.state == BR_MEMBER && memcmp(net->host, g.net.host, 6) == 0)
    {
        for (int i = 0; i < net->member_count; ++i)
            if (memcmp(net->members[i].mac, g.our_mac, 6) == 0)
            {
                snprintf(g.our_ip, sizeof(g.our_ip), "%s", net->members[i].ip);
                for (int j = 0; j < net->member_count; ++j)
                    if (net->members[j].index == 0)
                        snprintf(g.host_ip, sizeof(g.host_ip), "%s", net->members[j].ip);
                g.net = *net;
                g.state = BR_NET;
                return;
            }
    }
}

static void hex_of(const uint8_t *data, size_t length, char *out)
{
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < length; ++i) { out[2 * i] = digits[data[i] >> 4]; out[2 * i + 1] = digits[data[i] & 15]; }
    out[2 * length] = 0;
}

void pia_bridge_poll(void)
{
    if (!g.started) return;
    int64_t now = now_ms();

    switch (g.state)
    {
    case BR_SCAN:
        if (g.have_room)
        {
            char ssid[33], key_hex[33], bssid[18];
            uint8_t key[16];
            if (!ldn_keys_network(&g.net, key)) { printf("LDN_BRIDGE no keys\n"); pia_bridge_stop(); return; }
            hex_of(g.net.ssid, 16, ssid);
            hex_of(key, 16, key_hex);
            memset(key, 0, sizeof(key));
            snprintf(bssid, sizeof(bssid), "%02x:%02x:%02x:%02x:%02x:%02x",
                     g.net.host[0], g.net.host[1], g.net.host[2], g.net.host[3], g.net.host[4], g.net.host[5]);
            esp_err_t r = ldn_session_configure(ssid, bssid, key_hex, (unsigned)g.net.channel);
            memset(key_hex, 0, sizeof(key_hex));
            printf("LDN_BRIDGE joining channel=%d result=%d\n", g.net.channel, r);
            if (r != ESP_OK) { g.have_room = false; return; }
            g.state = BR_AUTH;
            g.deadline = now + 40000;
            g.next_auth = 0;
            g.auth_attempts = 0;
            g.authenticated = false;
            return;
        }
        if (now >= g.next_scan)
        {
            ldn_session_scan(kChannels[g.channel_index]);
            g.channel_index = (g.channel_index + 1) % CHANNEL_COUNT;
            g.next_scan = now + 500;
        }
        return;

    case BR_AUTH:
        if (now > g.deadline) { printf("LDN_BRIDGE join timed out\n"); bridge_restart(false); return; }
        if (!ldn_control_connected()) return;
        ldn_control_mac(g.our_mac);
        if (g.authenticated) { g.state = BR_MEMBER; return; }
        if (now >= g.next_auth && g.auth_attempts < 4)
        {
            if (g.auth_attempts == 0 && !ldn_auth_begin(&g.auth, &g.net))
            { printf("LDN_BRIDGE auth build failed\n"); pia_bridge_stop(); return; }
            ldn_control_tx_action(g.auth.request, (size_t)g.auth.request_len);
            ++g.auth_attempts;
            g.next_auth = now + 700;
            printf("LDN_BRIDGE auth request %d\n", g.auth_attempts);
        }
        return;

    case BR_MEMBER:
        if (now > g.deadline) { printf("LDN_BRIDGE membership timed out\n"); bridge_restart(false); return; }
        return;

    case BR_NET:
    {
        char line[128];
        snprintf(line, sizeof(line), "LDN_NET %s %s", g.our_ip, g.host_ip);
        ldn_udp_command(line, true);
        for (int i = 0; i < g.net.member_count; ++i)
        {
            if (memcmp(g.net.members[i].mac, g.our_mac, 6) == 0) continue;
            char mac[13];
            hex_of(g.net.members[i].mac, 6, mac);
            snprintf(line, sizeof(line), "LDN_NEIGH %s %s", g.net.members[i].ip, mac);
            ldn_udp_command(line, true);
        }
        const char *host_name = "SWITCH";
        for (int i = 0; i < g.net.member_count; ++i)
            if (g.net.members[i].index == 0 && g.net.members[i].name[0]) host_name = g.net.members[i].name;
        for (int k = 0; k < GROUP_COUNT; ++k) build_beacon(g.beacon[k], host_name, kGroupActivity[k]);
        uint8_t host_mac[6];
        memcpy(host_mac, g.net.host, 6);
        pia_link_init(&g.link, g.net.ssid, g.our_mac, host_mac, g.our_ip, g.host_ip,
                      on_send, on_deliver, on_log, NULL);
        pia_link_set_connect(&g.link, false);
        g.state = BR_RUN;
        g.deadline = now + 10000;
        g.next_tick_us = esp_timer_get_time();
        g.tick_fraction = 0;
        g.link.stamp = trade_shim_stamp;
        g.link.sheddable = trade_shim_sheddable;
        g.stall_since = now;
        g.stall_reported = false;
        g.next_beacon = now;
        printf("LDN_BRIDGE joined room host=%s ours=%s host_ip=%s\n", host_name, g.our_ip, g.host_ip);
        return;
    }

    case BR_RUN:
        ldn_udp_heartbeat();
        drain_adapter();
        if (now >= g.next_beacon) { send_beacon(); g.next_beacon = now + 500; }
        int64_t now_us = esp_timer_get_time();
        if (now_us >= g.next_tick_us)
        {
            pia_link_tick(&g.link);
            /* 59.727 Hz, the GBA frame rate the Switch runs at: at most one child frame
               goes out per tick, so a slower tick falls behind a child that sends every
               frame and the queue creeps. */
            g.tick_fraction += 1000000000LL;
            g.next_tick_us += g.tick_fraction / 59727;
            g.tick_fraction %= 59727;
            if (g.next_tick_us < now_us) g.next_tick_us = now_us + 16742;
            if (g.link.accepted && !g.child_connected && g.link.connect_wanted) connect_child();
        }
        trade_shim_poll(now);
        check_stall(now);
        {
            /* Each new net protocol request from the Switch, and whether it keeps coming back:
               repeats past a second mean the Switch is not taking the acknowledgement. */
            const pia_conn_t *c = &g.link.conn;
            if (c->net_requests && (c->net_last_type != g.net_type || c->net_last_seq != g.net_seq))
            {
                g.net_type = c->net_last_type;
                g.net_seq = c->net_last_seq;
                g.net_unacked_noted = false;
                trade_shim_note(now, TRADE_SHIM_NOTE_NET_REQUEST, g.net_type, (uint16_t)g.net_seq);
                printf("LDN_BRIDGE Switch net request %02x seq %u\n", (unsigned)g.net_type, (unsigned)g.net_seq);
            }
            if (!g.net_unacked_noted && c->net_repeats >= 4)
            {
                g.net_unacked_noted = true;
                trade_shim_note(now, TRADE_SHIM_NOTE_NET_UNACKNOWLEDGED, g.net_type, (uint16_t)c->net_repeats);
                printf("LDN_BRIDGE Switch keeps repeating net request %02x: acknowledgement not taken\n", (unsigned)g.net_type);
            }
        }
        if (g.child_connected)
        {
            uint8_t extra[16], repeat[73];
            size_t n = trade_shim_inject(now, extra, sizeof(extra));
            if (n) pia_link_enqueue(&g.link, extra, n);
            n = trade_shim_host_inject(now, repeat, sizeof(repeat));
            if (n) send_host_frame(repeat, n);
        }
        if (g.link.rx_unzip_fail != g.unzip_seen)
        {
            /* The first failure after a quiet spell marks where a burst began. */
            if (now - g.last_unzip_ms > 10000)
            {
                trade_shim_note(now, TRADE_SHIM_NOTE_UNZIP_FAILURE, (uint16_t)g.link.rx_unzip_last_error,
                                (uint16_t)g.link.rx_unzip_last_len);
                printf("LDN_BRIDGE Switch datagram could not be decompressed (error %d)\n", g.link.rx_unzip_last_error);
            }
            g.last_unzip_ms = now;
            g.unzip_seen = g.link.rx_unzip_fail;
        }
        const int body_max = g.link.rx_body_max;
        trade_shim_bridge_counters(now, (uint16_t)g.link.reordered, (uint16_t)g.link.hold_dropped,
                                   (uint16_t)g.link.overflow, (uint16_t)g.link.out_count,
                                   (uint16_t)g.link.rx_bad_frame, (uint16_t)g.link.decrypt_failures, (uint16_t)g.link.rx_unzip_fail,
                                   g.host_skips, g.host_long_skips,
                                   (uint16_t)(body_max > 65535 ? 65535 : body_max),
                                   (uint16_t)g.link.rx_unzip_last_error);
        if (g.last_host_frame_ms && !g.host_silent && now - g.last_host_frame_ms > 250)
        {
            g.host_silent = true;
            trade_shim_note(now, TRADE_SHIM_NOTE_HOST_SILENCE, 250, 0);
            printf("LDN_BRIDGE Switch stream has gone quiet\n");
        }
        if (g.link.host_disconnected)
        {
            printf("LDN_BRIDGE host disconnected\n");
            trade_shim_note(now, TRADE_SHIM_NOTE_HOST_DISCONNECT, 0, 0);
            bridge_restart(true);
        }
        if (!g.session_up && pia_conn_connected(&g.link.conn))
        {
            g.session_up = true;
            s_retry.failures = 0;
            printf("LDN_BRIDGE session established\n");
        }
        /* Closing a room takes the Switch's whole network down. With a GBA connected
           that arrives as 'WD' first; without one this is the only sign. */
        if (!ldn_control_connected())
        {
            printf("LDN_BRIDGE network lost\n");
            bridge_restart(false);
        }
        /* A handshake that has not completed by now will not: the Switch goes quiet
           rather than refusing, so start over. */
        if (!pia_conn_connected(&g.link.conn) && now > g.deadline)
        {
            if (s_retry.magic != RETRY_MAGIC || memcmp(s_retry.ssid, g.net.ssid, 16) != 0)
            {
                s_retry.magic = RETRY_MAGIC;
                memcpy(s_retry.ssid, g.net.ssid, 16);
                s_retry.failures = 0;
            }
            if (s_retry.failures < 255) ++s_retry.failures;
            printf("LDN_BRIDGE session handshake timed out, leaving this room alone for %d s\n",
                   (int)(retry_hold_ms() / 1000));
            bridge_restart(false);
        }
        return;

    default:
        return;
    }
}

void pia_bridge_status(char *out, size_t cap)
{
    static const char *const names[] = {"idle", "scan", "auth", "member", "net", "run"};
    if (!g.started) { snprintf(out, cap, "state=stopped"); return; }
    snprintf(out, cap,
             "state=%s child=%d accepted=%d pia_rx=%d pia_tx=%d decrypt_failed=%d reordered=%d "
             "to_gba=%d from_gba=%d queued=%d repeated=%d overflow=%d hold_dropped=%d "
             "rx_seen=%d wrong_src=%d short=%d bad_frame=%d msgs=%d unzip_fail=%d conn_state=%d host_id=%04x shed=%d",
             names[g.state], g.child_connected, g.link.accepted, g.link.received, g.link.sent,
             g.link.decrypt_failures, g.link.reordered, g.frames_to_gba, g.frames_from_gba,
             g.link.out_count, g.link.repeated, g.link.overflow, g.link.hold_dropped,
             g.link.rx_seen, g.link.rx_wrong_source, g.link.rx_short, g.link.rx_bad_frame,
             g.link.rx_messages, g.link.rx_unzip_fail, g.link.conn.state, g.link.conn.host_id, g.link.shed);
    size_t at = strlen(out);
    if (at + 80 < cap)
    {
        out[at++] = ' ';
        trade_shim_status(out + at, cap - at);
        at += strlen(out + at);
    }
    if (g.link.rx_first_len > 0 && at + 64 < cap)
    {
        at += (size_t)snprintf(out + at, cap - at, " first(zip=%d pad=%d foot=%d)=",
                               g.link.rx_first_zipped, g.link.rx_first_pad, g.link.rx_first_footer);
        for (int i = 0; i < g.link.rx_first_len && at + 3 < cap; ++i)
            at += (size_t)snprintf(out + at, cap - at, "%02x", g.link.rx_first[i]);
    }
}
