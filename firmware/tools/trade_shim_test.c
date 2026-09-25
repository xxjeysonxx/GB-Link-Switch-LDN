/* Host-side simulation of the post-trade standby exchange between a retail
   FireRed cartridge (child) and the Switch release (parent), run through
   trade_shim. Build and run from the firmware directory:

       cc -std=c11 -Wall -Wextra -I common tools/trade_shim_test.c common/trade_shim.c -o /tmp/trade_shim_test && /tmp/trade_shim_test

   The models follow pokefirered's link_rfu_2.c: the READY_EXIT_STANDBY barrier
   is numbered, and its commands are ignored unless the number equals the
   receiver's own counter; ready flags are set by a matching command and cleared
   only when a round completes; the leader sends its own command twice and never
   again; the child retries every 60 frames; the child's link layer refuses a
   block request while a barrier or a previous block send is active (the parent
   asks only once); the parent validates a consecutive mod-8 tag on every child
   command. The scripts follow trade.c / trade_scene.c: the retail child runs
   five standby rounds after a trade, the Switch parent six. Fault knobs drop frames
   the way the Switch Sooralator and the adapter path do. */

#include "trade_shim.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FRAME_MS 17
#define CMD_STANDBY 0x6600
#define CMD_BLOCK_INIT 0x8800
#define CMD_BLOCK 0x8900
#define CMD_BLOCK_REQ 0xa100
#define LINK_READY_FINISH 0xabcd
#define LINK_CONFIRM_FINISH 0xdcba

typedef struct { uint16_t w[7]; } slot_t;

enum { S_ROUND, S_WAIT, S_EXCHANGE, S_TRADE_FINISH, S_MENU, S_END };
typedef struct { int kind; int ms; } step_t;

typedef struct
{
    const char *name;
    bool parent;
    const step_t *script;
    int step, sub;
    int64_t until;
    int count;               /* resendExitStandbyCount */
    bool flag[2];            /* readyExitStandby */
    bool in_round;           /* gRfu.callback busy with a barrier */
    int round_timer;
    slot_t sendq[64];
    int sq_head, sq_count;
    uint8_t tag;             /* child: childSendCmdId */
    int expect_tag;          /* parent: childRecvIds, -1 until the first command */
    int tag_errors, tag_errors_total;
    slot_t recv[2];
    int peer_block_count;    /* from the peer's newest BLOCK_INIT */
    int peer_last_frag;      /* last fragments received from the peer */
    uint16_t peer_frag0_value;
    int menu_opens, refused_requests;
    int64_t last_peer_command;
    int block_busy_ms;       /* child: gRfu.callback stays busy this long after its party block's last fragment */
    int64_t busy_until;
    uint16_t last_serial;    /* parent: newest child command serial acted on */
    int duplicate_accepts;   /* parent: child commands acted on a second time */
} actor_t;

typedef struct
{
    bool shim;
    int save_ms;             /* the cartridge's post-trade save */
    bool parent_five_rounds; /* a parent that does not need the extra round */
    bool lose_first_fake;    /* the injected round never reaches the parent's game */
    int lose_parent_answer;  /* parent numbering of one answer whose copies never reach the child, 0 none */
    int child_busy_ms;       /* the child's link layer stays busy this long after each party block (a resend loop) */
    int duplicate_every;     /* the adapter hands every Nth child command frame over twice, 0 never */
    int drop_queued_command; /* the bridge's queue loses the Nth command frame before it is sent, 0 never */
} scenario_t;

static uint16_t g_serial;
static void push(actor_t *a, uint16_t cmd, uint16_t v1, uint16_t v2)
{
    if (a->sq_count == 64) { fprintf(stderr, "%s: send queue full\n", a->name); exit(2); }
    slot_t *s = &a->sendq[(a->sq_head + a->sq_count++) % 64];
    memset(s, 0, sizeof(*s));
    s->w[0] = cmd; s->w[1] = v1; s->w[2] = v2;
    if (!a->parent) s->w[6] = ++g_serial;   /* a word the games leave unused: identifies each command */
}

static bool pop(actor_t *a, slot_t *out)
{
    if (a->sq_count == 0) return false;
    *out = a->sendq[a->sq_head];
    a->sq_head = (a->sq_head + 1) % 64;
    --a->sq_count;
    return true;
}

static void push_block(actor_t *a, uint16_t marker, int count)
{
    push(a, CMD_BLOCK_INIT, (uint16_t)count, 0x80);
    push(a, CMD_BLOCK | 0, marker, 0);
    for (int i = 1; i < count; ++i) push(a, (uint16_t)(CMD_BLOCK | i), 0, 0);
}
#define PARTY_FRAGMENTS 17     /* a 200-byte party block */
#define MENU_FRAGMENTS 2       /* a 20-byte trade menu block */

/* RfuHandleReceiveCommand for the parts the scripts care about. */
static void handle(actor_t *a, int i, const slot_t *s, int64_t now)
{
    uint16_t cmd = s->w[0], v = s->w[1];
    if (cmd == 0) return;
    if (i != (a->parent ? 0 : -1)) a->last_peer_command = now;   /* any command but its own */
    if (cmd == CMD_STANDBY) { if (v == a->count) a->flag[i] = true; return; }
    if (i == 0 && a->parent) return;                              /* own echo */
    if (cmd == CMD_BLOCK_REQ && !a->parent)
    {
        if (a->in_round || now < a->busy_until) { ++a->refused_requests; return; }   /* Rfu_InitBlockSend: callback busy */
        push_block(a, 0x1111, PARTY_FRAGMENTS);
    }
    if (cmd == CMD_BLOCK_INIT) a->peer_block_count = v;
    if ((cmd & 0xff00) == CMD_BLOCK)
    {
        if ((cmd & 0x1f) == 0) a->peer_frag0_value = v;
        if ((cmd & 0x1f) + 1 == a->peer_block_count) ++a->peer_last_frag;
    }
}

static void run_script(actor_t *a, int64_t now)
{
    const step_t *st = &a->script[a->step];
    bool next = false;
    switch (st->kind)
    {
    case S_ROUND:
        if (a->parent)
        {
            if (a->sub == 0 && a->flag[1]) { push(a, CMD_STANDBY, a->count, 0); push(a, CMD_STANDBY, a->count, 0); a->sub = 1; }
        }
        else
        {
            if (a->sub == 0) { push(a, CMD_STANDBY, a->count, 0); a->round_timer = 0; a->sub = 1; a->in_round = true; }
            else if (a->round_timer > 60 && now - a->last_peer_command > FRAME_MS)
            { push(a, CMD_STANDBY, a->count, 0); a->round_timer = 0; }
            ++a->round_timer;
        }
        if (a->sub == 1 && a->flag[0] && a->flag[1])
        { a->flag[0] = a->flag[1] = false; ++a->count; a->in_round = false; next = true; }
        break;
    case S_WAIT:
        if (a->sub == 0) { a->until = now + st->ms; a->sub = 1; }
        else if (now >= a->until) next = true;
        break;
    case S_EXCHANGE:                                   /* one BufferTradeParties block pair */
        if (a->sub == 0)
        {
            a->peer_last_frag = 0;
            if (a->parent) { push(a, CMD_BLOCK_REQ, 1, 0); push_block(a, 0x2222, PARTY_FRAGMENTS); }
            a->sub = 1;
        }
        else if (a->peer_last_frag >= 1) next = true;
        break;
    case S_TRADE_FINISH:                               /* CB2_UpdateLinkTrade / CB2_WaitTradeComplete */
        if (a->sub == 0) { a->peer_last_frag = 0; a->peer_frag0_value = 0; push_block(a, LINK_READY_FINISH, MENU_FRAGMENTS); a->sub = 1; }
        else if (a->parent)
        {
            if (a->sub == 1 && a->peer_frag0_value == LINK_READY_FINISH) { a->sub = 2; a->until = now + 200; }
            else if (a->sub == 2 && now >= a->until) { push_block(a, LINK_CONFIRM_FINISH, MENU_FRAGMENTS); next = true; }
        }
        else if (a->peer_frag0_value == LINK_CONFIRM_FINISH) next = true;
        break;
    case S_MENU:
        ++a->menu_opens; next = true;
        break;
    case S_END:
        break;
    }
    if (next) { ++a->step; a->sub = 0; }
}

static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static void wr16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }

/* Bridge outbound queue, as pia_link_enqueue/next_outbound treat it: lossless,
   exact repeats of the last queued frame collapsed, idle when empty. */
static struct { uint8_t f[64][16]; int head, count; uint8_t last[16]; bool have_last; } bq;
static void bridge_enqueue(const uint8_t *f)
{
    if (bq.have_last && memcmp(bq.last, f, 16) == 0) return;
    if (bq.count == 64) { fprintf(stderr, "bridge queue full\n"); exit(2); }
    memcpy(bq.f[(bq.head + bq.count++) % 64], f, 16);
    memcpy(bq.last, f, 16); bq.have_last = true;
}

/* Parent -> child frames in flight (the Pico's FIFO keeps command frames in order). */
static struct { uint8_t f[64][73]; int head, count; } hq;
static void host_enqueue(const uint8_t *f)
{
    if (hq.count == 64) { fprintf(stderr, "host queue full\n"); exit(2); }
    memcpy(hq.f[(hq.head + hq.count++) % 64], f, 73);
}

#define POST_TRADE_CHILD {S_ROUND, 0}, {S_WAIT, -1}, {S_ROUND, 0}, {S_WAIT, 1160}, {S_ROUND, 0}, {S_WAIT, 1340}, {S_ROUND, 0}, {S_WAIT, 450}, {S_ROUND, 0}
#define POST_TRADE_PARENT_SIX {S_ROUND, 0}, {S_WAIT, 1300}, {S_ROUND, 0}, {S_ROUND, 0}, {S_WAIT, 1000}, {S_ROUND, 0}, {S_WAIT, 800}, {S_ROUND, 0}, {S_WAIT, 400}, {S_ROUND, 0}, {S_WAIT, 200}
#define POST_TRADE_PARENT_FIVE {S_ROUND, 0}, {S_WAIT, 1300}, {S_ROUND, 0}, {S_WAIT, 1000}, {S_ROUND, 0}, {S_WAIT, 800}, {S_ROUND, 0}, {S_WAIT, 400}, {S_ROUND, 0}, {S_WAIT, 200}
#define EXCHANGES {S_EXCHANGE, 0}, {S_EXCHANGE, 0}, {S_EXCHANGE, 0}, {S_EXCHANGE, 0}, {S_EXCHANGE, 0}

static const step_t child_script[] = {
    {S_ROUND, 0}, {S_EXCHANGE, 0}, {S_ROUND, 0},                     /* wireless link-up */
    {S_WAIT, 2000}, {S_ROUND, 0}, {S_ROUND, 0}, EXCHANGES,            /* sit down, trade menu */
    {S_MENU, 0}, {S_WAIT, 3000}, {S_ROUND, 0},                        /* pick, confirm, start */
    {S_WAIT, 1000}, {S_TRADE_FINISH, 0},
    POST_TRADE_CHILD, EXCHANGES,
    {S_MENU, 0}, {S_WAIT, 2000}, {S_ROUND, 0},                        /* second trade */
    {S_WAIT, 1000}, {S_TRADE_FINISH, 0},
    POST_TRADE_CHILD, EXCHANGES,
    {S_MENU, 0}, {S_WAIT, 1500}, {S_ROUND, 0},                        /* cancel out of the menu */
    {S_END, 0},
};

static const step_t parent_script_six[] = {
    {S_ROUND, 0}, {S_EXCHANGE, 0}, {S_ROUND, 0},
    {S_WAIT, 2000}, {S_ROUND, 0}, {S_ROUND, 0}, EXCHANGES,
    {S_MENU, 0}, {S_WAIT, 3000}, {S_ROUND, 0},
    {S_WAIT, 1000}, {S_TRADE_FINISH, 0},
    POST_TRADE_PARENT_SIX, EXCHANGES,
    {S_MENU, 0}, {S_WAIT, 2000}, {S_ROUND, 0},
    {S_WAIT, 1000}, {S_TRADE_FINISH, 0},
    POST_TRADE_PARENT_SIX, EXCHANGES,
    {S_MENU, 0}, {S_WAIT, 1500}, {S_ROUND, 0},
    {S_END, 0},
};

static const step_t parent_script_five[] = {
    {S_ROUND, 0}, {S_EXCHANGE, 0}, {S_ROUND, 0},
    {S_WAIT, 2000}, {S_ROUND, 0}, {S_ROUND, 0}, EXCHANGES,
    {S_MENU, 0}, {S_WAIT, 3000}, {S_ROUND, 0},
    {S_WAIT, 1000}, {S_TRADE_FINISH, 0},
    POST_TRADE_PARENT_FIVE, EXCHANGES,
    {S_MENU, 0}, {S_WAIT, 2000}, {S_ROUND, 0},
    {S_WAIT, 1000}, {S_TRADE_FINISH, 0},
    POST_TRADE_PARENT_FIVE, EXCHANGES,
    {S_MENU, 0}, {S_WAIT, 1500}, {S_ROUND, 0},
    {S_END, 0},
};

static int run(const char *label, scenario_t sc, int verbose)
{
    actor_t c = {.name = "child", .expect_tag = -1};
    actor_t p = {.name = "parent", .parent = true, .expect_tag = -1};
    step_t child_steps[sizeof(child_script) / sizeof(child_script[0])];
    memcpy(child_steps, child_script, sizeof(child_script));
    for (size_t i = 0; i < sizeof(child_steps) / sizeof(child_steps[0]); ++i)
        if (child_steps[i].kind == S_WAIT && child_steps[i].ms < 0) child_steps[i].ms = sc.save_ms;
    c.script = child_steps;
    c.block_busy_ms = sc.child_busy_ms;
    p.script = sc.parent_five_rounds ? parent_script_five : parent_script_six;
    memset(&bq, 0, sizeof(bq)); memset(&hq, 0, sizeof(hq));
    g_serial = 0;
    int child_frames = 0, queued_commands = 0;
    trade_shim_reset();
    bool fake_dropped = false;
    int lost_answer_copies = 0;

    int64_t now = 0, stalled_since = 0;
    for (int frame = 0; frame < 120000 / FRAME_MS; ++frame, now += FRAME_MS)
    {
        run_script(&c, now);
        run_script(&p, now);

        /* Child frame: one queued command, tag-stamped, or idle. */
        uint8_t cf[16] = {0x0e, 0x10};
        slot_t cs;
        if (pop(&c, &cs))
        {
            for (int i = 0; i < 7; ++i) wr16(cf + 2 + 2 * i, cs.w[i]);
            cf[2] = (uint8_t)((cf[2] & 0x1f) | (c.tag << 5));
            c.tag = (c.tag + 1) & 7;
            /* SendLastBlock keeps gRfu.callback busy until the last fragment's echo
               shows every fragment echoed; a lost echo keeps it busy much longer. */
            if ((cs.w[0] & 0xff00) == CMD_BLOCK && (cs.w[0] & 0x1f) + 1 == PARTY_FRAGMENTS) c.busy_until = now + c.block_busy_ms;
        }
        uint8_t raw[16];
        memcpy(raw, cf, 16);
        bool forward = true;
        if (sc.shim)
        {
            uint8_t reply[146];
            size_t r = trade_shim_child(cf, 16, now, reply, sizeof(reply), &forward);
            for (size_t o = 0; o + 73 <= r; o += 73) host_enqueue(reply + o);
        }
        if (forward) bridge_enqueue(cf);
        if (sc.duplicate_every && raw[3] != 0 && ++child_frames % sc.duplicate_every == 0)
        {
            /* The same GBA transfer handed over again. */
            uint8_t reply[146];
            bool again = true;
            if (sc.shim) trade_shim_child(raw, 16, now, reply, sizeof(reply), &again);
            if (again) bridge_enqueue(raw);
        }
        if (sc.shim)
        {
            uint8_t extra[16];
            if (trade_shim_inject(now, extra, sizeof(extra)))
            {
                if (sc.lose_first_fake && !fake_dropped) fake_dropped = true;
                else bridge_enqueue(extra);
            }
        }

        /* Bridge -> parent: one frame per tick. */
        uint8_t pf[16] = {0x0e, 0x10};
        if (bq.count)
        {
            memcpy(pf, bq.f[bq.head], 16); bq.head = (bq.head + 1) % 64; --bq.count;
            if (sc.drop_queued_command && pf[3] != 0 && ++queued_commands == sc.drop_queued_command)
                memset(pf + 2, 0, 14);                /* lost before it was sent: nothing reaches the parent */
            if (sc.shim) trade_shim_stamp(pf, 16);   /* as pia_link does when the frame leaves */
        }
        if (sc.shim) trade_shim_poll(now);
        memset(&p.recv, 0, sizeof(p.recv));
        if (pf[3] != 0)
        {
            int tag = pf[2] >> 5;
            if (p.expect_tag >= 0 && tag != p.expect_tag)
            {
                ++p.tag_errors; ++p.tag_errors_total;
                if (p.tag_errors > 4) { printf("  %s: FAIL parent tag sequence error at %.2fs\n", label, now / 1000.0); return 1; }
            }
            else
            {
                p.expect_tag = (tag + 1) & 7; p.tag_errors = 0;
                for (int i = 0; i < 7; ++i) p.recv[1].w[i] = rd16(pf + 2 + 2 * i);
                p.recv[1].w[0] &= 0xff1f;
                if (p.recv[1].w[6] != 0)
                {
                    if (p.recv[1].w[6] <= p.last_serial) ++p.duplicate_accepts;
                    else p.last_serial = p.recv[1].w[6];
                }
            }
        }
        /* Parent frame: own command in slot 0 (also its own recv[0]), child echo in slot 1. */
        slot_t ps;
        if (pop(&p, &ps)) p.recv[0] = ps;
        handle(&p, 0, &p.recv[0], now);
        handle(&p, 1, &p.recv[1], now);
        uint8_t hf[73] = {0x46, 0x00, 0x05};
        for (int i = 0; i < 2; ++i)
            for (int j = 0; j < 7; ++j) wr16(hf + 3 + 14 * i + 2 * j, p.recv[i].w[j]);
        if (sc.shim)
        {
            uint8_t pre[8 * 73];
            size_t r = trade_shim_host(hf, sizeof(hf), now, pre, sizeof(pre));
            for (size_t o = 0; o + 73 <= r; o += 73) host_enqueue(pre + o);
            uint8_t repeat[73];
            if (trade_shim_host_inject(now, repeat, sizeof(repeat))) host_enqueue(repeat);
        }
        /* The Sooralator dropping the parent's own answer to one round, both copies. */
        bool dropped = sc.lose_parent_answer && p.recv[0].w[0] == CMD_STANDBY && p.recv[0].w[1] == sc.lose_parent_answer && lost_answer_copies < 2;
        if (dropped) ++lost_answer_copies;
        else host_enqueue(hf);

        /* Pico -> child: one frame per tick. */
        memset(&c.recv, 0, sizeof(c.recv));
        if (hq.count)
        {
            const uint8_t *f = hq.f[hq.head]; hq.head = (hq.head + 1) % 64; --hq.count;
            for (int i = 0; i < 2; ++i)
                for (int j = 0; j < 7; ++j) c.recv[i].w[j] = rd16(f + 3 + 14 * i + 2 * j);
        }
        handle(&c, 0, &c.recv[0], now);
        handle(&c, 1, &c.recv[1], now);

        if (verbose && (p.recv[0].w[0] || p.recv[1].w[0]))
            printf("  %7.3f parent s0=%04x/%u s1=%04x/%u  (C=%d P=%d)\n", now / 1000.0,
                   p.recv[0].w[0], p.recv[0].w[1], p.recv[1].w[0], p.recv[1].w[1], c.count, p.count);

        if (c.script[c.step].kind == S_END && p.script[p.step].kind == S_END)
        {
            printf("  %s: both scripts finished at %.1fs, child count %d, parent count %d, menus %d/%d, tag errors %d, refused requests %d, duplicates acted on %d\n",
                   label, now / 1000.0, c.count, p.count, c.menu_opens, p.menu_opens, p.tag_errors_total, c.refused_requests, p.duplicate_accepts);
            return p.duplicate_accepts ? 1 : 0;
        }
        bool moving = c.recv[0].w[0] || c.recv[1].w[0] || pf[3] != 0;
        if (moving) stalled_since = now;
        else if (now - stalled_since > 20000)
        {
            printf("  %s: STALLED at %.1fs: child step %d (%s, count %d), parent step %d (%s, count %d), menus %d/%d\n",
                   label, now / 1000.0, c.step, c.script[c.step].kind == S_EXCHANGE ? "waiting for party request" : "standby round",
                   c.count, p.step, p.script[p.step].kind == S_ROUND ? "standby round" : "other", p.count, c.menu_opens, p.menu_opens);
            return 1;
        }
    }
    printf("  %s: timed out\n", label);
    return 1;
}

/* Frame builders for the unit checks. */
static void host_request_frame(uint8_t *f, uint16_t type)
{
    memset(f, 0, 73);
    f[0] = 0x46; f[1] = 0x00; f[2] = 0x05;
    wr16(f + 3, CMD_BLOCK_REQ); wr16(f + 5, type);
}
static void child_command_frame(uint8_t *f, uint8_t tag, uint16_t cmd, uint16_t v1)
{
    memset(f, 0, 16);
    f[0] = 0x0e; f[1] = 0x10;
    wr16(f + 2, cmd); wr16(f + 4, v1);
    f[2] = (uint8_t)((f[2] & 0x1f) | (tag << 5));
}

/* A party request whose every INIT copy was lost but whose fragments all arrived
   is answered: no repeat. A request the child never answered is repeated once it
   has been silent long enough, and not while it is still sending something. */
static int unit_request_repeat(void)
{
    int failures = 0;
    uint8_t hf[73], cf[16], pre[8 * 73], reply[146], out[73];

    trade_shim_reset();
    host_request_frame(hf, 1);
    trade_shim_host(hf, sizeof(hf), 1000, pre, sizeof(pre));
    for (int i = 0; i < 17; ++i)
    {
        child_command_frame(cf, (uint8_t)(i & 7), (uint16_t)(CMD_BLOCK | i), 0x1111);
        bool fwd;
        trade_shim_child(cf, 16, 1020 + 17 * i, reply, sizeof(reply), &fwd);
    }
    if (trade_shim_host_inject(5000, out, sizeof(out)) != 0) { printf("  unit: FAIL request repeated although its block arrived\n"); ++failures; }

    trade_shim_reset();
    host_request_frame(hf, 1);
    trade_shim_host(hf, sizeof(hf), 1000, pre, sizeof(pre));
    child_command_frame(cf, 0, CMD_STANDBY, 3);
    bool fwd;
    trade_shim_child(cf, 16, 1500, reply, sizeof(reply), &fwd);
    if (trade_shim_host_inject(1800, out, sizeof(out)) != 0) { printf("  unit: FAIL request repeated while the child was active\n"); ++failures; }
    if (trade_shim_host_inject(2300, out, sizeof(out)) != 73) { printf("  unit: FAIL refused request not repeated\n"); ++failures; }
    if (trade_shim_host_inject(2400, out, sizeof(out)) != 0) { printf("  unit: FAIL request repeated back to back\n"); ++failures; }

    /* A frame handed over twice is not forwarded again; tags are stamped only on frames
       that are sent, consecutively, whatever the GBA's own tags were. */
    trade_shim_reset();
    uint8_t a[16], b[16];
    bool fa, fdup, fb;
    child_command_frame(a, 5, CMD_STANDBY, 1);
    trade_shim_child(a, 16, 100, reply, sizeof(reply), &fa);
    child_command_frame(cf, 5, CMD_STANDBY, 1);
    trade_shim_child(cf, 16, 101, reply, sizeof(reply), &fdup);
    child_command_frame(b, 0, CMD_BLOCK | 3, 2);   /* an untagged resend */
    trade_shim_child(b, 16, 102, reply, sizeof(reply), &fb);
    trade_shim_stamp(a, 16);
    trade_shim_stamp(b, 16);
    uint8_t idle[16] = {0x0e, 0x10};
    trade_shim_stamp(idle, 16);                     /* idle frames carry no tag */
    if (!fa || fdup || !fb || (a[2] >> 5) != 0 || (b[2] >> 5) != 1 || (b[2] & 0x1f) != 3 || idle[2] != 0)
    { printf("  unit: FAIL duplicate/stamp fa=%d fdup=%d fb=%d tags %u %u\n", fa, fdup, fb, a[2] >> 5, b[2] >> 5); ++failures; }

    printf("  unit checks: %s\n", failures ? "FAILED" : "ok");
    return failures;
}

int main(int argc, char **argv)
{
    (void)argv;
    int verbose = argc > 1;
    int failures = 0;
    trade_shim_boot(0);
    printf("without shim, cartridge save 6.5 s (expect the stall the hardware shows):\n");
    if (run("no shim", (scenario_t){.save_ms = 6500}, 0) == 0) { printf("  unexpected: no stall without the shim\n"); ++failures; }
    printf("with shim, cartridge save 6.5 s:\n");
    failures += run("shim, slow save", (scenario_t){.shim = true, .save_ms = 6500}, verbose);
    printf("with shim, cartridge save 0.8 s:\n");
    failures += run("shim, fast save", (scenario_t){.shim = true, .save_ms = 800}, verbose);
    printf("with shim, cartridge save 12 s:\n");
    failures += run("shim, very slow save", (scenario_t){.shim = true, .save_ms = 12000}, 0);
    printf("with shim, the injected round never reaches the Switch's game once:\n");
    failures += run("shim, lost fake", (scenario_t){.shim = true, .save_ms = 6500, .lose_first_fake = true}, verbose);
    printf("with shim, the Switch's answer to the round after its save is never emitted (both copies):\n");
    failures += run("shim, lost answer 7", (scenario_t){.shim = true, .save_ms = 6500, .lose_parent_answer = 7}, verbose);
    printf("with shim, the Switch's answer to the last cartridge round is never emitted (both copies):\n");
    failures += run("shim, lost answer 9", (scenario_t){.shim = true, .save_ms = 6500, .lose_parent_answer = 9}, verbose);
    printf("with shim against a parent that does not need an extra round (must stay out of the way):\n");
    failures += run("shim, five-round parent", (scenario_t){.shim = true, .save_ms = 6500, .parent_five_rounds = true}, verbose);
    printf("without shim, the child's link layer is still busy when each party request arrives (expect the deadlock):\n");
    if (run("no shim, busy child", (scenario_t){.save_ms = 6500, .child_busy_ms = 150}, 0) == 0) { printf("  unexpected: no deadlock without the shim\n"); ++failures; }
    printf("with shim, same busy child (the refused requests must be repeated):\n");
    failures += run("shim, busy child", (scenario_t){.shim = true, .save_ms = 6500, .child_busy_ms = 150}, verbose);
    printf("with shim, the adapter hands every 5th command frame over twice (none may be acted on twice):\n");
    failures += run("shim, duplicated frames", (scenario_t){.shim = true, .save_ms = 6500, .duplicate_every = 5}, verbose);
    printf("with shim, duplicated frames and a busy child together:\n");
    failures += run("shim, duplicates + busy", (scenario_t){.shim = true, .save_ms = 6500, .duplicate_every = 3, .child_busy_ms = 150}, verbose);
    printf("with shim, the bridge's queue loses a child command before sending it (the parent's tag check must not trip):\n");
    failures += run("shim, queue drop", (scenario_t){.shim = true, .save_ms = 6500, .drop_queued_command = 120}, verbose);
    failures += run("shim, queue drop 2", (scenario_t){.shim = true, .save_ms = 6500, .drop_queued_command = 250}, verbose);
    printf("unit checks:\n");
    failures += unit_request_repeat();
    printf(failures ? "FAILED\n" : "PASS\n");
    return failures ? 1 : 0;
}
