# Local Egyptian-Arabic Speech-to-Text

Sokrat VoIP can transcribe completed call recordings and voicemails entirely on the PBX with `whisper.cpp`. Audio is normalized locally, sent only to a loopback HTTP endpoint, and processed asynchronously after calls.

## Runtime profile

- Runtime: pinned `whisper.cpp` `v1.9.5`
- Model: multilingual Whisper `small-q5_1`
- VAD: Silero `v6.2.0`
- Endpoint: `http://127.0.0.1:8178/inference`
- Queue concurrency: one job
- Language: Arabic, with an Egyptian customer-service prompt
- Old CPU compatibility: the installer disables unsupported AVX2/FMA/BMI2 instructions after inspecting `/proc/cpuinfo`
- Telephony priority: the worker does not start jobs while a call is active and suspends in-progress inference if an Asterisk call begins

The installer uses one inference thread on systems with fewer than four physical cores and two threads on systems with at least four physical cores. Both services run at idle scheduling priority. The inference server is accessible only through loopback.

## Installation

Run as root after the main Sokrat VoIP application is installed:

```bash
/opt/sokrat-voip/scripts/install-local-stt.sh
```

The one-time installation downloads and verifies the pinned model files. Transcription requires no internet connection after installation. Database credentials are read from the PBX configuration and stored in `/etc/sokrat-voip/stt.env` with restricted permissions.

Services:

- `sokrat-whisper.service`: local inference server
- `sokrat-stt.service`: queue worker
- `sokrat-stt-scan.timer`: bounded periodic discovery of completed recordings

Useful checks:

```bash
systemctl status sokrat-whisper.service sokrat-stt.service
systemctl list-timers sokrat-stt-scan.timer
ss -ltn | grep 8178
journalctl -u sokrat-stt.service -n 100 --no-pager
```

Port `8178` must appear only on `127.0.0.1`.

## Queue behavior

- Voicemails are processed before calls.
- Automatic discovery considers calls from the last seven days.
- The pending/processing queue is capped at 20 jobs by default.
- Interrupted jobs older than 45 minutes are recovered.
- Jobs retry up to three times.
- Recordings are checked for size stability before processing.
- The original recording is never modified.

These bounds can be changed in `/etc/sokrat-voip/stt.env`:

```dotenv
STT_MAX_PENDING_JOBS=20
STT_MAX_ATTEMPTS=3
STT_LOCAL_TIMEOUT_MS=1800000
```

## Test-server benchmark

Benchmark date: 2026-10-17. Hardware: Intel Xeon E5-2640 v2 test host with two physical cores, four threads, and 7.5 GiB RAM. Build: AVX/F16C enabled, AVX2/FMA/BMI2 disabled. Original caller identities and filenames are intentionally omitted.

| Sample | PCM duration | Speech after VAD | Threads | Processing time | RTF | Result |
|---|---:|---:|---:|---:|---:|---|
| Completed call A | 31.88 s | 7.45 s | 1 | 182.41 s | 5.72 | Partial Arabic transcript; noisy/unclear speech produced substantial errors |
| Completed call A | 31.88 s | 7.45 s | 2 | 89.27 s | 2.80 | Same transcript; faster but consumes both physical cores |
| Completed call B | 43.12 s | 10.22 s | 1 | 79.56 s | 1.85 | Carrier announcement was intelligible and mostly correct |
| Voicemail | 5.00 s | none detected | 1 | 0.33 s | 0.07 | Correctly returned no speech |

Resident memory was approximately 275 MiB after model load and approximately 435 MiB while/after processing.

The end-to-end database queue test processed the no-speech voicemail in 2.9 seconds and the 41-second completed call in 85.4 seconds, recording the engine, model, processing time, completion state, and transcript in their respective tables.

The two-core PBX is intentionally configured for one thread despite the lower throughput. A four-core HP EliteDesk 800 G1-class deployment uses two threads. This is an asynchronous archival feature, not real-time captioning.

## Accuracy expectations

The multilingual `small-q5_1` model is a reliable deployment baseline, but Egyptian dialect accuracy depends strongly on call quality. Clear carrier announcements and clean telephone speech are useful; noisy or very short colloquial speech can contain significant errors. Evaluate an Egyptian-Arabic fine-tune only after collecting a consented, manually referenced test set and converting the model reproducibly.
