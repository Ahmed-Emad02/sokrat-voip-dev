#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <sys/uio.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

/* Only the Asterisk ABI, allocator, clock, thread wake and serial boundary
 * are replaced. All queue ownership, call release and restart decisions below
 * are compiled from the materialized, release-patched driver sources. */
#define EXPORT_DECL extern
#define EXPORT_DEF
#define INLINE_DECL static inline
#define ASTERISK_VERSION_NUM 180000
#define AST_MAX_CONTEXT 80
#define AST_MAX_EXTENSION 80
#define MAX_LANGUAGE 40
#define AST_FRIENDLY_OFFSET 64
#define ITEMS_OF(a) (sizeof(a) / sizeof((a)[0]))
#define STRLEN(a) (sizeof(a) - 1)
#define AST_LIST_ENTRY(t) struct { struct t *next; }
#define AST_LIST_HEAD_NOLOCK(n,t) struct n { struct t *first, *last; }
#define AST_RWLIST_HEAD(n,t) AST_LIST_HEAD_NOLOCK(n,t)
#define AST_LIST_HEAD_INIT_NOLOCK(h) ((h)->first = (h)->last = NULL)
#define AST_LIST_FIRST(h) ((h)->first)
#define AST_LIST_NEXT(e,f) ((e)->f.next)
#define AST_LIST_TRAVERSE(h,v,f) for ((v)=(h)->first; (v); (v)=(v)->f.next)
#define AST_LIST_INSERT_HEAD(h,e,f) do { (e)->f.next=(h)->first; if (!(h)->first) (h)->last=(e); (h)->first=(e); } while (0)
#define AST_LIST_INSERT_TAIL(h,e,f) do { (e)->f.next=NULL; if ((h)->last) (h)->last->f.next=(e); else (h)->first=(e); (h)->last=(e); } while (0)
#define AST_LIST_INSERT_AFTER(h,p,e,f) do { (e)->f.next=(p)->f.next; (p)->f.next=(e); if ((h)->last==(p)) (h)->last=(e); } while (0)
#define AST_LIST_REMOVE_HEAD(h,f) ({ __typeof__((h)->first) _e=(h)->first; if (_e) { (h)->first=_e->f.next; if (!(h)->first) (h)->last=NULL; } _e; })
#define AST_LIST_REMOVE(h,e,f) do { __typeof__((h)->first) _p=NULL, _c=(h)->first; while (_c && _c!=(e)) { _p=_c; _c=_c->f.next; } if (_c) { if (_p) _p->f.next=_c->f.next; else (h)->first=_c->f.next; if ((h)->last==_c) (h)->last=_p; } } while (0)
#define AST_LIST_TRAVERSE_SAFE_BEGIN(h,v,f) { __typeof__(h) _h=(h); __typeof__(v) _prev=NULL; for ((v)=(h)->first; (v); _prev=(v),(v)=(v)->f.next) { __typeof__(v) _cur=(v);
#define AST_LIST_REMOVE_CURRENT(f) do { if (_prev) _prev->f.next=_cur->f.next; else _h->first=_cur->f.next; if (_h->last==_cur) _h->last=_prev; } while (0)
#define AST_LIST_TRAVERSE_SAFE_END } }
typedef int ast_mutex_t;
struct ast_frame { int unused; };
struct ast_jb_conf { int unused; };
struct ast_config;
struct ast_channel { void *tech_pvt; int controls, control, hangups, state; };
enum ast_control_frame_type { AST_CONTROL_BUSY=1, AST_CONTROL_CONGESTION, AST_CONTROL_PROGRESS, AST_CONTROL_RINGING, AST_CONTROL_UNHOLD, AST_CONTROL_ANSWER, AST_CONTROL_HOLD };
#define AST_STATE_DIALING 1
#define AST_STATE_RINGING 2
#define AST_STATE_UP 3
#define LOG_ERROR 1
#define LOG_WARNING 2
#define LOG_NOTICE 3
#define CLCC_CALL_TYPE_VOICE 0
#define ast_debug(...) ((void)0)
#define ast_log(...) ((void)0)
#define ast_verb(...) ((void)0)
#define DSP_DIGITMODE_DTMF 1
#define DSP_DIGITMODE_RELAXDTMF 2
#define DSP_FEATURE_DIGIT_DETECT 1
static const char *enum2str_def(int n, const char *const *values, size_t count, const char *fallback) { return n >= 0 && (size_t)n < count ? values[n] : fallback; }
static const char *enum2str(int n, const char *const *values, size_t count) { return enum2str_def(n, values, count, "unknown"); }
static struct timeval wall_now={100,0};
static struct timespec mono_now={100,0};
static struct timeval ast_tv(long s, long us) { return (struct timeval){s,us}; }
static struct timeval ast_tvnow(void) { return wall_now; }
static struct timeval ast_tvadd(struct timeval a, struct timeval b) { a.tv_sec+=b.tv_sec; a.tv_usec+=b.tv_usec; if (a.tv_usec>=1000000) { a.tv_sec++; a.tv_usec-=1000000; } return a; }
static long ast_tvdiff_ms(struct timeval a, struct timeval b) { return (a.tv_sec-b.tv_sec)*1000+(a.tv_usec-b.tv_usec)/1000; }
static int fake_clock_gettime(clockid_t id, struct timespec *out) { assert(id==CLOCK_MONOTONIC); *out=mono_now; return 0; }
static void advance_ms(long ms) { mono_now.tv_nsec += ms*1000000L; while (mono_now.tv_nsec>=1000000000L) { mono_now.tv_nsec-=1000000000L; mono_now.tv_sec++; } }
static int fail_alloc=-1, fail_write;
static void *driver_malloc(size_t size) { if (fail_alloc==0) return NULL; if (fail_alloc>0) --fail_alloc; return malloc(size); }
static char *driver_strdup(const char *s) { char *p=driver_malloc(strlen(s)+1); if (p) strcpy(p,s); return p; }
#define ast_malloc driver_malloc
#define ast_calloc calloc
#define ast_strdup driver_strdup
#define ast_free free
#define clock_gettime fake_clock_gettime
static char wire[16384];
static size_t wire_len;
static int eagain_budget, eintr_budget, stall_forever, partial_once, poll_ready, eintr_forever, slow_progress;
static ssize_t serial_write(int fd, const void *buf, size_t len) { (void)fd;
  if (eintr_forever) { advance_ms(10); errno=EINTR; return -1; }
  if (slow_progress && len>1) { advance_ms(100); len=1; }
  if (eintr_budget>0) { --eintr_budget; errno=EINTR; return -1; }
  if (eagain_budget>0) { --eagain_budget; errno=EAGAIN; return -1; }
  if (stall_forever) { errno=EAGAIN; return -1; }
  if (partial_once && len>2) { partial_once=0; memcpy(wire+wire_len,buf,2); wire_len+=2; wire[wire_len]=0; stall_forever=1; return 2; }
  if (fail_write) { errno=EIO; return -1; }
  assert(wire_len+len<sizeof(wire)); memcpy(wire+wire_len,buf,len); wire_len+=len; wire[wire_len]=0; return len; }
static int fake_poll(struct pollfd *fds, nfds_t nfds, int timeout) {
  assert(nfds==1);
  if (poll_ready) { fds[0].revents=POLLOUT; return 1; }
  /* Advancing the fake monotonic clock models an endpoint that never becomes
   * writable; the bounded write must stop at its deadline. */
  if (timeout>0) advance_ms(timeout);
  else advance_ms(50);
  return 0;
}
#define write serial_write
#define poll fake_poll
#include "driver-types.inc"

public_state_t public_state, *gpublic=&public_state;
const char *const dev_state_strs[4]={"stopped","restarted","removed","started"};
static int wakeups;
static struct pvt *wake_device;
static int discovery_restart(public_state_t *p) { assert(p==gpublic); assert(wake_device && wake_device->outgoing_sms==0 && wake_device->state.at_tasks==0 && wake_device->state.at_cmds==0); ++wakeups; return 0; }
static int chan_dongle_err;
#define E_QUEUE 1
static const char cmd_at[]="AT\r";
static const char cmd_clcc[]="AT+CLCC\r";
static const char cmd_chld1x[]="AT+CHLD=1%d\r";
const char *at_res2str(at_res_t r) { (void)r; return "response"; }
static void ast_channel_set_fd(struct ast_channel *c, int n, int fd) { (void)c; (void)n; (void)fd; }
static int ast_timer_fd(struct ast_timer *t) { (void)t; return -1; }
static int ast_timer_set_rate(struct ast_timer *t, unsigned rate) { (void)t; (void)rate; return 0; }
static void ast_timer_close(struct ast_timer *t) { (void)t; }
static void ast_dsp_digitreset(struct ast_dsp *d) { (void)d; }
static void ast_dsp_free(struct ast_dsp *d) { free(d); }
static struct ast_dsp *ast_dsp_new(void) { abort(); }
static void ast_dsp_set_features(struct ast_dsp *d, int v) { (void)d; (void)v; }
static void ast_dsp_set_digitmode(struct ast_dsp *d, int v) { (void)d; (void)v; }
static int ast_queue_control(struct ast_channel *c, int control) { c->controls++; c->control=control; return 0; }
static void ast_channel_tech_pvt_set(struct ast_channel *c, void *p) { c->tech_pvt=p; }
static void ast_channel_hangupcause_set(struct ast_channel *c, int cause) { (void)c; (void)cause; }
static int ast_queue_hangup(struct ast_channel *c) { c->hangups++; return 0; }
static int ast_setstate(struct ast_channel *c, int state) { c->state=state; return 0; }
static void manager_event_device_status(const char *id, const char *status) { (void)id; (void)status; }
static void manager_event_call_state_change(const char *id, int idx, const char *state) { (void)id; (void)idx; (void)state; }
static void ast_slinear_saturated_add(short *a, short *b) { int n=*a+*b; *a=n>SHRT_MAX?SHRT_MAX:n<SHRT_MIN?SHRT_MIN:n; }
int queue_control_channel(struct cpvt *, enum ast_control_frame_type);
int queue_hangup(struct ast_channel *, int);
void change_channel_state(struct cpvt *, unsigned, int);

#define ast_strlen_zero(s) (!(s) || !*(s))
static void maybe_enable_e173_voice(struct pvt *p) { (void)p; }
int at_poll_sms(struct pvt *p) { (void)p; return 0; }
void at_retrieve_next_sms(struct cpvt *p, at_cmd_suppress_error_t e) { (void)p; (void)e; }

#define SMSDB_PAYLOAD_MAX_LEN 4096
#define SMSDB_DST_MAX_LEN 256
typedef struct { const char *name; char *value; } channel_var_t;
static volatile int last_sms_uid, sms_put_calls;
static ssize_t smsdb_outgoing_part_put(int uid, int result, char *dst, char *payload) { last_sms_uid=uid; sms_put_calls++; (void)result; (void)dst; (void)payload; return -1; }
#define at_parse_cmgs(str) 7
#define start_local_channel(...) ((void)0)
#define manager_event_report(...) ((void)0)
#define at_response_rssi(...) 0
#define at_response_mode(...) 0
#define at_response_orig(...) 0
#define at_response_cend(...) 0

#define at_response_creg(...) 0
#define at_response_cops(...) 0
#define at_response_csq(...) 0
#define at_response_error(...) 0
#define at_response_ring(...) 0
#define at_response_smmemfull(...) 0
#define at_response_cdsi(...) 0
#define at_response_cmti(...) 0
#define at_response_cmgr(...) 0
#define at_response_cusd(...) 0

#define at_response_ccwa(...) 0
#define at_response_cpin(...) 0
#define at_response_cnum(...) 0
#define at_response_csca(...) 0
#define at_response_cgmi(...) 0
#define at_response_cgmm(...) 0
#define at_response_cgmr(...) 0
#define at_response_cgsn(...) 0
#define at_response_cimi(...) 0
int at_parse_csq(const char *, int *);
int at_parse_clcc(char *, unsigned *, unsigned *, unsigned *, unsigned *, unsigned *, char **, unsigned *);
static int at_response_clcc(struct pvt *, char *);
void pvt_on_create_1st_channel(struct pvt *p) { (void)p; }
int at_enqueue_flip_hold(struct cpvt *c) { (void)c; return 0; }
int at_enqueue_reject_waiting(struct cpvt *c) { (void)c; return 0; }
int at_enqueue_conference(struct cpvt *c) { (void)c; return 0; }
static int ast_channel_rings(struct ast_channel *a) { (void)a; return 0; }
static void ast_channel_rings_set(struct ast_channel *a, int n) { (void)a; (void)n; }
static int incoming_started;
static int start_pbx(struct pvt *p, const char *number, int idx, call_state_t state) {
  (void)number; incoming_started++;
  return cpvt_alloc(p,idx,CALL_DIR_INCOMING,state) ? 0 : -1;
}


#include "driver-code.inc"

static void init(struct pvt *p) { memset(p,0,sizeof(*p)); wake_device=p; p->sys_chan.pvt=p; p->incoming_sms_index=-1U; p->data_fd=123; p->audio_fd=-1; p->current_state=DEV_STATE_STARTED; p->desired_state=DEV_STATE_STARTED; p->restart_time=RESTATE_TIME_CONVENIENT; p->settings.shared.initstate=DEV_STATE_STARTED; wire_len=0; wire[0]=0; wakeups=0; fail_alloc=-1; fail_write=0; eagain_budget=0; eintr_budget=0; stall_forever=0; partial_once=0; poll_ready=1; eintr_forever=0; slow_progress=0; wall_now=(struct timeval){100,0}; mono_now=(struct timespec){100,0}; last_sms_uid=-1; sms_put_calls=0; }
static void enqueue(struct cpvt *c, at_cmd_t cmd, at_res_t res, const char *data) { at_queue_cmd_t q=ATQ_CMD_DECLARE_ST(CMD_AT,data); q.cmd=cmd; q.res=res; q.length=strlen(data); assert(at_queue_insert_const(c,&q,1,0)==0); }
static void complete(struct pvt *p, at_res_t res) { if (res==RES_SMS_PROMPT) assert(at_response_sms_prompt(p)==0); else at_queue_handle_result(p,res); assert(at_queue_run(p)==0); }
static void part(struct pvt *p) { assert(at_enqueue_pdu(&p->sys_chan,"0011",4,1,17)==0); }
static void finish_part(struct pvt *p, at_res_t result) { complete(p,RES_SMS_PROMPT); assert(at_queue_head_cmd(p)->cmd==CMD_AT_SMSTEXT); complete(p,result); }
static struct cpvt *call(struct pvt *p, struct ast_channel *a, int idx) { struct cpvt *c=calloc(1,sizeof(*c)); assert(c); c->pvt=p; c->channel=a; c->state=CALL_STATE_DIALING; c->call_idx=idx; c->rd_pipe[0]=c->rd_pipe[1]=-1; if(a) a->tech_pvt=c; AST_LIST_INSERT_TAIL(&p->chans,c,entry); p->state.chansno++; p->state.chan_count[c->state]++; return c; }
static void expect_wire(const char *text, int present) { assert((strstr(wire,text)!=NULL)==present); }

/* ── Finding 1: a skipped command's late OK cannot acknowledge the next one ── */
static void skip_barrier_one(at_cmd_t skipped_cmd, const char *skipped_text, const char *next_text) {
  struct pvt p; struct ast_channel a={0}; init(&p);
  struct cpvt *c=call(&p,&a,1);
  change_channel_state(c,CALL_STATE_ACTIVE,0);
  enqueue(c,CMD_AT_DTMF,RES_OK,"AT^DTMF=1,1\r");
  at_queue_cmd_t q=ATQ_CMD_DECLARE_ST(CMD_AT_CHUP,"AT+CHUP\r");
  assert(at_queue_insert_const(c,&q,1,1)==0);
  wire_len=0; wire[0]=0;

  /* Skip path is now a bounded CSQ barrier, not an immediate next write. */
  assert(at_queue_skip_recover(&p,RES_PARSE_ERROR,"test skip")==0);
  expect_wire("AT+CSQ\r",1);
  expect_wire(next_text,0);
  assert(at_queue_head_cmd(&p)->cmd==CMD_AT_CHUP);
  assert(at_queue_head_cmd(&p)->length>0);
  assert(p.state.chansno==1);

  /* A late terminal reply from the skipped command is consumed by the barrier
   * and must not release the call or transmit CHUP. */
  assert(at_queue_recovery_response(&p,RES_OK,0)==0);
  assert(p.state.chansno==1);
  expect_wire(next_text,0);

  int rssi; assert(at_parse_csq("+CSQ: 18,99",&rssi)==0);
  assert(at_queue_recovery_response(&p,RES_CSQ,1)==0);
  assert(at_queue_recovery_response(&p,RES_OK,0)==0);
  assert(p.at_recovery==0);
  assert(p.state.chansno==1);
  assert(at_queue_run(&p)==0);
  expect_wire(next_text,1);
  assert(p.state.chansno==1);

  /* Only the next command's own OK may release its call. Simulate the local
   * Asterisk channel having been detached by a local hangup. */
  c->channel=NULL; a.tech_pvt=NULL;
  assert(at_response_ok(&p,RES_OK)==0);
  assert(p.state.chansno==0);
  at_queue_flush(&p);
}
static void late_terminal_ok_cannot_ack_next(void) {
  skip_barrier_one(CMD_AT_DTMF,"AT^DTMF=1,1\r","AT+CHUP\r");
  /* COPS and CCWA share the same generalized barrier. */
  struct pvt p; struct ast_channel a={0}; init(&p);
  struct cpvt *c=call(&p,&a,2);
  change_channel_state(c,CALL_STATE_ACTIVE,0);
  enqueue(c,CMD_AT_COPS,RES_COPS,"AT+COPS?\r");
  at_queue_cmd_t q=ATQ_CMD_DECLARE_ST(CMD_AT_CHUP,"AT+CHUP\r");
  assert(at_queue_insert_const(c,&q,1,1)==0);
  wire_len=0; wire[0]=0;
  assert(at_queue_skip_recover(&p,RES_PARSE_ERROR,"COPS timeout")==0);
  expect_wire("AT+CHUP\r",0);
  assert(at_queue_recovery_response(&p,RES_OK,0)==0);
  expect_wire("AT+CHUP\r",0);
  assert(at_queue_recovery_response(&p,RES_CSQ,1)==0);
  assert(at_queue_recovery_response(&p,RES_OK,0)==0);
  assert(at_queue_run(&p)==0);
  expect_wire("AT+CHUP\r",1);
  assert(p.state.chansno==1);
  c->channel=NULL; a.tech_pvt=NULL;
  assert(at_response_ok(&p,RES_OK)==0);
  assert(p.state.chansno==0);
  at_queue_flush(&p);
}
static void clcc_barrier_still_holds(void) {
  struct pvt p; init(&p); assert(at_enqueue_clcc(&p.sys_chan)==0); enqueue(&p.sys_chan,CMD_AT_CMGR,RES_CMGR,"AT+CMGR=1\r");
  wall_now.tv_sec+=6; assert(at_queue_timeout(&p)==0);
  assert(at_queue_recover(&p)==0); expect_wire("AT+CSQ\r",1); expect_wire("AT+CMGR",0);
  const at_queue_task_t *held=at_queue_head_task(&p);
  assert(at_queue_recovery_response(&p,RES_OK,0)==0);
  assert(at_queue_head_task(&p)==held);
  int rssi; assert(at_parse_csq("+CSQ: 18,99",&rssi)==0);
  assert(at_queue_recovery_response(&p,RES_CSQ,1)==0);
  assert(at_queue_recovery_response(&p,RES_OK,0)==0);
  assert(at_queue_head_cmd(&p)->cmd==CMD_AT_CMGR);
  assert(at_queue_run(&p)==0);
  expect_wire("AT+CMGR=1\r",1);
  at_queue_flush(&p);
}

/* ── Finding 2: unsent call-owned DTMF never survives its call ─────────────── */
static void dtmf_cancelled_at_release(void) {
  struct pvt p; struct ast_channel a={0}; init(&p);
  struct cpvt *c=call(&p,&a,1);
  change_channel_state(c,CALL_STATE_ACTIVE,0);
  enqueue(&p.sys_chan,CMD_AT_CSQ,RES_OK,"AT+CSQ\r");
  assert(at_enqueue_dtmf(c,'1')==0);
  assert(at_enqueue_dtmf(c,'2')==0);
  assert(p.state.at_tasks==3 && p.state.at_cmds==3);
  change_channel_state(c,CALL_STATE_RELEASED,0);
  assert(p.state.chansno==0 && a.tech_pvt==NULL);
  assert(wakeups==0);
  /* Only the unrelated CSQ task remains; both DTMF tasks were freed. */
  assert(p.state.at_tasks==1 && p.state.at_cmds==1);
  wire_len=0; wire[0]=0;
  complete(&p,RES_OK);
  expect_wire("AT^DTMF",0);
  assert(p.state.at_tasks==0 && p.state.at_cmds==0);
  at_queue_flush(&p);
}
static void dtmf_dispatch_requires_active_same_index(void) {
  struct pvt p; struct ast_channel a={0}; init(&p);
  struct cpvt *c=call(&p,&a,7);
  change_channel_state(c,CALL_STATE_ACTIVE,0);
  assert(at_enqueue_dtmf(c,'5')==0);
  assert(at_queue_run(&p)==0);
  expect_wire("AT^DTMF=7,5\r",1);
  complete(&p,RES_OK);

  /* The call index still exists but is no longer ACTIVE: dispatch drops it. */
  enqueue(&p.sys_chan,CMD_AT_CSQ,RES_OK,"AT+CSQ\r");
  struct ast_channel b={0};
  struct cpvt *d=call(&p,&b,8);
  change_channel_state(d,CALL_STATE_ACTIVE,0);
  assert(at_enqueue_dtmf(d,'9')==0);
  change_channel_state(d,CALL_STATE_ONHOLD,0);
  wire_len=0; wire[0]=0;
  complete(&p,RES_OK);
  expect_wire("AT^DTMF=8,9\r",0);
  assert(p.state.at_tasks==0 && p.state.at_cmds==0);

  /* An ACTIVE owner whose radio index changed must not reuse an old digit. */
  change_channel_state(d,CALL_STATE_ACTIVE,0);
  enqueue(&p.sys_chan,CMD_AT_CSQ,RES_OK,"AT+CSQ\r");
  assert(at_enqueue_dtmf(d,'4')==0);
  d->call_idx=9;
  wire_len=0; wire[0]=0;
  complete(&p,RES_OK);
  expect_wire("AT^DTMF",0);
  assert(p.state.at_tasks==0);
  at_queue_flush(&p);
  cpvt_free(c);
  cpvt_free(d);
}

/* ── Finding 3: bounded readiness-driven writes, no replay ─────────────────── */
static void transient_backpressure_is_not_a_failure(void) {
  struct pvt p; init(&p);
  eagain_budget=10; eintr_budget=3;
  at_queue_cmd_t q=ATQ_CMD_DECLARE_ST(CMD_AT_CHUP,"AT+CHUP\r");
  assert(at_queue_insert_const(&p.sys_chan,&q,1,0)==0);
  assert(eagain_budget==0 && eintr_budget==0);
  assert(strcmp(wire,"AT+CHUP\r")==0);
  assert(p.state.at_tasks==1 && p.at_write_stalls==0);
  at_queue_flush(&p);
}
static void permanent_error_is_still_a_failure(void) {
  struct pvt p; init(&p); fail_write=1;
  at_queue_cmd_t q=ATQ_CMD_DECLARE_ST(CMD_AT_CHUP,"AT+CHUP\r");
  assert(at_queue_insert_const(&p.sys_chan,&q,1,0)!=0);
  assert(wire_len==0 && p.state.at_tasks==0 && p.state.at_cmds==0);
  fail_write=0; at_queue_flush(&p);
}
static void zero_progress_stalls_are_bounded_and_keep_ownership(void) {
  struct pvt p; init(&p); stall_forever=1; poll_ready=0;
  at_queue_cmd_t q=ATQ_CMD_DECLARE_ST(CMD_AT_CHUP,"AT+CHUP\r");
  /* First attempt: bounded write returns TEMP_ZERO; command stays queued. */
  assert(at_queue_insert_const(&p.sys_chan,&q,1,0)==0);
  assert(wire_len==0 && p.state.at_tasks==1 && p.state.at_cmds==1);
  assert(p.at_write_stalls==1);
  /* Retry up to the bounded limit, then cancel exactly once. */
  for (unsigned i=0;i<6;i++) { assert(p.state.at_tasks==1); assert(at_queue_run(&p)==0); }
  assert(p.state.at_tasks==1);
  assert(at_queue_run(&p)!=0);
  assert(p.state.at_tasks==0 && p.state.at_cmds==0);
  assert(wire_len==0);
  at_queue_flush(&p);
}
static void partial_write_is_never_replayed(void) {
  struct pvt p; init(&p); partial_once=1; stall_forever=0; poll_ready=0;
  at_queue_cmd_t q=ATQ_CMD_DECLARE_ST(CMD_AT_CHUP,"AT+CHUP\r");
  assert(at_queue_insert_const(&p.sys_chan,&q,1,0)!=0);
  assert(wire_len==2);
  assert(p.state.at_tasks==0);
  assert(p.at_write_failed);
  stall_forever=0; poll_ready=1;
  /* A caller outside the monitor must not append to a poisoned AT frame. */
  assert(at_queue_insert_const(&p.sys_chan,&q,1,0)!=0);
  assert(wire_len==2 && at_queue_run(&p)!=0);
  at_queue_flush(&p);
}

/* ── Finding 4: orphan/mismatched +CMGS is inert ──────────────────────────── */
static int deliver_cmgs(struct pvt *p) {
  char response[]="+CMGS: 7\r";
  struct iovec iov[2]={{response,sizeof(response)-1},{NULL,0}};
  return at_response(p,iov,1,RES_CMGS);
}
static void orphan_cmgs_is_inert(void) {
  struct pvt p; init(&p);
  assert(deliver_cmgs(&p)==0);
  assert(sms_put_calls==0 && last_sms_uid==-1);

  /* Unrelated head: the completion must not consume or attribute it. */
  enqueue(&p.sys_chan,CMD_AT_CSQ,RES_OK,"AT+CSQ\r");
  const at_queue_task_t *head=at_queue_head_task(&p);
  assert(deliver_cmgs(&p)==0);
  assert(at_queue_head_task(&p)==head && sms_put_calls==0);
  at_queue_flush(&p);

  /* SMS transaction still waiting for the prompt: not its completion yet. */
  init(&p); part(&p);
  head=at_queue_head_task(&p);
  assert(deliver_cmgs(&p)==0);
  assert(at_queue_head_task(&p)==head && sms_put_calls==0);
  at_queue_flush(&p);

  /* Correct owner and command state: completion is attributed once. */
  init(&p); part(&p); complete(&p,RES_SMS_PROMPT);
  assert(at_queue_head_cmd(&p)->cmd==CMD_AT_SMSTEXT);
  assert(at_queue_head_cmd(&p)->length==0);
  assert(deliver_cmgs(&p)==0);
  assert(sms_put_calls==1 && last_sms_uid==17);
  assert(deliver_cmgs(&p)==0);
  assert(sms_put_calls==1 && last_sms_uid==17);
  complete(&p,RES_OK);
  at_queue_flush(&p);
}

/* ── Finding 5: readiness waits for the complete initialization ───────────── */
static void readiness_waits_for_completion_without_blind_chup(void) {
  struct pvt p; init(&p);
  assert(at_enqueue_initialization(&p.sys_chan,CMD_AT_CNMI)==0);
  assert(at_queue_head_cmd(&p)->cmd==CMD_AT_CNMI && !p.initialized);
  assert(at_response_ok(&p,RES_OK)==0);
  assert(!p.initialized);
  assert(at_queue_head_cmd(&p)->cmd==CMD_AT_CSQ);
  assert(at_queue_run(&p)==0);
  expect_wire("AT+CSQ\r",1);
  expect_wire("AT+CHUP\r",0);
  /* CSQ is the last mandatory initialization command. Readiness is published
   * here; the queued read-only CLCC is observation only. */
  assert(at_response_ok(&p,RES_OK)==0);
  assert(!p.initialized && p.init_reconciling);
  assert(at_queue_head_cmd(&p)->cmd==CMD_AT_CLCC);
  assert(at_queue_run(&p)==0);
  expect_wire("AT+CLCC\r",1);
  assert(at_response_ok(&p,RES_OK)==0);
  assert(p.initialized);
  expect_wire("AT+CHUP\r",0);
  /* Order preserved: CNMI, CSQ, CLCC. */
  const char *cnmi=strstr(wire,"AT+CNMI="), *csq=strstr(wire,"AT+CSQ\r"), *clcc=strstr(wire,"AT+CLCC\r");
  assert(cnmi && csq && clcc && cnmi<csq && csq<clcc);
  at_queue_flush(&p);
}


/* Startup radio ownership is established before admitting another dial. */
static void startup_reconciles_without_hangup(void) {
  struct pvt p; init(&p); p.has_voice=1;
  assert(at_enqueue_initialization(&p.sys_chan,CMD_AT_CSQ)==0);
  assert(at_response_ok(&p,RES_OK)==0);
  assert(!p.initialized && p.init_reconciling);
  assert(at_queue_run(&p)==0);
  char active[]="+CLCC: 1,0,0,0,0,\"123\",129\r";
  assert(at_response_clcc(&p,active)==0);
  struct cpvt *c=pvt_find_cpvt(&p,1);
  assert(c && !c->channel && c->state==CALL_STATE_ACTIVE && p.state.chansno==1);
  assert(!p.initialized);
  assert(at_response_ok(&p,RES_OK)==0);
  assert(p.initialized && !p.init_reconciling && p.state.chansno==1);
  expect_wire("AT+CHUP",0);
  change_channel_state(c,CALL_STATE_RELEASED,0);
  assert(p.state.chansno==0);
  at_queue_flush(&p);

  init(&p); p.has_voice=1; incoming_started=0;
  assert(at_enqueue_initialization(&p.sys_chan,CMD_AT_CSQ)==0);
  assert(at_response_ok(&p,RES_OK)==0);
  assert(at_queue_run(&p)==0);
  char incoming[]="+CLCC: 2,1,4,0,0,\"123\",129\r";
  assert(at_response_clcc(&p,incoming)==0);
  assert(incoming_started==1 && pvt_find_cpvt(&p,2));
  assert(!p.initialized);
  assert(at_response_ok(&p,RES_OK)==0);
  assert(p.initialized);
  expect_wire("AT+CHUP",0);
  cpvt_free(pvt_find_cpvt(&p,2)); at_queue_flush(&p);

  init(&p);
  assert(at_response_conn(&p,"^CONN:3,0")==0);
  expect_wire("AT+CHUP",0);
  expect_wire("AT+CLCC",1);
  at_queue_flush(&p);

  init(&p);
  enqueue(&p.sys_chan,CMD_AT_DDSETEX,RES_OK,"AT^DDSETEX=2\r");
  assert(at_response_ok(&p,RES_OK)==0);
  assert(!p.initialized);
  at_queue_flush(&p);
}
static void interrupted_and_slow_writes_obey_deadline(void) {
  struct pvt p; init(&p); int result;
  eintr_forever=1;
  assert(write_all_ex(p.data_fd,"AT\r",3,100,&result)==0);
  assert(result==AT_WRITE_RESULT_TEMP_ZERO);
  assert(mono_now.tv_sec==100 && mono_now.tv_nsec==100000000);
  eintr_forever=0; slow_progress=1;
  size_t n=write_all_ex(p.data_fd,"AT+CHUP\r",8,300,&result);
  assert(n==3 && result==AT_WRITE_RESULT_ERROR);
  assert(wire_len==3);
}

/* ── SMS ownership / reload control (kept from the previous review) ───────── */
static void sms_ownership(void) {
  struct pvt p; init(&p); part(&p); assert(p.outgoing_sms==1); p.desired_state=DEV_STATE_RESTARTED; finish_part(&p,RES_OK); assert(p.outgoing_sms==0 && p.state.at_tasks==0 && p.state.at_cmds==0 && wakeups==1);
  init(&p); part(&p); part(&p); p.desired_state=DEV_STATE_RESTARTED; complete(&p,RES_ERROR); assert(p.outgoing_sms==1 && wakeups==0); finish_part(&p,RES_OK); assert(p.outgoing_sms==0 && wakeups==1);
  init(&p); fail_write=1; assert(at_enqueue_pdu(&p.sys_chan,"0011",4,1,17)<0); assert(p.outgoing_sms==0 && p.state.at_tasks==0); fail_write=0;
  init(&p); part(&p); complete(&p,RES_SMS_PROMPT); complete(&p,RES_ERROR); assert(!p.outgoing_sms && !p.state.at_tasks);
  init(&p); assert(at_enqueue_clcc(&p.sys_chan)==0); part(&p); part(&p); assert(at_queue_recover(&p)==0); at_queue_flush(&p); assert(p.outgoing_sms==0 && p.state.at_tasks==0 && p.state.at_cmds==0 && p.at_recovery==0);
}
static void busy_context(at_res_t result, int control, int detached) {
  struct pvt p; struct ast_channel a={0},b={0}; init(&p); struct cpvt *first=call(&p,detached?NULL:&a,1), *second=call(&p,&b,2); enqueue(first,CMD_AT_D,RES_OK,"ATD1;\r"); enqueue(second,CMD_AT_D,RES_OK,"ATD2;\r"); p.dialing=1;
  at_response_busy(&p,result,control); assert(a.controls==(detached?0:1)); if(!detached) assert(a.control==control && a.hangups==1 && !a.tech_pvt); assert(b.controls==0 && b.hangups==0 && b.tech_pvt==second); assert(p.state.chansno==1); assert(at_queue_head_task(&p)->cpvt==second); assert(at_queue_head_cmd(&p)->cmd==CMD_AT_D); assert(strstr(wire,"ATD2")); assert(at_queue_run(&p)==0); assert(strstr(wire,"ATD2")); at_queue_flush(&p); cpvt_free(second);
}
static void immediate_hangup(void) {
  struct pvt p; init(&p);
  at_hangup_immediality(&p); assert(strcmp(wire,"AT+CHUP\r")==0);
  wire_len=0; wire[0]=0; at_hangup_immediality(&p); assert(strcmp(wire,"AT+CHUP\r")==0);
  assert(!strstr(wire,"CHLD"));
  init(&p); part(&p); wire_len=0; wire[0]=0; at_abort_pending_sms(&p); assert(wire_len==1 && wire[0]=='\x1b'); at_queue_flush(&p);
}
static void reload_preserves_restart(void) {
  struct pvt p; init(&p); part(&p); pvt_config_t settings=p.settings; strcpy(settings.unique.data_tty,"/dev/offline-fixture"); assert(pvt_reconfigure(&p,&settings,RESTATE_TIME_CONVENIENT)==0); assert(p.desired_state==DEV_STATE_RESTARTED); assert(pvt_reconfigure(&p,&settings,RESTATE_TIME_CONVENIENT)==0); assert(p.desired_state==DEV_STATE_RESTARTED && p.restart_time==RESTATE_TIME_CONVENIENT && wakeups==0); finish_part(&p,RES_OK); assert(p.restart_time==RESTATE_TIME_NOW && wakeups==1);
  init(&p); assert(pvt_enabled(&p)); p.terminate_monitor=1; assert(!pvt_enabled(&p));
}

int main(void) {
  readiness_waits_for_completion_without_blind_chup();
  startup_reconciles_without_hangup();
  interrupted_and_slow_writes_obey_deadline();
  late_terminal_ok_cannot_ack_next();
  clcc_barrier_still_holds();
  dtmf_cancelled_at_release();
  dtmf_dispatch_requires_active_same_index();
  transient_backpressure_is_not_a_failure();
  permanent_error_is_still_a_failure();
  zero_progress_stalls_are_bounded_and_keep_ownership();
  partial_write_is_never_replayed();
  orphan_cmgs_is_inert();
  sms_ownership();
  busy_context(RES_BUSY,AST_CONTROL_BUSY,0);
  busy_context(RES_NO_CARRIER,AST_CONTROL_CONGESTION,0);
  busy_context(RES_NO_DIALTONE,AST_CONTROL_CONGESTION,1);
  immediate_hangup();
  reload_preserves_restart();
  puts("lifecycle hardening: ok");
  return 0;
}
