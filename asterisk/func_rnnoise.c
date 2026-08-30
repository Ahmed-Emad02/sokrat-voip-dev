/*
 * Asterisk -- An open source telephony toolkit.
 *
 * RNNoise Deep Learning Noise Suppression & VAD Noise Gate Function for Asterisk
 *
 * Copyright (C) 2026, Sokrat VoIP
 *
 * Licensed under the GNU General Public License Version 2.
 */

/*! \file
 * \brief RNNoise Deep Learning Noise Reduction with Attack-Hold-Release VAD Noise Gate
 *
 * \author Sokrat VoIP Team
 * \ingroup functions
 */

#define AST_MODULE "func_rnnoise"
#define AST_MODULE_SELF_SYM __internal_func_rnnoise_self

#include "asterisk.h"

#include <rnnoise.h>
#include <math.h>

#include "asterisk/module.h"
#include "asterisk/channel.h"
#include "asterisk/pbx.h"
#include "asterisk/utils.h"
#include "asterisk/audiohook.h"
#include "asterisk/app.h"
#include "asterisk/datastore.h"
#include "asterisk/format_cache.h"

#define RNNOISE_FRAME_SIZE 480 /* 10ms @ 48kHz */

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

struct rnnoise_vad_state {
	int gate_enabled;        /*!< 1 = VAD gate active (100% silence during pauses), 0 = pure RNNoise */
	float threshold;         /*!< Speech detection probability threshold (default 0.20) */
	float min_dbfs;          /*!< Minimum frame RMS energy threshold in dBFS (default -90.0 dBFS) */
	int hangover_frames;     /*!< Hold frames after speech ends (default 25 = 250ms) */
	int hangover_count;      /*!< Active hangover countdown */
	int release_frames;      /*!< Cosine release fade-out frame duration (default 6 = 60ms) */
	int release_count;       /*!< Current release step */
	float current_gain;      /*!< Current envelope gain multiplier [0.0 to 1.0] */
};

struct rnnoise_direction_state {
	DenoiseState *st;
	float in_buf[RNNOISE_FRAME_SIZE];
	float out_buf[RNNOISE_FRAME_SIZE];
	int enabled;
	struct rnnoise_vad_state vad;
};

struct rnnoise_information {
	struct ast_audiohook audiohook;
	struct rnnoise_direction_state rx;
	struct rnnoise_direction_state tx;
	ast_mutex_t lock;
};

static void init_vad_defaults(struct rnnoise_vad_state *vad)
{
	vad->gate_enabled = 1;
	vad->threshold = 0.20f;
	vad->min_dbfs = -90.0f;
	vad->hangover_frames = 25; /* 250ms at 10ms/frame */
	vad->hangover_count = 0;
	vad->release_frames = 6;   /* 60ms at 10ms/frame */
	vad->release_count = 0;
	vad->current_gain = 0.0f;  /* Starts closed until speech is detected */
}

static void destroy_rnnoise_direction(struct rnnoise_direction_state *dir)
{
	if (dir->st) {
		rnnoise_destroy(dir->st);
		dir->st = NULL;
	}
	dir->enabled = 0;
	init_vad_defaults(&dir->vad);
}

static void destroy_rnnoise_information(struct rnnoise_information *info)
{
	ast_mutex_lock(&info->lock);
	destroy_rnnoise_direction(&info->rx);
	destroy_rnnoise_direction(&info->tx);
	ast_mutex_unlock(&info->lock);
	ast_mutex_destroy(&info->lock);
	ast_free(info);
}

static void datastore_destroy_cb(void *data)
{
	struct rnnoise_information *info = data;
	if (!info) {
		return;
	}
	ast_audiohook_destroy(&info->audiohook);
	destroy_rnnoise_information(info);
}

static const struct ast_datastore_info rnnoise_datastore = {
	.type = "rnnoise",
	.destroy = datastore_destroy_cb,
};

/*! \brief Calculate RMS energy of PCM frame in dBFS */
static float calculate_frame_dbfs(const short *pcm, int samples)
{
	if (!pcm || samples <= 0) {
		return -96.0f;
	}
	double sum_sq = 0.0;
	for (int i = 0; i < samples; i++) {
		double s = (double)pcm[i];
		sum_sq += (s * s);
	}
	double rms = sqrt(sum_sq / (double)samples);
	if (rms < 1.0) {
		return -96.0f; /* Digital floor */
	}
	return (float)(20.0 * log10(rms / 32767.0));
}

/*! \brief Apply Attack-Hold-Release VAD Noise Gate Envelope to PCM samples with dBFS energy cutoff */
static void apply_vad_envelope(struct rnnoise_vad_state *vad, short *pcm, int samples, float vad_prob)
{
	if (!vad->gate_enabled) {
		return;
	}

	float frame_dbfs = calculate_frame_dbfs(pcm, samples);

	if (vad_prob >= vad->threshold && frame_dbfs >= vad->min_dbfs) {
		/* Speech active and above decibel cutoff: Instant attack (100% gain) */
		vad->hangover_count = vad->hangover_frames;
		vad->release_count = 0;
		vad->current_gain = 1.0f;
	} else if (vad->hangover_count > 0) {
		/* Hangover hold: Preserve word endings and inter-syllable pauses */
		vad->hangover_count--;
		vad->current_gain = 1.0f;
	} else if (vad->release_count < vad->release_frames) {
		/* Release fade: Smooth raised-cosine decay curve prevents clicks */
		vad->release_count++;
		float progress = (float)vad->release_count / (float)vad->release_frames;
		vad->current_gain = 0.5f * (1.0f + cosf((float)M_PI * progress));
	} else {
		/* Fully closed: Complete digital silence (-inf dBFS) */
		vad->current_gain = 0.0f;
	}

	if (vad->current_gain <= 0.0001f) {
		memset(pcm, 0, samples * sizeof(short));
	} else if (vad->current_gain < 0.9999f) {
		for (int i = 0; i < samples; i++) {
			pcm[i] = (short)((float)pcm[i] * vad->current_gain);
		}
	}
}

/*! \brief Process a single chunk of PCM samples through RNNoise + VAD Gate */
static void process_rnnoise_chunk(struct rnnoise_direction_state *dir, short *pcm, int samples, int rate)
{
	DenoiseState *st = dir->st;
	float *in_buf = dir->in_buf;
	float *out_buf = dir->out_buf;
	float vad_prob = 0.0f;

	if (!st || !pcm || samples <= 0) {
		return;
	}

	if (rate == 48000 && samples == RNNOISE_FRAME_SIZE) {
		/* Native 48kHz 10ms frame: Direct 1:1 float pass */
		for (int i = 0; i < RNNOISE_FRAME_SIZE; i++) {
			in_buf[i] = (float)pcm[i];
		}
		vad_prob = rnnoise_process_frame(st, out_buf, in_buf);
		for (int i = 0; i < RNNOISE_FRAME_SIZE; i++) {
			float s = out_buf[i];
			if (s > 32767.0f) s = 32767.0f;
			else if (s < -32768.0f) s = -32768.0f;
			pcm[i] = (short)s;
		}
	} else if (rate == 8000 && samples == 80) {
		/* 8kHz 10ms frame (80 samples) -> 6x linear interpolation -> RNNoise -> 6x decimation */
		for (int i = 0; i < 80; i++) {
			float curr = (float)pcm[i];
			float next = (i < 79) ? (float)pcm[i + 1] : curr;
			float step = (next - curr) / 6.0f;
			for (int j = 0; j < 6; j++) {
				in_buf[i * 6 + j] = curr + (step * (float)j);
			}
		}
		vad_prob = rnnoise_process_frame(st, out_buf, in_buf);
		for (int i = 0; i < 80; i++) {
			float sum = 0.0f;
			for (int j = 0; j < 6; j++) {
				sum += out_buf[i * 6 + j];
			}
			float avg = sum / 6.0f;
			if (avg > 32767.0f) avg = 32767.0f;
			else if (avg < -32768.0f) avg = -32768.0f;
			pcm[i] = (short)avg;
		}
	} else if (rate == 16000 && samples == 160) {
		/* 16kHz 10ms frame (160 samples) -> 3x linear interpolation -> RNNoise -> 3x decimation */
		for (int i = 0; i < 160; i++) {
			float curr = (float)pcm[i];
			float next = (i < 159) ? (float)pcm[i + 1] : curr;
			float step = (next - curr) / 3.0f;
			for (int j = 0; j < 3; j++) {
				in_buf[i * 3 + j] = curr + (step * (float)j);
			}
		}
		vad_prob = rnnoise_process_frame(st, out_buf, in_buf);
		for (int i = 0; i < 160; i++) {
			float avg = (out_buf[i * 3] + out_buf[i * 3 + 1] + out_buf[i * 3 + 2]) / 3.0f;
			if (avg > 32767.0f) avg = 32767.0f;
			else if (avg < -32768.0f) avg = -32768.0f;
			pcm[i] = (short)avg;
		}
	} else if (rate == 32000 && samples == 320) {
		/* 32kHz 10ms frame (320 samples) -> 3/2 interpolation -> RNNoise -> 2/3 decimation */
		for (int i = 0; i < 160; i++) {
			float s0 = (float)pcm[i * 2];
			float s1 = (float)pcm[i * 2 + 1];
			in_buf[i * 3] = s0;
			in_buf[i * 3 + 1] = 0.5f * (s0 + s1);
			in_buf[i * 3 + 2] = s1;
		}
		vad_prob = rnnoise_process_frame(st, out_buf, in_buf);
		for (int i = 0; i < 160; i++) {
			float s0 = out_buf[i * 3];
			float s1 = out_buf[i * 3 + 2];
			if (s0 > 32767.0f) s0 = 32767.0f; else if (s0 < -32768.0f) s0 = -32768.0f;
			if (s1 > 32767.0f) s1 = 32767.0f; else if (s1 < -32768.0f) s1 = -32768.0f;
			pcm[i * 2] = (short)s0;
			pcm[i * 2 + 1] = (short)s1;
		}
	} else {
		/* Generic arbitrary rate/sample chunk fallback */
		double ratio = 48000.0 / (double)rate;
		for (int i = 0; i < RNNOISE_FRAME_SIZE; i++) {
			double src_pos = (double)i / ratio;
			int src_idx = (int)src_pos;
			if (src_idx >= samples - 1) {
				in_buf[i] = (src_idx < samples) ? (float)pcm[src_idx] : 0.0f;
			} else {
				double frac = src_pos - (double)src_idx;
				in_buf[i] = (float)((1.0 - frac) * pcm[src_idx] + frac * pcm[src_idx + 1]);
			}
		}
		vad_prob = rnnoise_process_frame(st, out_buf, in_buf);
		for (int i = 0; i < samples; i++) {
			double dst_pos = (double)i * ratio;
			int dst_idx = (int)dst_pos;
			float val;
			if (dst_idx >= RNNOISE_FRAME_SIZE - 1) {
				val = (dst_idx < RNNOISE_FRAME_SIZE) ? out_buf[dst_idx] : 0.0f;
			} else {
				float frac = (float)(dst_pos - (double)dst_idx);
				val = (1.0f - frac) * out_buf[dst_idx] + frac * out_buf[dst_idx + 1];
			}
			if (val > 32767.0f) val = 32767.0f;
			else if (val < -32768.0f) val = -32768.0f;
			pcm[i] = (short)val;
		}
	}

	/* Apply VAD Noise Gating */
	apply_vad_envelope(&dir->vad, pcm, samples, vad_prob);
}

/*! \brief Asterisk Audiohook Callback for frame manipulation */
static int rnnoise_callback(struct ast_audiohook *audiohook, struct ast_channel *chan, struct ast_frame *frame, enum ast_audiohook_direction direction)
{
	struct rnnoise_information *info = (struct rnnoise_information *)audiohook;
	struct rnnoise_direction_state *dir_state = NULL;

	if (!info || audiohook->status == AST_AUDIOHOOK_STATUS_SHUTDOWN || !frame || frame->frametype != AST_FRAME_VOICE || frame->samples <= 0) {
		return 0;
	}

	ast_mutex_lock(&info->lock);

	if (direction == AST_AUDIOHOOK_DIRECTION_READ) {
		dir_state = &info->rx;
	} else {
		dir_state = &info->tx;
	}

	if (!dir_state->enabled || !dir_state->st) {
		ast_mutex_unlock(&info->lock);
		return 0;
	}

	int rate = ast_format_get_sample_rate(frame->subclass.format);
	if (rate <= 0) {
		rate = 8000;
	}

	int chunk_size = rate / 100; /* 10ms worth of samples */
	if (chunk_size <= 0) {
		chunk_size = 80;
	}

	short *samples = (short *)frame->data.ptr;
	int total_samples = frame->samples;

	/* Process frame in 10ms slices */
	for (int offset = 0; offset + chunk_size <= total_samples; offset += chunk_size) {
		process_rnnoise_chunk(dir_state, samples + offset, chunk_size, rate);
	}

	ast_mutex_unlock(&info->lock);
	return 0;
}

/*! \brief Parse options like gate=on,gate=off,threshold=0.20,hangover=250,mindb=-45 */
static void parse_rnnoise_options(struct rnnoise_vad_state *vad, const char *opts)
{
	char *buf, *opt, *val;
	if (ast_strlen_zero(opts)) {
		return;
	}
	buf = ast_strdupa(opts);
	while ((opt = strsep(&buf, ","))) {
		if ((val = strchr(opt, '='))) {
			*val++ = '\0';
			opt = ast_strip(opt);
			val = ast_strip(val);
			if (!strcasecmp(opt, "gate")) {
				vad->gate_enabled = ast_true(val);
			} else if (!strcasecmp(opt, "threshold")) {
				float t = atof(val);
				if (t > 0.0f && t < 1.0f) vad->threshold = t;
			} else if (!strcasecmp(opt, "hangover")) {
				int ms = atoi(val);
				if (ms > 0) vad->hangover_frames = ms / 10;
			} else if (!strcasecmp(opt, "db") || !strcasecmp(opt, "mindb") || !strcasecmp(opt, "db_threshold") || !strcasecmp(opt, "dbfs")) {
				if (!strcasecmp(val, "off") || !strcasecmp(val, "auto") || !strcasecmp(val, "0")) {
					vad->min_dbfs = -90.0f;
				} else {
					float db = atof(val);
					if (db > 0.0f && db <= 90.0f) db = -db;
					if (db >= -90.0f && db <= 0.0f) vad->min_dbfs = db;
				}
			}
		} else {
			opt = ast_strip(opt);
			if (!strcasecmp(opt, "gate") || !strcasecmp(opt, "vad")) {
				vad->gate_enabled = 1;
			} else if (!strcasecmp(opt, "nogate") || !strcasecmp(opt, "novad") || !strcasecmp(opt, "gate=off") || !strcasecmp(opt, "gate=0")) {
				vad->gate_enabled = 0;
			}
		}
	}
}

/*! \brief Dialplan Read Function: ${RNNOISE(rx)} or ${RNNOISE(tx)} */
static int rnnoise_read(struct ast_channel *chan, const char *cmd, char *data, char *buf, size_t len)
{
	struct ast_datastore *datastore = NULL;
	struct rnnoise_information *info = NULL;
	int enabled = 0;

	if (!chan) {
		ast_log(LOG_WARNING, "RNNOISE function called without channel\n");
		return -1;
	}

	ast_channel_lock(chan);
	datastore = ast_channel_datastore_find(chan, &rnnoise_datastore, NULL);
	ast_channel_unlock(chan);

	if (datastore && datastore->data) {
		info = datastore->data;
		ast_mutex_lock(&info->lock);
		if (!strcasecmp(data, "rx")) {
			enabled = info->rx.enabled;
		} else if (!strcasecmp(data, "tx")) {
			enabled = info->tx.enabled;
		} else if (!strcasecmp(data, "both")) {
			enabled = info->rx.enabled && info->tx.enabled;
		}
		ast_mutex_unlock(&info->lock);
	}

	snprintf(buf, len, "%s", enabled ? "on" : "off");
	return 0;
}

/*! \brief Dialplan Write Function: Set(RNNOISE(rx[,options])=on) */
static int rnnoise_write(struct ast_channel *chan, const char *cmd, char *data, const char *value)
{
	struct ast_datastore *datastore = NULL;
	struct rnnoise_information *info = NULL;
	int turn_on = ast_true(value);
	int is_rx = 0, is_tx = 0;
	char *dir_name = NULL;
	char *opts = NULL;

	if (!chan) {
		ast_log(LOG_WARNING, "RNNOISE function called without channel\n");
		return -1;
	}

	if (data) {
		dir_name = strsep(&data, ",");
		opts = data;
	}

	if (!dir_name || ast_strlen_zero(dir_name) || !strcasecmp(dir_name, "both")) {
		is_rx = 1;
		is_tx = 1;
	} else if (!strcasecmp(dir_name, "rx")) {
		is_rx = 1;
	} else if (!strcasecmp(dir_name, "tx")) {
		is_tx = 1;
	} else {
		ast_log(LOG_ERROR, "Unknown direction '%s' for RNNOISE function. Use 'rx', 'tx', or 'both'\n", dir_name);
		return -1;
	}

	ast_channel_lock(chan);
	datastore = ast_channel_datastore_find(chan, &rnnoise_datastore, NULL);

	if (!datastore) {
		if (!turn_on) {
			ast_channel_unlock(chan);
			return 0;
		}

		if (!(info = ast_calloc(1, sizeof(*info)))) {
			ast_channel_unlock(chan);
			return -1;
		}

		ast_mutex_init(&info->lock);
		init_vad_defaults(&info->rx.vad);
		init_vad_defaults(&info->tx.vad);

		ast_audiohook_init(&info->audiohook, AST_AUDIOHOOK_TYPE_MANIPULATE, "RNNOISE", AST_AUDIOHOOK_MANIPULATE_ALL_RATES);
		info->audiohook.manipulate_callback = rnnoise_callback;

		if (!(datastore = ast_datastore_alloc(&rnnoise_datastore, NULL))) {
			ast_audiohook_destroy(&info->audiohook);
			destroy_rnnoise_information(info);
			ast_channel_unlock(chan);
			return -1;
		}

		datastore->data = info;
		ast_channel_datastore_add(chan, datastore);
		ast_audiohook_attach(chan, &info->audiohook);
	} else {
		info = datastore->data;
	}

	ast_mutex_lock(&info->lock);

	if (is_rx) {
		if (turn_on && !info->rx.st) {
			info->rx.st = rnnoise_create(NULL);
		} else if (!turn_on && info->rx.st) {
			destroy_rnnoise_direction(&info->rx);
		}
		info->rx.enabled = turn_on && (info->rx.st != NULL);
		if (opts) {
			parse_rnnoise_options(&info->rx.vad, opts);
		}
	}

	if (is_tx) {
		if (turn_on && !info->tx.st) {
			info->tx.st = rnnoise_create(NULL);
		} else if (!turn_on && info->tx.st) {
			destroy_rnnoise_direction(&info->tx);
		}
		info->tx.enabled = turn_on && (info->tx.st != NULL);
		if (opts) {
			parse_rnnoise_options(&info->tx.vad, opts);
		}
	}

	ast_mutex_unlock(&info->lock);
	ast_channel_unlock(chan);

	ast_verb(2, "[AI-NOISE-VAD] Channel %s: RNNoise %s (rx=%s[gate=%s,mindb=%.1fdB], tx=%s[gate=%s,mindb=%.1fdB])\n",
		ast_channel_name(chan),
		(info->rx.enabled || info->tx.enabled) ? "enabled" : "disabled",
		info->rx.enabled ? "on" : "off",
		info->rx.vad.gate_enabled ? "on" : "off",
		info->rx.vad.min_dbfs,
		info->tx.enabled ? "on" : "off",
		info->tx.vad.gate_enabled ? "on" : "off",
		info->tx.vad.min_dbfs);
	return 0;
}

static struct ast_custom_function rnnoise_function = {
	.name = "RNNOISE",
	.synopsis = "Apply deep learning real-time noise suppression & VAD gate to a channel",
	.syntax = "RNNOISE(direction[,options])",
	.desc = "Apply deep learning neural network noise reduction with VAD Noise Gate and dBFS energy cutoff to audio on the channel.\n"
	        "Valid directions: 'rx', 'tx', or 'both'.\n"
	        "Options: gate=on|off, threshold=0.20, hangover=250, mindb=-45\n"
	        "Values: 'on' or 'off'.\n\n"
	        "Examples:\n"
	        "  Set(RNNOISE(rx)=on)\n"
	        "  Set(RNNOISE(both,gate=on)=on)\n"
	        "  Set(RNNOISE(both,gate=off)=on)\n"
	        "  Set(RNNOISE(rx,threshold=0.25,hangover=300,mindb=-42)=on)\n",
	.write = rnnoise_write,
};

static int unload_module(void)
{
	return ast_custom_function_unregister(&rnnoise_function);
}

static int load_module(void)
{
	return ast_custom_function_register(&rnnoise_function);
}

AST_MODULE_INFO_STANDARD(ASTERISK_GPL_KEY, "RNNoise Deep Learning Noise Reduction with VAD Gate");
