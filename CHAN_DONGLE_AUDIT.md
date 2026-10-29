# chan_dongle Architectural & Line-by-Line Code Audit Report

**Target:** `chan_dongle` (Huawei 3G GSM Channel Driver for Asterisk 18)  
**Source Path:** `/tmp/opencode/asterisk-chan-dongle/`  
**Host:** `sokrat-demo` (`192.168.100.50`)  
**Date:** October 29, 2026 (Exhaustive 4-Round Audit Completed)  
**Status:** Audit completed; strictly read-only (no driver code modified).

---

## Executive Summary

Across four comprehensive line-by-line review rounds of the `chan_dongle` source code, all 18 C modules were audited: `channel.c`, `chan_dongle.c`, `at_response.c`, `at_command.c`, `at_queue.c`, `at_parse.c`, `at_read.c`, `cpvt.c`, `mixbuffer.c`, `ringbuffer.c`, `smsdb.c`, `char_conv.c`, `dc_config.c`, `app.c`, `manager.c`, `helpers.c`, `cli.c`, and `pdiscovery.c`.

The investigation uncovered **53 distinct vulnerabilities, architectural race conditions, parser bugs, audio-path flaws, and security hazards**:
* **Round 1 (Flaws 1–16):** Audio volume inversion, micro-framing causing WebRTC jitter, buffer backpressure packet loss, permanent bridge-loop muting, dead CLCC sweeps, and 5-second AT timeout drops.
* **Round 2 (Flaws 17–32):** DTMF queue LIFO inversion (`321` vs `123`), 110 KB stack overflow hazards, out-of-bounds stack reads in SQLite queries, `channel_func_write` NULL dereferences, unhandled `+CME ERROR` disconnects, and synchronous dialplan deadlocks.
* **Round 3 (Flaws 33–44):** Over-the-air remote stack buffer overflow in PDU decoding (`msg16_tmp[256]` vs 1024), 18-quintillion unsigned loop wrap in `tpdu_parse_deliver`, double-byte multiply buffer overflow in `utf8_to_ucs2`, Music-On-Hold audio starvation, and false-success pickup reporting.
* **Round 4 (Flaws 45–53):** GSM 7-bit extension character buffer overflow in `gsm7_pack`, 8 KB stack overflow in `at_enqueue_ussd`, remote OTA stack buffer overflow in UCS-2 SMS decoding, unit mismatch in `pdu_parse_number` (nibbles vs bytes), `handle_expired_reports` polling/deadlock loop under mutex, and empty-string phone/USSD validation bypasses.

---

# PART I — Round 1 Findings

## 1. Audio Path & Media Consistency Flaws

### 1.1 TX Gain Inversion Bug (Positive Boost Attenuates Audio)
* **File & Lines:** `channel.c:971–986`
* **Code Reference:**
  ```c
  gains[0] = CONF_SHARED(pvt, txgain);
  if(gains[0] <= -2) {
      gains[0] *= gains[1];
      gains[1] = 0;
  }
  else if(gains[0] <= 1) {       /* BUG: txgain == +1 matches here! */
      gains[0] = - gains[1];     /* Inverts positive gain to negative */
      gains[1] = 0;
  }
  else if(gains[0] % gains[1] == 0) {
      gains[0] /= gains[1];
      gains[1] = 0;
  }
  ```
* **Mechanism & Impact:**  
  Asterisk's `ast_frame_adjust_volume(f, step)` interprets positive integers as amplification and negative integers as attenuation. When an administrator configures `txgain = 1` in `dongle.conf` expecting a slight volume increase, the check `else if(gains[0] <= 1)` evaluates to `true`. This assigns `gains[0] = -gains[1] = -1`. The positive boost is inverted into a negative reduction, decreasing call volume instead of increasing it.

---

### 1.2 Variable Micro-Framing Causes WebRTC / Opus Audio Jitter
* **File & Lines:** `channel.c:755–808`
* **Code Reference:**
  ```c
  res = read (fd, buf, FRAME_SIZE);
  ...
  cpvt->a_read_frame.samples = res / 2;
  cpvt->a_read_frame.datalen = res;
  ```
* **Mechanism & Impact:**  
  For 8 kHz 16-bit signed linear PCM (`AST_FORMAT_SLINEAR`), standard Asterisk framing requires exactly 20 ms per frame (320 bytes = 160 samples). When the Linux USB serial subsystem yields partial data chunks (e.g., 60, 100, or 160 bytes), `channel_read()` immediately packages the partial buffer as a frame. Downstream consumers—specifically WebRTC jitter buffers, Opus transcoders, and neural noise cancellation (`func_rnnoise.so`)—rely on consistent 20 ms cadence. Variable micro-frames induce packet concealment algorithms, causing robotic distortion, audible clicks, and jitter.

---

### 1.3 Silent Audio Dropouts on USB Write Backpressure
* **File & Lines:** `channel.c:542–553` and `channel.c:620`
* **Code Reference:**
  In `timing_write()`:
  ```c
  mixb_read_upd (&pvt->a_write_mixb, FRAME_SIZE); /* Drained ahead of write */
  ...
  iov_write(pvt, pvt->audio_fd, iov, iovcnt);
  ```
  In `iov_write()`:
  ```c
  if (written < 0) {
      if ((errno == EINTR || errno == EAGAIN)) {
          --count;
          if (count != 0) {
              if (errno == EAGAIN) usleep(200);
              goto again;
          }
          ast_debug (1, "[%s] Deadlock avoided for write!\n", PVT_ID(pvt));
      }
      break;
  }
  ```
* **Mechanism & Impact:**  
  `timing_write()` commits the read pointer in `mixbuffer` *before* verifying that the data was accepted by the hardware. If the serial modem driver buffers fill up and `writev` returns `EAGAIN` across all 10 retries, `iov_write()` aborts. Because the 160 audio samples were already drained from the buffer, they are permanently dropped. The remote cellular party hears momentary silence or skipped syllables whenever USB backpressure occurs.

---

### 1.4 Permanent One-Way Audio Lockout on Bridge Loops
* **File & Lines:** `channel.c:913–914` and `channel.c:947–948`
* **Code Reference:**
  ```c
  if (bridged && ... && tmp_cpvt->pvt == pvt) {
      CPVT_SET_FLAGS(cpvt, CALL_FLAG_BRIDGE_LOOP);
      CPVT_SET_FLAGS((struct cpvt*)ast_channel_tech_pvt(bridged), CALL_FLAG_BRIDGE_LOOP);
      goto e_return;
  }
  ```
  At line 913:
  ```c
  if(CPVT_TEST_FLAG(cpvt, CALL_FLAG_BRIDGE_LOOP))
      return 0; /* Silently drops all audio writes */
  ```
* **Mechanism & Impact:**  
  When two channels on the same physical dongle are temporarily bridged together (such as during an attended transfer or consultation hold), `CALL_FLAG_BRIDGE_LOOP` is applied to prevent local acoustic feedback. Line 911 notes: `/* TODO: check end of bridge loop condition */`. This flag is **never reset**. If one channel is transferred or unbridged, the surviving channel continues to drop 100% of outbound audio writes, leaving the call completely silent (one-way audio) for its remaining duration.

---

### 1.5 Small 240 ms Audio Buffer Overruns Under High System Load
* **File & Lines:** `chan_dongle.h:133` and `channel.c:1005–1009`
* **Code Reference:**
  ```c
  char a_write_buf[FRAME_SIZE * 12]; /* 320 * 12 = 3840 bytes = 240 ms */
  ```
* **Mechanism & Impact:**  
  The write buffer stores only 240 ms of audio. In virtualized PBX environments or systems experiencing brief CPU spikes, scheduling delays exceeding 240 ms cause immediate buffer saturation:
  ```c
  mixb_read_upd (&pvt->a_write_mixb, f->datalen - count);
  PVT_STAT(pvt, write_rb_overflow) ++;
  ```
  Unplayed frames are overwritten, creating choppy and unintelligible outbound voice.

---

## 2. Call Making & Dialing Inconsistencies

### 2.1 Permanent Dongle Lockout on Failed Dials
* **File & Lines:** `at_response.c:453–456`
* **Code Reference:**
  ```c
  case CMD_AT_D:
      log_cmd_response_error(pvt, ecmd, "[%s] Dial failed\n", PVT_ID(pvt));
      queue_control_channel (task->cpvt, AST_CONTROL_CONGESTION);
      break;
  ```
* **Mechanism & Impact:**  
  When an outbound dial command (`ATD`) is rejected by the cellular network (e.g., fast busy, unallocated number, or expired SIM credit), `chan_dongle` notifies Asterisk with `AST_CONTROL_CONGESTION`. However, it **fails to reset `pvt->dialing = 0`** and **fails to transition `cpvt->state` to `CALL_STATE_RELEASED`**.  
  Because `pvt->dialing` remains `1` and `cpvt->state` remains `CALL_STATE_INIT`, `is_dial_possible2()` (`chan_dongle.c:924`) rejects all future outbound calls on that modem with `Error device already in use or uninitialized`. The dongle is locked out until an external monitor or daemon restarts it.

---

### 2.2 Outbound Call Drop If Modem Omits Proprietary `^ORIG`
* **File & Lines:** `at_response.c:630–681` and `at_response.c:844–848`
* **Code Reference:**
  ```c
  /* In at_response_orig(): */
  cpvt->call_idx = call_index;
  ...
  /* In at_response_conn(): */
  cpvt = pvt_find_cpvt(pvt, call_index);
  if (cpvt) {
      change_channel_state(cpvt, CALL_STATE_ACTIVE, 0);
  } else {
      at_enqueue_hangup(&pvt->sys_chan, call_index);
      ast_log (LOG_ERROR, "[%s] answered incoming call with not exists call idx %d, hanging up!\n", ...);
  }
  ```
* **Mechanism & Impact:**  
  Outbound tracking relies on the modem emitting Huawei's proprietary `^ORIG:<call_idx>,<type>` unsolicited response. If a firmware variant or cellular provider suppresses `^ORIG` (or if it arrives out of sequence), `cpvt->call_idx` remains `0`. When the called party answers and the modem emits `^CONN:1,0`, `pvt_find_cpvt(pvt, 1)` fails to locate the call. The driver misinterprets its own outbound connected call as an unauthorized incoming call and **immediately executes `AT+CHUP`, terminating the call the instant the customer answers**.

---

### 2.3 Modem Deadlock on Rapid Auto-Dialer Pacing
* **File & Lines:** `channel.c:426–435` vs `at_command.c:832–863`
* **Code Reference:**
  ```c
  if (cpvt->dir == CALL_DIR_OUTGOING && (cpvt->state == CALL_STATE_INIT || ...)) {
      pvt->dialing = 0;
      change_channel_state(cpvt, CALL_STATE_RELEASED, 0);
      return 0;
  }
  ```
* **Mechanism & Impact:**  
  When an outbound call is cancelled early, `channel_hangup()` immediately sets `pvt->dialing = 0` and marks the channel released. High-speed progressive auto-dialers see the dongle as immediately available and can launch a new call within 10 ms. However, the physical Huawei modem is still asynchronously processing the previous `AT+CHUP` teardown. Sending a new `ATD` before the modem finishes `^CEND` triggers an internal baseband freeze (documented in the driver comments as `HW BUG 1` and `HW BUG 2`), requiring a hardware USB bus reset to recover.

---

### 2.4 Invalid `AT+CHLD=10` Command Syntax on Early Hangup
* **File & Lines:** `at_command.c:996–1003`
* **Code Reference:**
  ```c
  EXPORT_DEF void at_hangup_immediality(struct cpvt* cpvt) {
      char buf[20];
      int length = snprintf(buf, sizeof(buf), cmd_chld1x, cpvt->call_idx);
      if(length > 0)
          at_write(cpvt->pvt, buf, length);
  }
  ```
* **Mechanism & Impact:**  
  When an un-indexed call (`call_idx == 0`) is terminated via `at_hangup_immediality()`, it formats `cmd_chld1x` (`"AT+CHLD=1%d\r"`) as `AT+CHLD=10\r`. Under 3GPP GSM specifications, call index values must be in the range `1–9`. The modem rejects `AT+CHLD=10` with `ERROR`, failing to terminate the cellular radio session immediately.

---

## 3. In-Call Stability & Signaling Flaws

### 3.1 Unreachable CLCC Sweep Leaves Zombie Channels
* **File & Lines:** `at_response.c:1043–1070`
* **Code Reference:**
  ```c
              /* or -1 ? */
              return 0;   /* Line 1044 exits unconditionally */
          }
          /* --- UNREACHABLE DEAD CODE BELOW --- */
          AST_LIST_TRAVERSE_SAFE_BEGIN(&pvt->chans, cpvt, entry) {
              if(!CPVT_TEST_FLAG(cpvt, CALL_FLAG_ALIVE)) {
                  change_channel_state(cpvt, CALL_STATE_RELEASED, 0);
              }
          }
  ```
* **Mechanism & Impact:**  
  The loop intended to detect and terminate orphaned Asterisk channels when a call vanishes from `+CLCC` polling is unreachable because `return 0;` at line 1044 exits the function unconditionally. If a cellular carrier drops a call without transmitting `^CEND` or `NO CARRIER`, Asterisk retains the channel as active indefinitely. The dongle remains stuck off-hook and cannot accept or place new calls.

---

### 3.2 Deaf / Mute Answered Calls on Voice Pipeline Setup Failure
* **File & Lines:** `at_command.c:568–573` and `at_response.c:458–460`
* **Code Reference:**
  ```c
  case CMD_AT_DDSETEX:
      log_cmd_response_error(pvt, ecmd, "[%s] %s (setup voice) failed\n", ...);
      break;
  ```
* **Mechanism & Impact:**  
  When answering an incoming call, `at_enqueue_answer()` queues `ATA` followed by `AT^DDSETEX=2` (which activates the modem's PCM voice endpoint). If `AT^DDSETEX=2` fails (due to serial port contention or baseband lag), `at_response.c` logs the error but takes no corrective action. Asterisk bridges the call to the agent, but the modem's PCM audio stream is never enabled, resulting in total silence on both sides.

---

### 3.3 Strict 7-Field Parser Fails on Anonymous/Private Calls
* **File & Lines:** `at_parse.c:622–655`
* **Code Reference:**
  ```c
  char delimiters[] = ":,,,,,,"; /* Expects exactly 6 commas / 7 fields */
  if(mark_line(str, delimiters, marks) == ITEMS_OF(marks))
  ```
* **Mechanism & Impact:**  
  Under 3GPP TS 27.007, `<number>` and `<type>` are optional fields in `+CLCC` responses. If a network emits a 5-field response (standard for withheld, private, or anonymous calls), `mark_line()` fails. `at_response_clcc()` logs `can't parse CLCC line`, failing to track the incoming call state.

---

### 3.4 Inbound Routing Fallback to Placeholder DID on Empty CNUM
* **File & Lines:** `at_response.c:862–870`
* **Code Reference:**
  ```c
  pvt->has_subscriber_number ? pvt->subscriber_number : CONF_SHARED(pvt, exten)
  ```
* **Mechanism & Impact:**  
  When a SIM card does not store its own MSISDN (`AT+CNUM` returns empty), `has_subscriber_number` is `0`. The incoming call DID defaults to `+1234567890`. In FreePBX / Issabel environments where inbound routes are bound to specific carrier DIDs, calls fail to match and drop into the default/catch-all destination.

---

### 3.5 First-Ring Latency Delaying Inbound Call Setup
* **File & Lines:** `at_response.c:1154–1164` and `at_command.c:941–948`
* **Code Reference:**
  ```c
  if (pvt->volume_sync_step == VOLUME_SYNC_BEGIN && PVT_NO_CHANS(pvt)) {
      if (at_enqueue_volsync(&pvt->sys_chan)) ...
  }
  ```
* **Mechanism & Impact:**  
  On the first inbound `RING`, `at_response_ring()` prioritizes `AT+CLVL=1` and `AT+CLVL=5` volume synchronization ahead of `AT+CLCC`. The modem must process both volume commands and reply with `OK` before Asterisk queries the caller identity, introducing 200–500 ms of avoidable delay before extensions begin ringing.

---

## 4. Driver Lifecycle, Memory & Thread Safety

### 4.1 Fatal Segfault on Memory Allocation Failure
* **File & Lines:** `at_queue.c:295–298`
* **Code Reference:**
  ```c
  at_queue_task_t *task = at_queue_add(cpvt, cmds, cmdsno, athead);
  task->uid = uid;  /* CRITICAL: NULL pointer dereference if malloc failed */

  if(!task) { ... }
  ```
* **Mechanism & Impact:**  
  If system memory is constrained and `ast_malloc()` in `at_queue_add()` returns `NULL`, line 296 immediately writes to `task->uid` *before* the `if(!task)` check on line 298. This results in a `SIGSEGV` crash of the entire Asterisk process.

---

### 4.2 Aggressive 5-Second AT Timeout Disconnects Entire Dongle
* **File & Lines:** `chan_dongle.c:520–530` and `at_queue.h:30`
* **Code Reference:**
  ```c
  ecmd = at_queue_head_cmd (pvt);
  if(ecmd) {
      if (ecmd->cmd == CMD_AT_DTMF) { ... continue; }
      ast_log (LOG_ERROR, "[%s] timedout while waiting '%s' in response to '%s'\n", ...);
      goto e_cleanup; /* Tears down the dongle entirely */
  }
  ```
* **Mechanism & Impact:**  
  Almost all non-DTMF AT commands default to `ATQ_CMD_TIMEOUT_MEDIUM` (5 seconds). During cell-tower handovers, SMS dispatch, or transient cellular network congestion, modem responses can take 6–8 seconds. Rather than discarding or retrying the pending command, the driver treats any 5-second timeout as a fatal hardware failure and triggers `disconnect_dongle()`, **instantly terminating all active voice calls on that SIM**.

---

### 4.3 Missing Mutex Destruction in `pvt_free()`
* **File & Lines:** `chan_dongle.c:730–739`
* **Code Reference:**
  ```c
  static void pvt_free(struct pvt * pvt) {
      at_queue_flush(pvt);
      if(pvt->dsp) ast_dsp_free(pvt->dsp);
      ast_mutex_unlock(&pvt->lock);
      ast_free(pvt); /* Mutex is never destroyed */
  }
  ```
* **Mechanism & Impact:**  
  `pvt->lock` is an `ast_mutex_t`. Freeing the structure without calling `ast_mutex_destroy(&pvt->lock)` corrupts Asterisk's mutex tracking structures (`DEBUG_THREADS`), leading to crashes during dynamic module reloads or dongle removal.

---

### 4.4 Ineffective Logic in Master Audio Channel Traversal
* **File & Lines:** `channel.c:334`
* **Code Reference:**
  ```c
  AST_LIST_TRAVERSE(&pvt->chans, cpvt2, entry) {
      if(cpvt2 != cpvt) {
          if(CPVT_TEST_FLAG(cpvt, CALL_FLAG_MASTER)) /* Tests cpvt instead of cpvt2 */
  ```
* **Impact:**  
  Inside the loop iterating over `cpvt2`, the condition checks `cpvt` (which was already confirmed non-master at line 325). The condition is always `false`, preventing the debug logging for audio master reassignment from ever executing.

---

# PART II — Round 2 Findings

## 5. DTMF, Concurrency & Advanced Signaling

### 5.1 LIFO Inversion of Priority AT Commands / DTMF Scrambling
* **File & Lines:** `at_queue.c:113–116` and `at_command.c:419`
* **Code Reference:**
  ```c
  if(prio && (first = AST_LIST_FIRST (&pvt->at_queue)))
      AST_LIST_INSERT_AFTER (&pvt->at_queue, first, e, entry);
  else
      AST_LIST_INSERT_TAIL (&pvt->at_queue, e, entry);
  ```
* **Mechanism & Impact:**  
  All high-priority commands (such as `at_enqueue_dtmf()`, `at_enqueue_hangup()`, and `at_enqueue_answer()`) use `prio = 1`. When a user or dialplan rapidly dials multiple DTMF digits (e.g. `1`, `2`, `3`), each digit is queued via `at_enqueue_dtmf()` with `prio = 1`.  
  Because `AST_LIST_INSERT_AFTER(..., first, e, ...)` always places the newly inserted task immediately behind the executing head task, it behaves as a **LIFO (Last-In, First-Out) stack** for all priority items.  
  If the head command is still in flight, digit `1` is placed after head (`[head, 1]`), digit `2` is placed after head (`[head, 2, 1]`), and digit `3` is placed after head (`[head, 3, 2, 1]`).  
  The modem transmits `3` $\rightarrow$ `2` $\rightarrow$ `1`. Remote IVRs, bank menus, and voicemail systems receive reversed DTMF sequences, causing input failure.

---

### 5.2 Dangerous 110 KB Stack Allocation in `at_enqueue_sms()`
* **File & Lines:** `at_command.c:289–300`
* **Code Reference:**
  ```c
  int msg_len = strlen(msg);
  uint16_t msg_ucs2[msg_len * 2]; /* Variable Length Array on stack */
  ...
  pdu_part_t pdus[255];            /* 255 * 272 bytes = 69,360 bytes on stack! */
  ```
* **Mechanism & Impact:**  
  `sizeof(pdu_part_t)` is 272 bytes (`uint8_t buffer[256]` + 16 bytes lengths). Declaring `pdus[255]` consumes **69.3 KB** directly on the execution stack. Coupled with `msg_ucs2` (up to 40 KB for large messages), the stack allocation exceeds **110 KB in a single function frame**.  
  In Asterisk, background threads and AMI connection workers frequently run with thread stack limits of 128 KB or 256 KB. Triggering SMS dispatch via AMI (`DongleSendSMS`) or dialplan on a thread with minimal stack headroom can immediately exceed the guard page, causing a `SIGSEGV` crash.

---

### 5.3 Massive 86 KB Stack Frame in `at_response_cmgr()`
* **File & Lines:** `at_response.c:1295–1308`
* **Code Reference:**
  ```c
  static int at_response_cmgr(struct pvt* pvt, char * str, size_t len)
  {
      char msg[4096];
      char text_base64[40800];   /* 40.8 KB */
      char fullmsg[160 * 255];   /* 40.8 KB */
      int status_report[256];    /* 1.0 KB */
  ```
* **Mechanism & Impact:**  
  `at_response_cmgr()` allocates over **86 KB** of local stack buffers. This function is invoked from `do_monitor_phone()`. On Linux distributions with strict background thread stack sizes (e.g., custom Asterisk builds or constrained kernels), receiving an incoming multi-part SMS during active call monitoring can exhaust the thread stack and crash the Asterisk process.

---

### 5.4 Out-of-Bounds Stack Read in `smsdb.c` Key Formatting
* **File & Lines:** `smsdb.c:324, 428, 569, 649`
* **Code Reference:**
  ```c
  fullkey_len = snprintf(fullkey, sizeof(fullkey), "%s/%s/%d/%d", id, addr, ref, parts);
  if (fullkey_len < 0) {
      ast_log(LOG_ERROR, "Key length must be less than %zu bytes\n", sizeof(fullkey));
      return -1;
  }
  ...
  sqlite3_bind_text(put_message_stmt, 1, fullkey, fullkey_len, SQLITE_STATIC);
  ```
* **Mechanism & Impact:**  
  Under C99 standard specifications, `snprintf()` returns the total length of the string *that would have been formatted* had buffer space been sufficient (returning negative only on encoding failure). If `id` or `addr` contains excessive length, truncation occurs and `fullkey_len >= sizeof(fullkey)`.  
  The check `if (fullkey_len < 0)` does not catch truncation. The oversized `fullkey_len` is passed to `sqlite3_bind_text()`, causing SQLite to read past the end of `fullkey` into adjacent stack memory, leading to stack memory corruption or junk SQLite database keys.

---

### 5.5 Fatal NULL Pointer Dereference in `channel_func_write()`
* **File & Lines:** `channel.c:1600–1609`
* **Code Reference:**
  ```c
  static int channel_func_write(struct ast_channel* channel, const char* function, char* data, const char* value)
  {
      struct cpvt* cpvt = ast_channel_tech_pvt(channel);
      struct pvt* pvt = cpvt->pvt;  /* BUG: Dereferenced BEFORE check! */
      call_state_t newstate, oldstate;
      int ret = 0;

      if(!cpvt || !cpvt->pvt)       /* Check arrives too late */
      {
          ast_log (LOG_WARNING, "call on unreferenced %s\n", ast_channel_name(channel));
          return -1;
      }
  ```
* **Mechanism & Impact:**  
  Line 1601 dereferences `cpvt->pvt` unconditionally. If `DONGLE(callstate)` or `DONGLE(dtmf)` write function is invoked via Asterisk dialplan on a channel whose `tech_pvt` has been disassociated (or during a hangup race), `cpvt` is `NULL`. The read from `cpvt->pvt` generates a kernel page fault at offset 0, causing an immediate Asterisk segfault.

---

### 5.6 Unhandled `+CME ERROR` Causes 5-Second Hang and Device Disconnect
* **File & Lines:** `at_response.h:16–64` and `at_command.c:134`
* **Code Reference:**
  In `at_response.h`:
  ```c
  _( CMS_ERROR, "+CMS ERROR", "+CMS ERROR:") /* Defined for SMS */
  /* +CME ERROR is completely omitted from AT_RESPONSES_TABLE */
  ```
* **Mechanism & Impact:**  
  In 3GPP specifications, `+CME ERROR: <num>` indicates Equipment/Modem errors (e.g. `10` = SIM not inserted, `11` = PIN required, `30` = No network service, `32` = Network detachment). Although `at_command.c` attempts to suppress numeric errors with `AT+CMEE=0`, if `AT+CMEE=0` fails, if the modem reboots to defaults, or if unsolicited errors occur, `chan_dongle` classifies `+CME ERROR` as `RES_UNKNOWN`.  
  The command that triggered it (such as `ATD` or network registration) never receives a failure event and stalls in `at_queue` until the 5-second `at_queue_timeout` triggers, leading to `timedout while waiting 'OK' in response to 'ATD...'` and an immediate, unnecessary dongle disconnect.

---

### 5.7 CLIR Outbound Caller Privacy Inversion Bug
* **File & Lines:** `channel.c:271–277`
* **Code Reference:**
  ```c
  if (CONF_SHARED(pvt, usecallingpres)) {
      if (CONF_SHARED(pvt, callingpres) < 0) {
  #if ASTERISK_VERSION_NUM >= 10800 /* 1.8+ */
          clir = ast_channel_connected(channel)->id.number.presentation;
  #else
          clir = channel->cid.cid_pres;
  #endif
      }
  ```
* **Mechanism & Impact:**  
  On an outgoing call (placing a call to cellular), the *calling* party is the local Asterisk extension, while the *connected* party is the destination phone number being dialed. `ast_channel_connected(channel)` holds the called party's presentation, which is 0/unassigned at call setup.  
  The privacy setting of the caller (`CALLERPRES()`, `AST_PRES_PROHIB_USER_NUMBER_PASSED_SCREEN`) is stored in `ast_channel_caller(channel)`. Because `chan_dongle` reads `connected` instead of `caller`, dialplan rules requesting Caller ID blocking (`CLIR=1`) are ignored, and numbers are exposed over cellular trunks.

---

### 5.8 Missing Audio/Timing FD Migration on Channel Masquerade
* **File & Lines:** `channel.c:1070–1089`
* **Code Reference:**
  ```c
  static int channel_fixup (struct ast_channel* oldchannel, struct ast_channel* newchannel)
  {
      struct cpvt * cpvt = ast_channel_tech_pvt(newchannel);
      ...
      ast_mutex_lock (&pvt->lock);
      if (cpvt->channel == oldchannel) {
          cpvt->channel = newchannel;
      }
      ast_mutex_unlock (&pvt->lock);
      return 0;
  }
  ```
* **Mechanism & Impact:**  
  When an Asterisk channel masquerade occurs (e.g. call transfers, parking lot pickup, or local channel optimization), `channel_fixup()` updates `cpvt->channel = newchannel`. However, it **does not re-register the file descriptors** on `newchannel`.  
  In `activate_call()`:
  ```c
  ast_channel_set_fd(cpvt->channel, 0, pvt->audio_fd);
  ast_channel_set_fd(cpvt->channel, 1, ast_timer_fd(pvt->a_timer));
  ```
  `newchannel` does not inherit the timer FD or audio FD settings. If the Asterisk core relies on channel FDs for read polling, audio timing interrupts fail to fire on the transferred leg, causing call freeze or silence.

---

### 5.9 Deadlock in `do_monitor_phone()` from Synchronous Dialplan Spawning
* **File & Lines:** `at_response.c:1388, 1540` and `chan_dongle.c:438, 551–557`
* **Code Reference:**
  In `do_monitor_phone()`:
  ```c
  ast_mutex_lock (&pvt->lock);
  if (at_response (pvt, iov, iovcnt, at_res) || at_queue_run(pvt)) ...
  ast_mutex_unlock (&pvt->lock);
  ```
  Inside `at_response()` $\rightarrow$ `at_response_cmgr()` / `at_response_cusd()`:
  ```c
  start_local_channel(pvt, "sms", oa, vars);
  ```
  Inside `start_local_channel()`:
  ```c
  channel = ast_request("Local", ...);
  cause = ast_pbx_start(channel);
  ```
* **Mechanism & Impact:**  
  `start_local_channel()` is executed synchronously while `pvt->lock` is held by the modem monitoring thread. `ast_pbx_start()` immediately executes Asterisk dialplan on the `Local/sms` or `Local/ussd` channel. If that dialplan executes applications that query or command the dongle (such as `DongleStatus()`, `DongleSendSMS()`, or outbound call generation), the dialplan thread attempts to acquire `pvt->lock`. This creates an immediate lock inversion deadlock, freezing the modem monitor thread and stopping all audio I/O on that dongle.

---

### 5.10 Incoming Caller ID Permanently Lost If Delivered After Ring 1
* **File & Lines:** `at_response.c:952–962, 1933–1936`
* **Code Reference:**
  In `at_response.c`:
  ```c
  /* case RES_CLIP: return at_response_clip (pvt, str, len); is commented out! */
  ```
  In `at_response_clcc()`:
  ```c
  if(dir == CALL_DIR_INCOMING && (state == CALL_STATE_INCOMING || state == CALL_STATE_WAITING)) {
      if(cpvt->channel) {
          int rings = ast_channel_rings(cpvt->channel);
          rings += pvt->rings;
          ast_channel_rings_set(cpvt->channel, rings);
          pvt->rings = 0;
      }
  }
  ```
* **Mechanism & Impact:**  
  `+CLIP:` parsing is commented out. Caller ID relies exclusively on `+CLCC:` polling. On many GSM/3G mobile networks, the caller's number is transmitted between the first and second ring. When `start_pbx()` launches on Ring 1, the number may still be empty (`""`).  
  When subsequent rings arrive and `+CLCC` finally returns the caller number, line 957 increments `rings` on the Asterisk channel, but **never updates `CALLERID(num)` or `ast_set_callerid()`**. The call is permanently tagged as "Unknown/Anonymous" in CDR and CRM records.

---

### 5.11 Multi-Line Parser Hangs on Non-Empty `\r\nOK\r\n` Delimiter
* **File & Lines:** `at_read.c:171–180`
* **Code Reference:**
  ```c
  else if (rb_memcmp (rb, "+CMGR:", 6) == 0 || rb_memcmp (rb, "+CLCC:", 6) == 0 ...) {
      iovcnt = rb_read_until_mem_iov (rb, iov, "\n\r\nOK\r\n", 7);
      if (iovcnt > 0) {
          *read_result = 0;
      }
      return iovcnt;
  }
  ```
* **Mechanism & Impact:**  
  `at_read_result_iov()` looks for the exact 7-byte string `"\n\r\nOK\r\n"`. If a non-standard modem firmware returns `\r\nOK\r\n` without an intermediate empty line, or if the modem replies to `AT+CLCC` with `\r\nERROR\r\n`, the parser never matches the terminator. The input ringbuffer stalls until `at_queue_timeout` triggers (5s) and drops the dongle.

---

### 5.12 Dialplan `DongleSendSMS` Fails on Calls Without Optional Payload
* **File & Lines:** `app.c:109–114`
* **Code Reference:**
  ```c
  if (ast_strlen_zero(args.payload))
  {
      ast_log(LOG_ERROR, "NULL payload for message -- SMS will not be sent\n");
      return -1;
  }
  ```
* **Mechanism & Impact:**  
  While the AMI handler in `manager.c` correctly treats `payload` as optional, `app.c` enforces a strict check: `if (ast_strlen_zero(args.payload)) return -1;`. Calling `DongleSendSMS(dongle0, 01012345678, Message)` from Asterisk dialplan without providing a 6th argument results in immediate rejection with `NULL payload for message`.

---

### 5.13 Config Parser Overwrites `mindtmfduration` on Invalid Interval
* **File & Lines:** `dc_config.c:215–224`
* **Code Reference:**
  ```c
  else if (!strcasecmp (v->name, "mindtmfinterval")) {
      errno = 0;
      config->mindtmfinterval = (int) strtol (v->value, (char**) NULL, 10);
      if ((config->mindtmfinterval == 0 && errno == EINVAL) || config->mindtmfinterval < 0) {
          ast_log(LOG_ERROR, "Invalid value for 'mindtmfinterval' '%s', setting default %d\n", v->value, DEFAULT_MINDTMFINTERVAL);
          config->mindtmfduration = DEFAULT_MINDTMFINTERVAL; /* TYPO: assigns to mindtmfduration */
      }
  }
  ```
* **Mechanism & Impact:**  
  A copy-paste typo in `dc_config.c` assigns `DEFAULT_MINDTMFINTERVAL` to `config->mindtmfduration` when `mindtmfinterval` is invalid. This leaves `mindtmfinterval` corrupted (zero or negative) while unintentionally resetting the minimum DTMF tone duration.

---

### 5.14 Infinite 100% CPU Spin in `clean_read_data()` on Disconnect
* **File & Lines:** `chan_dongle.c:402–419`
* **Code Reference:**
  ```c
  EXPORT_DEF void clean_read_data(const char * devname, int fd) {
      char buf[2*1024];
      struct ringbuffer rb;
      int iovcnt;
      int t;

      rb_init (&rb, buf, sizeof (buf));
      for (t = 0; at_wait(fd, &t); t = 0) {
          iovcnt = at_read (fd, devname, &rb);
          ...
          if (iovcnt == 0)
              break;
      }
  }
  ```
* **Mechanism & Impact:**  
  `clean_read_data()` polls with `t = 0` (non-blocking). If the serial device has disconnected or experienced an I/O fault, `at_read()` returns a negative value (`-1`, `EIO`, `EBADF`). The loop condition `if (iovcnt == 0) break;` only checks for zero. It fails to break on negative error returns, causing the thread to spin in an infinite, 100% CPU busy loop.

---

### 5.15 Audio Truncation on Untimed Writes with Large Frame Size
* **File & Lines:** `channel.c:1033–1049`
* **Code Reference:**
  ```c
  iov[0].iov_base = f->data.ptr;
  iov[0].iov_len = FRAME_SIZE; /* Fixed to 320 bytes */
  ...
  iov_write(pvt, pvt->audio_fd, iov, iovcnt);
  ```
* **Mechanism & Impact:**  
  If Asterisk timing modules (`res_timing_timerfd`) are unavailable and `pvt->a_timer` is `NULL`, `channel_write()` limits `iov[0].iov_len` to `FRAME_SIZE` (320 bytes / 20 ms). If Asterisk core delivers a 40 ms frame (640 bytes) or transcoded block, all bytes beyond 320 are discarded without warning.

---

### 5.16 Single Syntax Error in `dongle.conf` Destroys Live Dongles
* **File & Lines:** `chan_dongle.c:1616–1623` and `chan_dongle.c:792–796`
* **Code Reference:**
  ```c
  AST_RWLIST_TRAVERSE(&state->devices, pvt, entry) {
      ast_mutex_lock(&pvt->lock);
      pvt->must_remove = 1; /* Pre-emptively marks ALL devices for deletion */
      ast_mutex_unlock(&pvt->lock);
  }
  ...
  /* If a device section has a parse error, must_remove remains 1 */
  ```
  In `do_discovery()`:
  ```c
  if(pvt->must_remove) {
      AST_RWLIST_REMOVE_CURRENT(entry);
      pvt_free(pvt); /* Physical device removed and calls terminated! */
  }
  ```
* **Mechanism & Impact:**  
  During `dongle reload`, `reload_config()` marks `must_remove = 1` across all running devices. If any device section has a typo or invalid parameter, the parser skips it. Its `must_remove` flag remains `1`. The background discovery thread unregisters the device, frees the `pvt`, and aborts all active voice calls.

---

# PART III — Round 3 Findings

## 6. Remote Over-The-Air Exploits, PDU & State Machine Hazards

### 6.1 Critical Over-the-Air Remote Stack Buffer Overflow in `at_parse_cmgr()`
* **File & Lines:** `at_parse.c:358, 403` vs `pdu.c:931`
* **Code Reference:**
  In `at_parse.c`:
  ```c
  uint16_t msg16_tmp[256]; /* Buffer allocated for 256 uint16_t elements */
  ...
  res = tpdu_parse_deliver((const uint8_t*)str + i, pdu_length - i,
          *tpdu_type, oa, oa_len, scts, msg16_tmp, udh);
  ```
  In `pdu.c`:
  ```c
  out_len = gsm7_unpack_decode(
          (const char*)pdu + i, udl_nibbles, msg,
          1024 /* Tells decoder the buffer has 1024 elements! */,
          msg_padding, udh->ls, udh->ss);
  ```
* **Mechanism & Impact:**  
  `at_parse_cmgr()` allocates `msg16_tmp` on the stack with **256 elements** (512 bytes). When calling `tpdu_parse_deliver()`, the function passes `1024` as the `out_size` parameter to `gsm7_unpack_decode()`. If an incoming SMS over cellular has more than 256 7-bit characters (e.g. a long multi-part SMS or carrier message), `gsm7_unpack_decode()` writes up to 1024 words (2,048 bytes) into `msg16_tmp[256]`.  
  This is an **unauthenticated remote stack buffer overflow over the cellular radio link**. An attacker sending an SMS to the dongle can overwrite stack frame pointers and crash the Asterisk server or achieve remote code execution.

---

### 6.2 Signed Integer Underflow to 18 Quintillion in `tpdu_parse_deliver()`
* **File & Lines:** `pdu.c:852–855` and `pdu.c:931`
* **Code Reference:**
  ```c
  if (alphabet == PDU_DCS_ALPHABET_7BIT) {
      msg_padding = 6 - (udhl % 7);
      udl_nibbles -= (udhl + 1) * 2; /* Signed int subtraction */
  }
  ...
  out_len = gsm7_unpack_decode(
          (const char*)pdu + i, udl_nibbles, msg, 1024, ...);
  ```
  In `char_conv.c`:
  ```c
  EXPORT_DEF ssize_t gsm7_unpack_decode(const char *in, size_t in_nibbles, ...);
  ```
* **Mechanism & Impact:**  
  `udl_nibbles` is a signed `int`. If a malformed incoming SMS has a User Data Header Length (`udhl`) greater than the User Data Length (`udl`), `udl_nibbles` becomes negative (e.g., `-2`). When passed to `gsm7_unpack_decode()`, the second parameter is typed as `size_t in_nibbles` (unsigned 64-bit). The negative integer is cast to `18,446,744,073,709,551,614`.  
  Inside `gsm7_unpack_decode()`, the decoding loop runs up to `in_nibbles`, reading past the end of the PDU buffer into unmapped kernel/user memory, triggering an immediate `SIGSEGV` crash.

---

### 6.3 Double-Byte Multiply Buffer Overflow in `utf8_to_ucs2()`
* **File & Lines:** `at_command.c:290–291` and `char_conv.c:71–75`
* **Code Reference:**
  In `at_command.c`:
  ```c
  int msg_len = strlen(msg);
  uint16_t msg_ucs2[msg_len * 2];
  res = utf8_to_ucs2(msg, msg_len, msg_ucs2, sizeof(msg_ucs2)); /* Passes BYTES */
  ```
  In `char_conv.c`:
  ```c
  EXPORT_DEF ssize_t utf8_to_ucs2(const char *in, size_t in_length, uint16_t *out, size_t out_size)
  {
      ssize_t res = convert_string(in, in_length, (char*)out, out_size * 2, "UTF-8", "UTF-16BE");
  ```
* **Mechanism & Impact:**  
  `utf8_to_ucs2()` expects `out_size` in `uint16_t` units (word count) and multiplies it by 2 to pass to `iconv()` (`out_size * 2`). However, `at_command.c` passes `sizeof(msg_ucs2)`, which is already in **bytes**. Inside `utf8_to_ucs2()`, this value is multiplied by 2 again, informing `iconv()` that the stack buffer is **twice as large as allocated**. On multi-byte character conversions producing extensive output, `iconv()` writes past the stack boundary of `msg_ucs2`.

---

### 6.4 Silent Error Bypass in Hex PDU Parsing
* **File & Lines:** `at_parse.c:370–374`
* **Code Reference:**
  ```c
  int pdu_length = (unhex(str, (uint8_t*)str) + 1) / 2;
  if (pdu_length < 0) {
      chan_dongle_err = E_MALFORMED_HEXSTR;
      return -1;
  }
  ```
* **Mechanism & Impact:**  
  If `unhex()` encounters non-hexadecimal bytes in an incoming SMS PDU, it returns `-1`. The formula `(-1 + 1) / 2` evaluates to `0 / 2 = 0`. The error check `if (pdu_length < 0)` evaluates to `false` because `0 < 0` is false. The parser fails to report `E_MALFORMED_HEXSTR` and proceeds to parse corrupted data with length 0, triggering downstream parsing anomalies.

---

### 6.5 Audio Starvation and Delayed Audio Burst in Music-On-Hold (MOH)
* **File & Lines:** `channel.c:726–731` and `channel.c:1000–1015`
* **Code Reference:**
  ```c
  /* In channel_read(): */
  if (pvt->a_timer && ast_channel_fdno(channel) == 1) {
      ast_timer_ack (pvt->a_timer, 1);
      timing_write (pvt);
  }
  ```
* **Mechanism & Impact:**  
  The outbound audio writer (`timing_write()`) is hosted exclusively inside the inbound audio reader callback (`channel_read()`). When an active call is placed on hold (`ast_moh_start`), Asterisk core stops reading incoming audio frames from the held channel. Because `channel_read()` is never invoked, `timing_write()` is starved and never runs.  
  Asterisk continues to generate MOH frames via `channel_write()`, which rapidly saturates `pvt->a_write_mixb`. When the agent unholds the call, seconds of stale, delayed MOH audio burst through before live voice communication resumes.

---

### 6.6 False-Success Pickup Reporting When `at_enqueue_answer()` Fails
* **File & Lines:** `channel.c:452–476`
* **Code Reference:**
  ```c
  static int channel_answer (struct ast_channel* channel)
  {
      ...
      if (cpvt->dir == CALL_DIR_INCOMING) {
          if (at_enqueue_answer(cpvt)) {
              ast_log (LOG_ERROR, "[%s] Error sending answer commands\n", PVT_ID(pvt));
          }
      }
      ast_mutex_unlock (&pvt->lock);
      return 0; /* Returns SUCCESS unconditionally! */
  }
  ```
* **Mechanism & Impact:**  
  If `at_enqueue_answer()` fails (due to queue saturation or invalid channel state), `channel_answer()` logs an error but returns `0` (Success) to Asterisk. Asterisk core transitions the channel to `AST_STATE_UP`, connects the bridge, and starts billing, even though the physical modem never answered the incoming call. The mobile caller continues to hear ringing while the agent speaks into dead air.

---

### 6.7 Wildcard Dongle Capture on Empty Identifier Dials
* **File & Lines:** `chan_dongle.c:1184, 1235, 1252`
* **Code Reference:**
  ```c
  if (!strcmp(pvt->imei, &resource[2]))
  ...
  i = strlen (&resource[2]);
  if (!strncmp (pvt->imsi, &resource[2], i))
  ```
* **Mechanism & Impact:**  
  If an outbound dial string is misconfigured as `Dongle/i:/<number>` (empty IMEI) or `Dongle/s:/<number>` (empty IMSI), `strcmp(pvt->imei, "")` or `strncmp(pvt->imsi, "", 0)` evaluates to `0` (match). This causes the call to seize any uninitialized modem on the USB bus whose IMEI/IMSI strings are currently empty.

---

### 6.8 Memory Leak in USB Interface Port Probing
* **File & Lines:** `pdiscovery.c:380–385`
* **Code Reference:**
  ```c
  for(idx = 0; idx < ITEMS_OF(ports->ports); idx++) {
      if(interface == device->interfaces[idx]) {
          ports->ports[idx] = port;
          found++;
          port = NULL;
          break;
      }
  }
  ```
* **Mechanism & Impact:**  
  If the kernel sysfs directory enumerates multiple subdirectories matching the same interface index, `ports->ports[idx]` is overwritten with the new `port` pointer without freeing the existing string, leaking heap memory during automated port discovery cycles.

---

### 6.9 Discovery Driver Mismatch on `12d1:1506` Huawei Modems
* **File & Lines:** `pdiscovery.c:70`
* **Code Reference:**
  ```c
  { 0x12d1, 0x1506, { 1, 2 } }, /* Claims interface 1 is Data */
  ```
* **Mechanism & Impact:**  
  On modern Linux kernels, interface 1 of modem `12d1:1506` is bound to the `huawei_cdc_ncm` network driver, which does not create a `/dev/ttyUSB` serial node. Because `pdiscovery` searches for a serial device on interface 1, automatic discovery fails completely for `12d1:1506` dongles, requiring hardcoded `audio=` and `data=` configurations.

---

### 6.10 Use-After-Free in `channel_func_read()` Deadlock Avoidance
* **File & Lines:** `channel.c:1555–1560`
* **Code Reference:**
  ```c
  while (ast_mutex_trylock (&pvt->lock)) {
      CHANNEL_DEADLOCK_AVOIDANCE (channel);
  }
  call_state_t state = cpvt->state;
  ast_mutex_unlock(&pvt->lock);
  ```
* **Mechanism & Impact:**  
  During `CHANNEL_DEADLOCK_AVOIDANCE`, the channel lock is temporarily yielded. If the channel is hung up and `cpvt_free(cpvt)` executes on another thread while unlocked, `cpvt` is freed. Once `pvt->lock` is re-acquired, line 1559 reads `cpvt->state` from freed memory.

---

### 6.11 Premature Device Deallocation on Forced Module Unload
* **File & Lines:** `chan_dongle.c:1708, 1836`
* **Code Reference:**
  ```c
  static void devices_destroy(public_state_t * state) {
      while((pvt = AST_RWLIST_REMOVE_HEAD(&state->devices, entry))) {
          pvt_destroy(pvt);
      }
  }
  ```
* **Mechanism & Impact:**  
  `devices_destroy()` unlinks and frees all `pvt` devices immediately. If an Asterisk channel thread is active inside `channel_write()` and yielding `pvt->lock`, the `pvt` structure is freed underneath it. When `channel_write()` attempts to re-lock `pvt->lock`, it crashes with a use-after-free fault.

---

### 6.12 Unbounded Stack Allocation (VLA) in `pdu_build_mult()`
* **File & Lines:** `pdu.c:463`
* **Code Reference:**
  ```c
  uint16_t msg_gsm7[msg_len];
  ```
* **Mechanism & Impact:**  
  The Variable Length Array (VLA) `msg_gsm7` is allocated directly on the stack proportional to `msg_len` with no upper bounds check. If an application attempts to transmit an oversized text string, the stack allocation exceeds the stack limits of the Asterisk worker thread.

---

# PART IV — Round 4 Findings

## 7. Buffer Overflows, Protocol Encoding & State Polling Flaws

### 7.1 Heap/Stack Buffer Overflow in `gsm7_pack()` on GSM Extension Characters
* **File & Lines:** `char_conv.c:158–179` and `pdu.c:641`
* **Code Reference:**
  In `char_conv.c`:
  ```c
  x = ((out_padding + (7 * in_length) + 7) / 8) + 1;
  if (x > out_size)
      return -1;

  for (x = i = 0; i != in_length; i++) {
      char c[] = { in[i] >> 8, in[i] & 255 };
      for (int j = c[0] == 0; j < 2; ++j) {
          value |= (c[j] & 0x7F) << out_padding;
          out_padding += 7;
          if (out_padding < 8) continue;
          out[x++] = value & 0xff; /* No bounds check inside loop! */
          value >>= 8;
          out_padding -= 8;
      }
  }
  ```
* **Mechanism & Impact:**  
  The required buffer size calculation `x = ((out_padding + (7 * in_length) + 7) / 8) + 1` assumes every element of `in[]` is a standard 7-bit character. However, GSM 7-bit extension characters (such as `€`, `[`, `]`, `{`, `}`, `\`, `|`, `~`, `^`) require 2 septets (14 bits) because they are prefixed with the escape character `0x1B`.  
  `in[i]` holds both bytes: `c[0] = in[i] >> 8` (0x1B) and `c[1] = in[i] & 255`. When an extension character is encountered, the inner loop executes twice (`j=0` and `j=1`), emitting 14 bits.  
  If an outbound SMS contains numerous extension characters, the actual packed stream is up to **twice as large** as `x`. The pre-check `x > out_size` succeeds, and the unconstrained loop writes up to 280 bytes into `out[x++]` where `out_size` was only 140 bytes, corrupting heap or stack memory in `pdu.c` (`pdus[i].buffer`).

---

### 7.2 8 KB Stack Buffer Overflow in `at_enqueue_ussd()`
* **File & Lines:** `at_command.c:338, 346, 363`
* **Code Reference:**
  ```c
  char buf[4096];
  ...
  uint8_t code_packed[4069];
  ...
  res = gsm7_pack(code16, res, (char*)code_packed, sizeof(code_packed), 0);
  ...
  res = (res + 1) / 2;
  hexify(code_packed, res, buf + STRLEN(cmd));
  ```
* **Mechanism & Impact:**  
  `buf` is allocated on the stack as `char buf[4096]`. `code_packed` is `4069` bytes. If a long USSD string is passed from CLI, AMI, or dialplan (`helpers.c:111` performs no length check on USSD), `res` can be up to 4069 bytes.  
  `hexify()` writes 2 hex characters for every byte in `code_packed` (`res * 2` bytes). If `res > 2040`, `res * 2 > 4080 + 11 (cmd) > 4096`, writing up to 8,150 bytes directly into the 4,096-byte stack buffer `buf`. This smashes the execution stack frame of the thread calling `send_ussd()`.

---

### 7.3 Double-Byte Multiply Overflow in `at_enqueue_ussd()` UCS-2 Conversion
* **File & Lines:** `at_command.c:345–347`
* **Code Reference:**
  ```c
  int code_len = strlen(code);
  uint16_t code16[code_len * 2];
  res = utf8_to_ucs2(code, code_len, code16, sizeof(code16));
  ```
* **Mechanism & Impact:**  
  `code16` is an array of `uint16_t` words. `sizeof(code16)` evaluates to the size in **bytes** (`code_len * 4`).  
  `utf8_to_ucs2()` takes this parameter as `out_size` (which it treats as word count) and passes `out_size * 2` to `iconv()`:
  ```c
  convert_string(in, in_length, (char*)out, out_size * 2, "UTF-8", "UTF-16BE");
  ```
  `iconv()` is instructed that the buffer is `code_len * 8` bytes wide—**twice as large as the actual stack allocation**. For long USSD messages with multi-byte UTF-8 sequences, `iconv()` writes past the end of `code16`.

---

### 7.4 Remote Over-The-Air Stack Buffer Overflow in UCS-2 SMS Delivery
* **File & Lines:** `pdu.c:940–944` and `at_parse.c:358, 403`
* **Code Reference:**
  In `pdu.c`:
  ```c
  int msg_len = pdu_length - i, out_len;
  if (alphabet == PDU_DCS_ALPHABET_7BIT) {
      ...
  } else {
      out_len = msg_len / 2;
      memcpy((char*)msg, pdu + i, msg_len); /* Copies msg_len bytes */
      msg[out_len] = '\0';
  }
  ```
* **Mechanism & Impact:**  
  In `at_parse.c`, `msg` is passed as `msg16_tmp`, which is allocated on the stack with **256 words (512 bytes)**. In `pdu.c`, when a 16-bit UCS-2 SMS (`alphabet == PDU_DCS_ALPHABET_UCS2`) is decoded, line 941 executes `memcpy((char*)msg, pdu + i, msg_len)` without verifying that `msg_len <= 512`.  
  If a malformed or carrier PDU has `msg_len > 512`, `memcpy` writes directly past `msg16_tmp` on the stack frame of `at_response_cmgr()`. Combined with Flaw 33, this represents an unauthenticated, remote, over-the-air stack buffer overflow for **both** GSM 7-bit and UCS-2 SMS payloads.

---

### 7.5 Unit Mismatch Rejects Valid Numbers in `pdu_parse_number()` (Nibbles vs Bytes)
* **File & Lines:** `pdu.c:411–414`
* **Code Reference:**
  ```c
  unsigned syms = ROUND_UP2(digits);
  if (syms > pdu_length - i) {
      return -EINVAL;
  }
  ```
* **Mechanism & Impact:**  
  `digits` is the number of semi-octets (digits) in the telephone number (e.g., a 12-digit number has `digits = 12`).  
  `syms` is therefore in **nibbles** (`syms = 12`).  
  However, `pdu_length - i` is in **bytes (octets)**.  
  Line 412 checks `if (syms > pdu_length - i)`. If a short PDU (e.g. an SMS-STATUS-REPORT or short delivery notification) has 8 remaining bytes and a 12-digit number, `syms (12) > pdu_length - i (8)` evaluates to `true`, and the function returns `-EINVAL`.  
  Because each byte holds two nibbles, the required buffer size is only `DIV2UP(syms)` (6 bytes). Comparing nibbles to bytes causes valid incoming phone numbers and SMS delivery receipts to be falsely rejected with `E_INVALID_PHONE_NUMBER` or `E_INVALID_SCA`.

---

### 7.6 Continuous Mutex Polling & Synchronous PBX Deadlock in `handle_expired_reports()`
* **File & Lines:** `chan_dongle.c:493–495, 421–441` and `smsdb.c:65`
* **Code Reference:**
  In `do_monitor_phone()`:
  ```c
  while (1) {
      ast_mutex_lock (&pvt->lock);
      handle_expired_reports(pvt);
      ...
  ```
  In `handle_expired_reports()`:
  ```c
  ssize_t payload_len = smsdb_outgoing_purge_one(dst, payload);
  if (payload_len >= 0) {
      ...
      start_local_channel(pvt, "report", dst, vars);
  ```
* **Mechanism & Impact:**  
  `handle_expired_reports(pvt)` is invoked on **every single pass of the monitor thread loop** under `pvt->lock`. Inside `smsdb_outgoing_purge_one()`, it locks the global `dblock` mutex and executes a SQLite query:
  `SELECT rowid, payload, dst FROM outgoing_msg WHERE expiration < CURRENT_TIMESTAMP LIMIT 1`.  
  When an expired report is found, `start_local_channel()` launches `Local/report...` synchronously via `ast_pbx_start()` while still holding `pvt->lock`. If the dialplan for reports executes any `Dongle` commands, it deadlocks. Furthermore, running SQLite queries on every unthrottled iteration generates high database lock contention across multi-modem configurations.

---

### 7.7 CLI Discovery NULL Pointer Dereference in `cli_discovery()`
* **File & Lines:** `cli.c:799`
* **Code Reference:**
  ```c
  AST_RWLIST_TRAVERSE (&gpublic->devices, pvt, entry) {
      if(strcmp(PVT_STATE(pvt, data_tty), res->ports.ports[INTERFACE_TYPE_DATA]) == 0) {
          break;
      }
  }
  ```
* **Mechanism & Impact:**  
  In `pdiscovery.c:701`, a discovered device result can have `res->ports.ports[INTERFACE_TYPE_DATA] == NULL` if only a voice interface or non-data serial port was detected. When `dongle discovery` is executed in the Asterisk CLI, `strcmp()` is called with `res->ports.ports[INTERFACE_TYPE_DATA]` as the second argument. Passing `NULL` to `strcmp()` triggers an immediate `SIGSEGV` crash of the Asterisk process.

---

### 7.8 Empty String Validation Bypass in `is_valid_phone_number()`
* **File & Lines:** `helpers.c:35–47`
* **Code Reference:**
  ```c
  EXPORT_DEF int is_valid_phone_number(const char *number)
  {
      if (number[0] == '+') {
          number++;
      }
      for (; *number; number++) {
          if (*number >= '0' && *number <= '9') {
              continue;
          }
          return 0;
      }
      return 1;
  }
  ```
* **Mechanism & Impact:**  
  If `number` is an empty string `""` or a lone plus sign `"+"`, the initial `if (number[0] == '+')` either advances past `'+'` to `\0` or remains at `\0`. The `for` loop condition `*number` is immediately false, and the loop body never executes. The function returns `1` (true).  
  Calling `send_sms(dev, "", ...)` or `send_sms(dev, "+", ...)` bypasses validation and attempts to construct an invalid PDU with length 0, triggering downstream PDU generation errors.

---

### 7.9 Empty String Validation Bypass in `is_valid_ussd_string()`
* **File & Lines:** `helpers.c:23–32`
* **Code Reference:**
  ```c
  static int is_valid_ussd_string(const char* number)
  {
      for (; *number; number++) {
          if ((*number >= '0' && *number <= '9') || *number == '*' || *number == '#') {
              continue;
          }
          return 0;
      }
      return 1;
  }
  ```
* **Mechanism & Impact:**  
  If `number` is empty `""`, the loop does not execute and returns `1` (valid). `send_ussd(dev, "")` queues `AT+CUSD=1,"",15\r` to the modem, which confuses modem baseband firmware and can hang the USSD session.

---

# PART V — Master 53-Item Vulnerability & Flaw Matrix

| ID | Module & Line | Subsystem | Severity | Impact / Symptom |
|:---:|:---|:---|:---:|:---|
| **1** | `channel.c:977` | Audio | High | `txgain=1` attenuates audio instead of amplifying it |
| **2** | `channel.c:755` | Audio | High | Variable micro-frames cause WebRTC robotic audio and jitter |
| **3** | `channel.c:620` | Audio | Medium | Outbound audio packet loss on serial backpressure (`EAGAIN`) |
| **4** | `channel.c:947` | Audio | Critical | Permanent silence (one-way audio) after call transfers |
| **5** | `chan_dongle.h:133` | Audio | Medium | 240 ms buffer overflow under heavy CPU load |
| **6** | `at_response.c:453` | Dialing | High | Dongle locked in permanent busy state on rejected dials |
| **7** | `at_response.c:846` | Signaling | Critical | Outbound call hung up immediately if modem omits `^ORIG` |
| **8** | `channel.c:426` | Dialing | High | Modem freezes / deadlocks on rapid auto-dialer pacing |
| **9** | `at_command.c:999` | Signaling | Low | Early hangup formats invalid `AT+CHLD=10` syntax |
| **10** | `at_response.c:1044` | Signaling | High | Dead code leaves zombie channels active indefinitely |
| **11** | `at_response.c:458` | Audio | High | Answered calls are deaf/mute when `^DDSETEX=2` fails |
| **12** | `at_parse.c:622` | Parser | Medium | Anonymous / private calls fail `+CLCC` parsing |
| **13** | `at_response.c:864` | Inbound | Medium | Inbound DID falls back to `+1234567890` on missing CNUM |
| **14** | `at_response.c:1157`| Inbound | Low | First-ring volume sync delays extension ringing by 200–500 ms |
| **15** | `at_queue.c:296` | Memory | Critical | Asterisk segfault on `malloc()` failure (pre-check dereference) |
| **16** | `chan_dongle.c:528`| Lifecycle| High | 5-second AT timeout immediately disconnects dongle and calls |
| **17** | `at_queue.c:114` | DTMF | High | Multi-digit DTMF queued in reverse (LIFO) order (`321` vs `123`) |
| **18** | `at_command.c:299`| Memory | Critical | 110 KB stack allocation in `at_enqueue_sms()` risks stack overflow |
| **19** | `at_response.c:1297`| Memory| High | 86 KB stack allocation in `at_response_cmgr()` on monitor thread |
| **20** | `smsdb.c:324` | Memory | High | Stack out-of-bounds read in SQLite bindings on long keys |
| **21** | `channel.c:1601` | Core | Critical | NULL pointer dereference in `channel_func_write()` |
| **22** | `at_response.h:16` | Signaling | High | Missing `+CME ERROR` causes 5s hang and dongle disconnect |
| **23** | `channel.c:274` | Signaling | Medium | CLIR reads `connected` instead of `caller`, ignoring privacy settings |
| **24** | `channel.c:1085` | Media | Medium | Channel masquerade fails to migrate audio/timing file descriptors |
| **25** | `at_response.c:1388`| Locking | High | Synchronous dialplan spawning inside `do_monitor_phone()` causes deadlock |
| **26** | `at_response.c:954` | Signaling | Medium | Caller ID never updated if network delivers number after Ring 1 |
| **27** | `at_read.c:173` | Parser | High | Strict `\n\r\nOK\r\n` terminator stalls buffer on alternative responses |
| **28** | `app.c:109` | Dialplan | Medium | Dialplan `DongleSendSMS` rejects SMS lacking a 6th payload argument |
| **29** | `dc_config.c:222` | Parser | Low | Typo overwrites `mindtmfduration` on invalid interval |
| **30** | `chan_dongle.c:410`| Thread | High | Infinite 100% CPU spin in `clean_read_data()` on device disconnect |
| **31** | `channel.c:1034` | Audio | Low | Untimed audio write truncates frames larger than 320 bytes |
| **32** | `chan_dongle.c:1620`| Lifecycle| High | Config reload destroys live dongles on single syntax typo |
| **33** | `at_parse.c:403` | Security | Critical | Remote OTA stack buffer overflow in `at_parse_cmgr()` (`msg16_tmp[256]` vs 1024) |
| **34** | `pdu.c:854` | Security | Critical | Negative `udl_nibbles` casts to 18 quintillion unsigned, crashing Asterisk |
| **35** | `char_conv.c:73` | Memory | High | Double-byte multiply in `utf8_to_ucs2()` causes `iconv` buffer overflow |
| **36** | `at_parse.c:371` | Parser | Medium | `(-1 + 1)/2 == 0` bypasses error check on malformed hex PDU input |
| **37** | `channel.c:726` | Audio | High | Music-On-Hold outbound audio starved because reader thread is idle |
| **38** | `channel.c:476` | Signaling | High | `channel_answer()` returns 0 (Success) even when `at_enqueue_answer()` fails |
| **39** | `chan_dongle.c:1235`| Core | Medium | Dialing empty `Dongle/i:/` matches any uninitialized dongle on bus |
| **40** | `pdiscovery.c:380` | Memory | Low | Memory leak of port string on duplicate USB interface enumeration |
| **41** | `pdiscovery.c:70` | Discovery | Medium | Modem `12d1:1506` fails discovery because interface 1 is CDC-NCM |
| **42** | `channel.c:1559` | Core | High | Use-after-free in `channel_func_read()` after deadlock avoidance |
| **43** | `chan_dongle.c:1708`| Core | High | Forced module unload frees `pvt` while channel threads are active |
| **44** | `pdu.c:463` | Memory | Medium | Unchecked stack VLA `msg_gsm7[msg_len]` in `pdu_build_mult()` |
| **45** | `cli.c:799` | Core | High | `cli_discovery` calls `strcmp()` on NULL `INTERFACE_TYPE_DATA` port |
| **46** | `helpers.c:35` | Validation | Medium | `is_valid_phone_number("")` and `"+"` return 1, bypassing phone validation |
| **47** | `helpers.c:23` | Validation | Medium | `is_valid_ussd_string("")` returns 1, sending empty USSD string |
| **48** | `chan_dongle.c:495`| Concurrency| High | `handle_expired_reports()` runs on every monitor loop under mutex, risking deadlock |
| **49** | `char_conv.c:158` | Memory | Critical | Buffer overflow in `gsm7_pack()` on GSM extension characters (2x byte expansion) |
| **50** | `at_command.c:338`| Memory | Critical | 8 KB stack buffer overflow in `at_enqueue_ussd()` (`buf[4096]` vs `code_packed[4069]`) |
| **51** | `at_command.c:347`| Memory | High | Double-byte multiply overflow in `at_enqueue_ussd()` UCS-2 conversion |
| **52** | `pdu.c:941` | Security | Critical | Remote OTA stack buffer overflow in UCS-2 SMS decoding (`msg_len > 512`) |
| **53** | `pdu.c:412` | Parser | High | Unit mismatch in `pdu_parse_number()` (nibbles vs bytes) rejects valid numbers |

---

# PART VI — Comprehensive Architectural Hardening Roadmap

### 1. Remote Security & Over-The-Air Exploits (Flaws 33, 34, 35, 36, 44, 49, 50, 51, 52)
* **PDU Stack Overflow Fixes:**
  * In `at_parse.c:358`, expand `msg16_tmp` to `1024` elements (2,048 bytes) and pass buffer capacity explicitly.
  * In `pdu.c:941`, bound `msg_len` with `if (msg_len > 512) msg_len = 512;` before `memcpy((char*)msg, pdu + i, msg_len)`.
* **Guard `udl_nibbles` Underflow:**
  * In `pdu.c:854`, add: `if (udl_nibbles < 0) { chan_dongle_err = E_DECODE_GSM7; return -1; }` before invoking `gsm7_unpack_decode()`.
* **Correct UCS-2 Size Calculation:**
  * In `at_command.c:291` and `at_command.c:347`, pass `sizeof(msg_ucs2) / 2` (word count) to `utf8_to_ucs2()` to prevent the double-multiply overflow.
* **GSM Extension Bounds Check in `gsm7_pack()`:**
  * Calculate required capacity accounting for 2-septet characters: `x = ((out_padding + (7 * in_length * 2) + 7) / 8) + 1;`.
  * Add explicit bounds check: `if (x >= out_size) break;` inside the byte output loop.
* **USSD Stack Safety:**
  * In `helpers.c:113`, validate maximum USSD length (`strlen(ussd) <= 256`).
  * In `at_command.c:338`, allocate `buf` dynamically or limit `code_packed` to 1024 bytes.

### 2. Memory Safety, Stack Frames & Pointers (Flaws 15, 18, 19, 20, 21, 40, 42, 43, 45)
* **Null Check Order:**
  * In `at_queue.c:296`, move `task->uid = uid;` below `if (!task) return NULL;`.
  * In `channel.c:1601`, ensure `if (!cpvt || !cpvt->pvt) return -1;` occurs before `pvt = cpvt->pvt`.
  * In `cli.c:799`, add `if (!res->ports.ports[INTERFACE_TYPE_DATA]) continue;`.
* **Stack Footprint Reduction:**
  * In `at_command.c:299`, replace `pdus[255]` on stack with heap allocation `ast_calloc(255, sizeof(pdu_part_t))`.
  * In `at_response.c:1297`, allocate `text_base64[40800]` and `fullmsg[40800]` on the heap.
* **SQLite Snprintf Bounds Check:**
  * In `smsdb.c:324, 428, 569, 649`, check `if (fullkey_len < 0 || fullkey_len >= sizeof(fullkey))`.

### 3. Audio Pipeline, Framing & Latency (Flaws 1, 2, 3, 4, 5, 11, 31, 37)
* **Correct TX Gain Formula:**
  * In `channel.c:977`, change `else if(gains[0] <= 1)` to `else if(gains[0] <= -1)` so that positive gain values apply amplification.
* **20 ms Frame Accumulator:**
  * Buffer incoming serial audio in `cpvt->a_read_buf` until exactly 320 bytes (160 samples = 20 ms) are collected before returning `AST_FRAME_VOICE`, eliminating WebRTC jitter.
* **Reset Bridge Loop Flag:**
  * Clear `CALL_FLAG_BRIDGE_LOOP` on channel unbridge or transfer to prevent one-way audio lockout.
* **Decouple Write Pacer from Inbound Reader:**
  * Drive `timing_write()` via an independent timer or periodic Asterisk timer hook, allowing Music-On-Hold to play continuously when reader is idle.

### 4. Cellular Call Control & State Machine (Flaws 6, 7, 8, 9, 10, 12, 13, 14, 22, 23, 26, 38, 39, 41, 46, 47, 53)
* **Outbound State Reset on Failed Dials:**
  * In `at_response.c:453`, clear `pvt->dialing = 0` and set `change_channel_state(task->cpvt, CALL_STATE_RELEASED, 0)`.
* **Originating Tracking Fallback:**
  * If `^ORIG` is suppressed by firmware, allow `^CONN` to bind to the existing outbound initiating channel.
* **5-Field Anonymous CLCC Parsing:**
  * Update `at_parse.c` to accept optional `<number>` and `<type>` fields in `+CLCC` responses.
* **Fix Unit Mismatch in `pdu_parse_number()`:**
  * Change line 412 from `if (syms > pdu_length - i)` to `if ((syms + 1) / 2 > pdu_length - i)`.
* **String Input Validation:**
  * In `helpers.c`, reject empty numbers: `if (number[0] == '\0' || (number[0] == '+' && number[1] == '\0')) return 0;`.
  * Reject empty USSD strings: `if (number[0] == '\0') return 0;`.
* **Register `+CME ERROR`:**
  * Add `+CME ERROR` to `at_responses_table` to handle equipment/network errors immediately without 5s timeout drops.

### 5. Concurrency, Queueing & Deadlocks (Flaws 16, 17, 24, 25, 27, 30, 32, 48)
* **FIFO Priority Queueing:**
  * In `at_queue_add()`, insert priority commands after the last existing priority task rather than immediately after head, preserving DTMF digit order (`123`).
* **Asynchronous Dialplan Channel Launch:**
  * Defer `start_local_channel()` out of `do_monitor_phone()` or release `pvt->lock` prior to `ast_pbx_start()`.
* **Throttle Expired SMS Purging:**
  * Run `handle_expired_reports()` once every 10–30 seconds rather than on every iteration of `do_monitor_phone()`.
* **Graceful Config Reload:**
  * In `reload_config()`, do not set `must_remove = 1` until the configuration file is validated without syntax errors.
","path":"/opt/sokrat-voip/CHAN_DONGLE_AUDIT.md"})
[Tool result]: Wrote file successfully: CHAN_DONGLE_AUDIT.md
</recent-context>
</conversation-checkpoint>