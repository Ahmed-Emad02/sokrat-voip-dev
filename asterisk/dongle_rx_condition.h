#ifndef SOKRAT_DONGLE_RX_CONDITION_H
#define SOKRAT_DONGLE_RX_CONDITION_H

#include <stddef.h>
#include <string.h>

/* elapsed_ms is -1 for outbound calls, otherwise time since inbound answer.
 * Only the bounded answer interval may mute PCM. A speech peak must never
 * silence a frame: a quiet background is not evidence that speech is noise.
 */
static inline void sokrat_condition_rx(short *samples, size_t count, long elapsed_ms)
{
    const int knee = 5000;
    const long startup_ms = 2100;
    size_t i;

    if (elapsed_ms >= 0 && elapsed_ms < startup_ms) {
        int gain_pct = (int)((elapsed_ms - (startup_ms - 20)) * 100 / 20);
        if (gain_pct <= 0) {
            memset(samples, 0, count * sizeof(*samples));
            return;
        }
        for (i = 0; i < count; i++)
            samples[i] = (short)(((int)samples[i] * gain_pct) / 100);
    }

    /* Preserve the existing soft-knee limiter and all sub-knee samples. */
    for (i = 0; i < count; i++) {
        int value = samples[i];
        int magnitude = value < 0 ? -value : value;
        if (magnitude > knee) {
            int limited = knee + ((magnitude - knee) * knee) / magnitude;
            samples[i] = (short)(value < 0 ? -limited : limited);
        }
    }
}

#endif
