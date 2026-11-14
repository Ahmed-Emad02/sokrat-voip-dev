#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include "dongle_rx_condition.h"

static void quiet_to_loud(long elapsed_ms)
{
    short frame[160];
    size_t i;
    int repeat;

    for (repeat = 0; repeat < 100; repeat++) {
        for (i = 0; i < 160; i++) frame[i] = i % 2 ? -150 : 150;
        sokrat_condition_rx(frame, 160, elapsed_ms);
    }
    for (repeat = 0; repeat < 20; repeat++) {
        for (i = 0; i < 160; i++) frame[i] = i % 2 ? -12000 : 12000;
        sokrat_condition_rx(frame, 160, elapsed_ms);
        for (i = 0; i < 160; i++) {
            assert(frame[i] == (i % 2 ? -7916 : 7916));
        }
    }
}

int main(void)
{
    short frame[160];
    short reference[] = {-4999, -3000, -1, 0, 1, 3000, 4999};
    const long steady[] = {-1, 2100, 180000};
    const long startup[] = {0, 1000, 2080};
    size_t i, phase;
    int value;

    assert(SHRT_MIN == -32768 && SHRT_MAX == 32767);
    for (phase = 0; phase < sizeof(steady) / sizeof(steady[0]); phase++) {
        quiet_to_loud(steady[phase]);
        for (i = 0; i < sizeof(reference) / sizeof(reference[0]); i++) {
            short sample = reference[i];
            sokrat_condition_rx(&sample, 1, steady[phase]);
            assert(sample == reference[i]);
        }
        for (value = SHRT_MIN; value <= SHRT_MAX; value++) {
            short sample = (short)value;
            sokrat_condition_rx(&sample, 1, steady[phase]);
            assert(value == 0 ? sample == 0 : value < 0 ? sample < 0 : sample > 0);
            assert(sample <= (value < 0 ? -value : value));
            assert(sample >= -(value < 0 ? -value : value));
        }
    }
    for (phase = 0; phase < sizeof(startup) / sizeof(startup[0]); phase++) {
        for (i = 0; i < 160; i++) frame[i] = i % 2 ? -12000 : 12000;
        sokrat_condition_rx(frame, 160, startup[phase]);
        for (i = 0; i < 160; i++) assert(frame[i] == 0);
    }
    frame[0] = -3000; frame[1] = 3000;
    sokrat_condition_rx(frame, 2, 2090);
    assert(frame[0] == -1500 && frame[1] == 1500);
    frame[0] = -3000; frame[1] = 3000;
    sokrat_condition_rx(frame, 2, 2100);
    assert(frame[0] == -3000 && frame[1] == 3000);
    puts("receive conditioning: quiet/loud transitions, signed PCM, startup and fade passed");
    return 0;
}
