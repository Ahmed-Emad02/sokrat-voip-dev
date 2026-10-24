# Cloud AI Speech-to-Text (STT)

Sokrat VoIP transcribes completed call recordings and voicemails asynchronously using Cloud AI APIs (Munsit منصت for Egyptian Arabic AI, Groq Whisper-Large-V3, OpenAI Whisper-1, Deepgram Nova-2, or custom OpenAI-compatible endpoints).

Local CPU inference (`whisper.cpp`) and local model binaries have been completely decommissioned to eliminate high CPU/RAM overhead on the PBX host and rely strictly on high-accuracy cloud transcription APIs.

## Architecture

- Worker Service: `sokrat-stt.service` (`/opt/sokrat-voip/scripts/stt-worker.js`)
- Configuration: Managed via GUI (Settings -> Speech-to-Text Engine) and stored in `asterisk.stt_settings`
- Environment: `/etc/sokrat-voip/stt.env`
- Supported Cloud Providers:
  - **Munsit (منصت)**: Specialized Egyptian Arabic conversational speech-to-text.
  - **Groq**: Ultra-fast Whisper-Large-V3 inference.
  - **OpenAI**: Whisper-1 standard cloud transcription.
  - **Deepgram**: Nova-2 high-throughput engine.
  - **Custom**: Any OpenAI-compatible audio transcription endpoint.

## Configuration & Operation

STT is configured from the Sokrat VoIP web dashboard:
1. Navigate to **PBX Configuration -> Speech-to-Text (STT)** or open the STT modal from the sidebar.
2. Select your desired Cloud Provider (e.g. Munsit or Groq).
3. Input your API key.
4. Click **Test Engine** to verify endpoint connectivity and latency.
5. Save settings.

Service management:
```bash
systemctl status sokrat-stt.service
journalctl -u sokrat-stt.service -n 50 --no-pager
```
| Completed call B | 43.12 s | 10.22 s | 1 | 79.56 s | 1.85 | Carrier announcement was intelligible and mostly correct |
| Voicemail | 5.00 s | none detected | 1 | 0.33 s | 0.07 | Correctly returned no speech |

Resident memory was approximately 275 MiB after model load and approximately 435 MiB while/after processing.

The end-to-end database queue test processed the no-speech voicemail in 2.9 seconds and the 41-second completed call in 85.4 seconds, recording the engine, model, processing time, completion state, and transcript in their respective tables.

The two-core PBX is intentionally configured for one thread despite the lower throughput. A four-core HP EliteDesk 800 G1-class deployment uses two threads. This is an asynchronous archival feature, not real-time captioning.

## Accuracy expectations

The multilingual `small-q5_1` model is a reliable deployment baseline, but Egyptian dialect accuracy depends strongly on call quality. Clear carrier announcements and clean telephone speech are useful; noisy or very short colloquial speech can contain significant errors. Evaluate an Egyptian-Arabic fine-tune only after collecting a consented, manually referenced test set and converting the model reproducibly.
