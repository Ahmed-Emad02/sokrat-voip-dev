# ElevenLabs Scribe v3 Speech-to-Text

Sokrat VoIP transcribes completed call recordings and voicemails asynchronously with **ElevenLabs Scribe v3**. There is no local Whisper model or local inference runtime in the installer bundle.

## Architecture

- Worker: `sokrat-stt.service` (`/opt/sokrat-voip/scripts/stt-worker.js`)
- Settings: `asterisk.stt_settings`
- Environment: `/etc/sokrat-voip/stt.env`
- Provider: `elevenlabs`
- Model: `scribe_v3`
- Endpoint: `https://api.elevenlabs.io/v1/speech-to-text`
- Language: Arabic (`ar`)
- Authentication: `xi-api-key`

The worker requests word timestamps, speaker diarization, and digit-formatted numbers. Keyterms can be supplied as a comma-separated list.

## Configuration

1. Open **Configuration → Speech-to-Text** or **Call Quality → AI Providers**.
2. Keep the fixed provider **ElevenLabs Scribe v3**.
3. Paste the ElevenLabs API key.
4. Optionally add keyterms, such as names, products, or account terms.
5. Click **Test STT** to verify the key, then **Save**.

The saved API key is never returned to the browser. Leaving the key field blank keeps the existing key.

## Manual and automatic modes

**Voice Review** has a `Manual / Automatic` call-transcription switch.

- **Manual**: untranscribed calls show a `Transcribe` button. While the job runs, an animated progress bar appears in that row.
- **Automatic**: enabling the mode requires a saved API key, queues the current backlog, and runs a bounded scan every two minutes. Per-call buttons are hidden.

Automatic mode uses the existing queue cap (`STT_MAX_PENDING_JOBS`, default 20).

## Service management

```bash
systemctl status sokrat-stt.service
journalctl -u sokrat-stt.service -n 50 --no-pager
```

## Legacy local STT cleanup

`install.sh`, `installer-bundle/install-sokrat.sh`, and `scripts/safe-upgrade.sh` still remove the obsolete `sokrat-whisper.service`, `/opt/sokrat-stt`, and local model directories when upgrading an old installation. These are migration cleanup steps, not active local inference components.
