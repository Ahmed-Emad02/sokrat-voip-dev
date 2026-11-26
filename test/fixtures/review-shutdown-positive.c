#define _GNU_SOURCE
#include <assert.h>
#include <pthread.h>
#include <semaphore.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* The shutdown functions below are extracted verbatim from the release-patched
 * chan_dongle.c. Only the Asterisk lock/wake/log ABI and the device structure
 * fields they touch are supplied; scheduling stays real. */
#define AST_PTHREADT_NULL ((pthread_t)0)
#define AST_PTHREADT_STOP ((pthread_t)-1)
#define EXPORT_DEF
#define LOG_ERROR 1
#define LOG_WARNING 2
#define LOG_NOTICE 3
#define ast_log(...) ((void)0)
typedef pthread_mutex_t ast_mutex_t;
#define ast_mutex_lock pthread_mutex_lock
#define ast_mutex_unlock pthread_mutex_unlock

typedef enum { DEV_STATE_STOPPED=0, DEV_STATE_RESTARTED, DEV_STATE_REMOVED, DEV_STATE_STARTED } dev_state_t;
typedef enum { RESTATE_TIME_NOW=0, RESTATE_TIME_GRACEFULLY, RESTATE_TIME_CONVENIENT } restate_time_t;
struct pvt_state { unsigned chansno; };
struct pvt {
	pthread_mutex_t lock;
	pthread_t monitor_thread;
	int terminate_monitor;
	dev_state_t desired_state;
	dev_state_t current_state;
	volatile restate_time_t restart_time;
	struct pvt_state state;
	unsigned outgoing_sms;
	unsigned incoming_sms_index;
};
typedef struct public_state {
	pthread_mutex_t discovery_lock;
	pthread_t discovery_thread;
	volatile int unloading_flag;
} public_state_t;
static public_state_t *gpublic;

#define PVT_ID(pvt) "test"
#define PVT_NO_CHANS(pvt) ((pvt)->state.chansno == 0)
static const char *dev_state2str(dev_state_t state) {
	static const char *names[] = { "stopped", "restarted", "removed", "started" };
	return names[state];
}

static sem_t ready, discovery_gate, monitor_gate;
static pthread_t discovery_tid, monitor_tid;
static atomic_int discovery_wakes, monitor_wakes, creations;

static int fake_wake(pthread_t id, int sig) {
	(void)sig;
	if (pthread_equal(id, discovery_tid)) {
		atomic_fetch_add(&discovery_wakes, 1);
		sem_post(&discovery_gate);
	} else if (pthread_equal(id, monitor_tid)) {
		atomic_fetch_add(&monitor_wakes, 1);
		sem_post(&monitor_gate);
	}
	return 0;
}
static int tracked_join(pthread_t id, void **out) {
	return pthread_join(id, out);
}
static int fake_create(pthread_t *thread, const void *attr, void *(*fn)(void *), void *arg) {
	(void)attr;
	atomic_fetch_add(&creations, 1);
	return pthread_create(thread, NULL, fn, arg);
}
#define pthread_kill fake_wake
#define pthread_join tracked_join
#define ast_pthread_create_background fake_create

static void *do_discovery(void *arg);
static void *do_discovery(void *arg) { (void)arg; return NULL; }
#include "shutdown-code.inc"

static struct pvt device;

static void *monitor_main(void *arg) {
	struct pvt *pvt = arg;
	sem_wait(&monitor_gate);
	/* Last call released while a restart/stop is pending: this is exactly the
	 * cleanup path that used to call pvt_try_restate() -> discovery_restart()
	 * while discovery_stop() held discovery_lock. */
	pvt->desired_state = DEV_STATE_STOPPED;
	pvt->current_state = DEV_STATE_STARTED;
	pvt->state.chansno = 0;
	pvt->outgoing_sms = 0;
	pvt->incoming_sms_index = 0;
	pvt->restart_time = RESTATE_TIME_CONVENIENT;
	pvt_try_restate(pvt);
	return NULL;
}

static void *discovery_main(void *arg) {
	public_state_t *state = arg;
	pthread_mutex_lock(&device.lock);
	sem_post(&ready);
	sem_wait(&discovery_gate);
	pvt_stop(&device);
	pthread_mutex_unlock(&device.lock);
	return NULL;
}

static void watchdog(int sig) {
	(void)sig;
	static const char msg[] = "FAIL: shutdown join cycle did not complete\n";
	write(STDOUT_FILENO, msg, sizeof(msg) - 1);
	_exit(42);
}

int main(void) {
	public_state_t state;
	memset(&state, 0, sizeof(state));
	memset(&device, 0, sizeof(device));
	pthread_mutex_init(&state.discovery_lock, NULL);
	pthread_mutex_init(&device.lock, NULL);
	sem_init(&ready, 0, 0);
	sem_init(&discovery_gate, 0, 0);
	sem_init(&monitor_gate, 0, 0);
	gpublic = &state;

	assert(pthread_create(&monitor_tid, NULL, monitor_main, &device) == 0);
	device.monitor_thread = monitor_tid;
	assert(pthread_create(&discovery_tid, NULL, discovery_main, &state) == 0);
	state.discovery_thread = discovery_tid;
	sem_wait(&ready);

	signal(SIGALRM, watchdog);
	alarm(3);
	discovery_stop(&state);
	alarm(0);

	assert(state.discovery_thread == AST_PTHREADT_STOP);
	assert(device.monitor_thread == AST_PTHREADT_NULL);
	assert(atomic_load(&discovery_wakes) == 1);
	assert(atomic_load(&monitor_wakes) == 1);
	assert(atomic_load(&creations) == 0);

	/* A late monitor/restate wake must not recreate or signal discovery. */
	assert(discovery_restart(&state) == 0);
	assert(atomic_load(&discovery_wakes) == 1);
	assert(atomic_load(&creations) == 0);

	/* A never-started discovery thread is also safe to stop. */
	{
		public_state_t unused;
		memset(&unused, 0, sizeof(unused));
		pthread_mutex_init(&unused.discovery_lock, NULL);
		discovery_stop(&unused);
		assert(unused.discovery_thread == AST_PTHREADT_STOP);
	}

	pthread_join(monitor_tid, NULL);
	pthread_join(discovery_tid, NULL);
	puts("shutdown lock cycle: ok");
	return 0;
}
