'use strict';

const GAIN_MIN_DB = -24;
const GAIN_MAX_DB = 42;

/** Convert dB gain to the linear factor consumed by Asterisk VOLUME(). */
function dbToAsteriskVolume(db) {
    const num = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, parseFloat(db) || 0));
    if (num === 0) return 0;
    if (num > 0) return parseFloat(Math.pow(10, num / 20).toFixed(4));
    return -parseFloat(Math.pow(10, -num / 20).toFixed(4));
}

module.exports = { GAIN_MIN_DB, GAIN_MAX_DB, dbToAsteriskVolume };
