#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
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
static ssize_t serial_write(int fd, const void *buf, size_t len) { (void)fd; if (fail_write) { errno=EIO; return -1; } assert(wire_len+len<sizeof(wire)); memcpy(wire+wire_len,buf,len); wire_len+=len; wire[wire_len]=0; return len; }
#define write serial_write
#include "driver-types.inc"

public_state_t public_state, *gpublic=&public_state;
const char *const dev_state_strs[4]={"stopped","restarted","removed","started"};
static int wakeups;
static struct pvt *wake_device;
static int discovery_restart(public_state_t *p) { assert(p==gpublic); assert(wake_device && wake_device->outgoing_sms==0 && wake_device->state.at_tasks==0 && wake_device->state.at_cmds==0); ++wakeups; return 0; }
static int chan_dongle_err;
#define E_QUEUE 1
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
#include "driver-code.inc"

static void init(struct pvt *p) { memset(p,0,sizeof(*p)); wake_device=p; p->sys_chan.pvt=p; p->incoming_sms_index=-1U; p->data_fd=123; p->audio_fd=-1; p->current_state=DEV_STATE_STARTED; p->desired_state=DEV_STATE_STARTED; p->restart_time=RESTATE_TIME_CONVENIENT; p->settings.shared.initstate=DEV_STATE_STARTED; wire_len=0; wire[0]=0; wakeups=0; fail_alloc=-1; fail_write=0; wall_now=(struct timeval){100,0}; mono_now=(struct timespec){100,0}; }
static void enqueue(struct cpvt *c, at_cmd_t cmd, at_res_t res, const char *data) { at_queue_cmd_t q=ATQ_CMD_DECLARE_ST(CMD_AT,data); q.cmd=cmd; q.res=res; q.length=strlen(data); assert(at_queue_insert_const(c,&q,1,0)==0); }
static void complete(struct pvt *p, at_res_t res) { if (res==RES_SMS_PROMPT) assert(at_response_sms_prompt(p)==0); else at_queue_handle_result(p,res); assert(at_queue_run(p)==0); }
static void part(struct pvt *p) { assert(at_enqueue_pdu(&p->sys_chan,"0011",4,1,17)==0); }
static void finish_part(struct pvt *p, at_res_t result) { complete(p,RES_SMS_PROMPT); assert(at_queue_head_cmd(p)->cmd==CMD_AT_SMSTEXT); complete(p,result); }
static void barrier(at_cmd_t next, at_res_t expected) {
 struct pvt p; init(&p); assert(at_enqueue_clcc(&p.sys_chan)==0); enqueue(&p.sys_chan,next,expected,"AT+NEXT\r");
 for (int i=0;i<20;i++) assert(at_enqueue_clcc(&p.sys_chan)==0);
 assert(p.state.at_tasks==2); wall_now.tv_sec+=6; assert(at_queue_timeout(&p)==0); assert(at_queue_recover(&p)==0); assert(strstr(wire,"AT+CSQ\r")); assert(!strstr(wire,"NEXT"));
 const at_queue_task_t *held=at_queue_head_task(&p);
 assert(at_queue_recovery_response(&p,RES_OK,0)==0); assert(at_queue_recovery_response(&p,RES_ERROR,0)==0); assert(at_queue_recovery_response(&p,RES_SMS_PROMPT,0)==0); assert(at_queue_recovery_response(&p,RES_CMGR,0)==0);
 assert(at_queue_head_task(&p)==held); assert(at_queue_run(&p)==0); assert(!strstr(wire,"NEXT"));
 int rssi; assert(at_parse_csq("+CSQ: 18,99",&rssi)==0); assert(at_queue_recovery_response(&p,RES_CSQ,1)==0); assert(at_queue_head_task(&p)==held); assert(!strstr(wire,"NEXT"));
 assert(at_queue_recovery_response(&p,RES_OK,0)==0); assert(at_queue_head_cmd(&p)->cmd==next); assert(at_queue_head_cmd(&p)->length>0); assert(at_queue_run(&p)==0); assert(strstr(wire,"NEXT")); assert(p.state.at_tasks==1); assert(at_queue_head_cmd(&p)->cmd==next); at_queue_flush(&p);
}
static void bounded_probe(void) {
 struct pvt p; init(&p); at_enqueue_clcc(&p.sys_chan); assert(at_queue_recover(&p)==0); struct timespec deadline=p.at_recovery_deadline;
 for(int i=0;i<4;i++) { mono_now.tv_sec++; assert(at_queue_recovery_response(&p,RES_BOOT,0)==1); assert(p.at_recovery_deadline.tv_sec==deadline.tv_sec); }
 mono_now.tv_sec++; assert(at_queue_timeout(&p)==0); assert(at_queue_recovery_response(&p,RES_BOOT,0)==-1); assert(at_queue_recover(&p)==-1); at_queue_flush(&p);
 init(&p); at_enqueue_clcc(&p.sys_chan); at_queue_recover(&p); assert(at_queue_recovery_response(&p,RES_CSQ,0)==-1); at_queue_flush(&p);
 init(&p); at_enqueue_clcc(&p.sys_chan); at_queue_recover(&p); assert(at_queue_recovery_response(&p,RES_CSQ,1)==0); assert(at_queue_recovery_response(&p,RES_ERROR,0)==-1); at_queue_flush(&p);
 init(&p); at_enqueue_clcc(&p.sys_chan); fail_write=1; assert(at_queue_recover(&p)==-1); at_queue_flush(&p);
}
static struct cpvt *call(struct pvt *p, struct ast_channel *a, int idx) { struct cpvt *c=calloc(1,sizeof(*c)); assert(c); c->pvt=p; c->channel=a; c->state=CALL_STATE_DIALING; c->call_idx=idx; c->rd_pipe[0]=c->rd_pipe[1]=-1; if(a) a->tech_pvt=c; AST_LIST_INSERT_TAIL(&p->chans,c,entry); p->state.chansno++; p->state.chan_count[c->state]++; return c; }
static void busy_context(at_res_t result, int control, int detached) {
 struct pvt p; struct ast_channel a={0},b={0}; init(&p); struct cpvt *first=call(&p,detached?NULL:&a,1), *second=call(&p,&b,2); enqueue(first,CMD_AT_D,RES_OK,"ATD1;\r"); enqueue(second,CMD_AT_D,RES_OK,"ATD2;\r"); p.dialing=1;
 at_response_busy(&p,result,control); assert(a.controls==(detached?0:1)); if(!detached) assert(a.control==control && a.hangups==1 && !a.tech_pvt); assert(b.controls==0 && b.hangups==0 && b.tech_pvt==second); assert(p.state.chansno==1); assert(at_queue_head_task(&p)->cpvt==second); assert(at_queue_head_cmd(&p)->cmd==CMD_AT_D); assert(strstr(wire,"ATD2")); assert(at_queue_run(&p)==0); assert(strstr(wire,"ATD2")); at_queue_flush(&p); cpvt_free(second);
}
static void part(struct pvt *p);
static void immediate_hangup(void) {
 struct pvt p; init(&p);
 at_hangup_immediality(&p); assert(strcmp(wire,"AT+CHUP\r")==0);
 wire_len=0; wire[0]=0; at_hangup_immediality(&p); assert(strcmp(wire,"AT+CHUP\r")==0);
 assert(!strstr(wire,"CHLD"));
 init(&p); part(&p); wire_len=0; wire[0]=0; at_abort_pending_sms(&p); assert(wire_len==1 && wire[0]=='\x1b'); at_queue_flush(&p);
}
static void sms_ownership(void) {
 struct pvt p; init(&p); part(&p); assert(p.outgoing_sms==1); p.desired_state=DEV_STATE_RESTARTED; finish_part(&p,RES_OK); assert(p.outgoing_sms==0 && p.state.at_tasks==0 && p.state.at_cmds==0 && wakeups==1);
 init(&p); part(&p); part(&p); assert(at_enqueue_pdu(&p.sys_chan,"0011",4,1,18)==0); assert(p.outgoing_sms==3); p.desired_state=DEV_STATE_RESTARTED; finish_part(&p,RES_OK); assert(p.outgoing_sms==2 && wakeups==0); finish_part(&p,RES_ERROR); assert(p.outgoing_sms==1 && wakeups==0); finish_part(&p,RES_OK); assert(p.outgoing_sms==0 && wakeups==1 && p.state.at_cmds==0);
 init(&p); part(&p); part(&p); p.desired_state=DEV_STATE_RESTARTED; complete(&p,RES_ERROR); assert(p.outgoing_sms==1 && wakeups==0); finish_part(&p,RES_OK); assert(p.outgoing_sms==0 && wakeups==1);
 init(&p); part(&p); fail_alloc=2; assert(at_enqueue_pdu(&p.sys_chan,"0011",4,1,17)<0); assert(p.outgoing_sms==1 && p.state.at_tasks==1); fail_alloc=-1; p.desired_state=DEV_STATE_RESTARTED; finish_part(&p,RES_OK); assert(p.outgoing_sms==0 && wakeups==1);
 init(&p); fail_write=1; assert(at_enqueue_pdu(&p.sys_chan,"0011",4,1,17)<0); assert(p.outgoing_sms==0 && p.state.at_tasks==0); fail_write=0;
 init(&p); part(&p); part(&p); p.desired_state=DEV_STATE_RESTARTED; at_queue_handle_result(&p,RES_SMS_PROMPT); fail_write=1; assert(at_queue_run(&p)!=0); assert(p.outgoing_sms==1 && wakeups==0); fail_write=0; assert(at_queue_run(&p)==0); finish_part(&p,RES_OK); assert(p.outgoing_sms==0 && wakeups==1);
 init(&p); part(&p); complete(&p,RES_SMS_PROMPT); complete(&p,RES_ERROR); assert(!p.outgoing_sms && !p.state.at_tasks);
 init(&p); assert(at_enqueue_clcc(&p.sys_chan)==0); part(&p); part(&p); assert(at_queue_recover(&p)==0); at_queue_flush(&p); assert(p.outgoing_sms==0 && p.state.at_tasks==0 && p.state.at_cmds==0 && p.at_recovery==0);
}
static void reload_preserves_restart(void) {
 struct pvt p; init(&p); part(&p); pvt_config_t settings=p.settings; strcpy(settings.unique.data_tty,"/dev/offline-fixture"); assert(pvt_reconfigure(&p,&settings,RESTATE_TIME_CONVENIENT)==0); assert(p.desired_state==DEV_STATE_RESTARTED); assert(pvt_reconfigure(&p,&settings,RESTATE_TIME_CONVENIENT)==0); assert(p.desired_state==DEV_STATE_RESTARTED && p.restart_time==RESTATE_TIME_CONVENIENT && wakeups==0); finish_part(&p,RES_OK); assert(p.restart_time==RESTATE_TIME_NOW && wakeups==1);
 init(&p); assert(pvt_enabled(&p)); p.terminate_monitor=1; assert(!pvt_enabled(&p));
}
int main(void) { barrier(CMD_AT_CMGR,RES_CMGR); barrier(CMD_AT_CMGS,RES_SMS_PROMPT); bounded_probe(); busy_context(RES_BUSY,AST_CONTROL_BUSY,0); busy_context(RES_NO_CARRIER,AST_CONTROL_CONGESTION,0); busy_context(RES_NO_DIALTONE,AST_CONTROL_CONGESTION,1); immediate_hangup(); sms_ownership(); reload_preserves_restart(); puts("dongle queue/response behavior: ok"); return 0; }
