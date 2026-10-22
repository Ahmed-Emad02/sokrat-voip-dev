/**
 * Issabel feature-code hand-off.
 *
 * The Sokrat "Solution D" call-pickup feature codes (*<number>) are declared
 * in [from-internal-custom] as PATTERNS (_*X., _*1X., _*8X.) so that any
 * extension or ring group can be picked up with *<number>.
 *
 * Issabel's own feature codes (*97 my voicemail, *72 call forward, *78 DND,
 * *87 conference status, *99 check recording, ...) have exactly the same
 * shape, and Asterisk resolves an extension by looking for a literal match
 * first - but a literal that arrives through an `include` is DROPPED once the
 * target context already holds a matching pattern.  The Sokrat patterns are
 * declared first (from-internal-custom is included before
 * from-internal-additional), so every Issabel feature code was silently
 * swallowed by the Sokrat directed-pickup rule: dialling *97 picked up a call
 * instead of reaching the voice mail menu.
 *
 * Fix: declare every Issabel feature code as a LITERAL inside
 * [from-internal-custom].  Literals always win over patterns in the same
 * context, and the literal hands the code back to Issabel's own dialplan
 * (from-internal-additional), where the matching Issabel context lives.
 * Everything that is not an Issabel feature code keeps hitting the Sokrat
 * pickup patterns, so the pickup feature is unchanged.
 *
 * The same problem hits the Issabel codes that take an ARGUMENT (e.g.
 * "*98<mailbox>" = the voicemail of another extension, "*72<ext>" = call
 * forward on): they are patterns too, so the Sokrat _*X. pattern swallowed
 * them as well.  They are declared here as well - a more specific pattern
 * wins over _*X. in the same context.  To keep the Sokrat pickup intact,
 * the number after the code is looked up in the DEVICE table first: when it
 * is a registered extension the call still picks that extension up, and
 * otherwise it is handed to Issabel.
 *
 * The codes are read from Issabel's own `featurecodes` table, so the list
 * follows the installed Issabel version automatically.
 */

const fs = require('fs');
const path = require('path');

const CONTEXT_NAME = 'from-internal-custom';
const BEGIN_MARK = '; === SOKRAT: Issabel feature-code hand-off (generated, do not edit) ===';
const END_MARK = '; === END SOKRAT: Issabel feature-code hand-off ===';
const DEFAULT_FILE = '/etc/asterisk/extensions_custom.conf';

/**
 * Feature codes the Sokrat "Solution D" block owns on purpose: they are the
 * documented backward-compatible aliases of the general group call pickup
 * (*, *1, *8).  They are deliberately NOT handed back to Issabel.
 */
const SOKRAT_OWNED_CODES = ['*', '*1', '*8'];

/**
 * Issabel's own dialplan: it holds the "feature code + argument" forms
 * (e.g. _*98. -> the voicemail of another extension).
 */
const DEFAULT_ISSUABEL_FILE = '/etc/asterisk/extensions_additional.conf';

/**
 * The Sokrat pickup aliases match every "*1<digit>..." and "*8<digit>..."
 * string, so an Issabel argument form whose code starts with 1 or 8 would
 * collide with them. Those codes are left alone: the pickup alias wins.
 */
const SOKRAT_PICKUP_ALIAS_PREFIXES = ['1', '8'];

const FEATURE_CODES_SQL = `
    SELECT DISTINCT code FROM (
        SELECT defaultcode AS code FROM \`asterisk\`.\`featurecodes\` WHERE enabled = 1
        UNION ALL
        SELECT customcode AS code FROM \`asterisk\`.\`featurecodes\`
            WHERE enabled = 1 AND customcode IS NOT NULL
    ) t
    WHERE code LIKE '*%'
      AND CHAR_LENGTH(code) > 1
      AND code NOT IN (${SOKRAT_OWNED_CODES.map(c => `'${c}'`).join(', ')})
    ORDER BY code`;

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read the enabled Issabel feature codes that collide with the Sokrat
 * directed-pickup patterns.
 */
async function fetchIssabelFeatureCodes(pool) {
    const [rows] = await pool.query(FEATURE_CODES_SQL);
    const codes = [];
    for (const row of rows || []) {
        const code = String(row.code || '').trim();
        if (!code || !code.startsWith('*')) continue;
        if (code.length < 2) continue;
        if (SOKRAT_OWNED_CODES.includes(code)) continue;
        if (codes.includes(code)) continue;
        codes.push(code);
    }
    return codes.sort((a, b) => (a.length - b.length) || a.localeCompare(b));
}

/**
 * Pick Issabel's "feature code + argument" forms (e.g. _*98. -> the voicemail
 * of another extension) out of Issabel's own dialplan.
 *
 * They need the same treatment as the plain feature codes: the Sokrat
 * directed-pickup pattern (_*X.) matches every "*<digits>" string, so
 * "*98<mailbox>" was picked up as a ring group instead of dialling the
 * mailbox. Declared here as a pattern, the more specific _*98. wins over
 * _*X. in the same context.
 *
 * Only codes that Issabel itself has enabled are taken, and the ones that
 * would collide with the Sokrat pickup aliases (*1 / *8) are skipped.
 */
function selectArgumentCodes(dialplanContent, featureCodes) {
    if (!dialplanContent) return [];
    const enabled = [];
    for (const code of featureCodes || []) {
        const digits = String(code || '').replace(/^\*/, '');
        if (!/^[0-9]+$/.test(digits)) continue;
        if (SOKRAT_OWNED_CODES.some(owned => owned.replace(/^\*/, '') === digits)) continue;
        enabled.push(digits);
    }
    const found = new Set();
    const re = /^\s*exten\s*=>\s*_\*([0-9]+)\.\s*,/gm;
    let match;
    while ((match = re.exec(dialplanContent)) !== null) {
        const digits = match[1];
        if (found.has(digits)) continue;
        if (SOKRAT_PICKUP_ALIAS_PREFIXES.some(prefix => digits.startsWith(prefix))) continue;
        const isIssabelCode = enabled.some(code =>
            digits === code || (code.length >= 2 && digits.startsWith(code)));
        if (!isIssabelCode) continue;
        found.add(digits);
    }
    return [...found].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/**
 * Build the dialplan block that hands the codes back to Issabel.
 */
function buildFeatureCodeBlock(codes, argumentCodes = []) {
    const lines = [];
    lines.push(BEGIN_MARK);
    lines.push("; Issabel's own feature codes (*97 voicemail, *72 call forward, *78 DND, ...)");
    lines.push('; share the *<code> shape with the directed-pickup patterns below. Asterisk');
    lines.push('; drops a literal that arrives through an include once the context holds a');
    lines.push('; matching pattern, so each code is declared here as a literal - a literal');
    lines.push('; always wins over a pattern in the same context - and handed to Issabel.');
    for (const code of codes) {
        lines.push(`exten => ${code},1,Goto(from-internal-additional,\${EXTEN},1)`);
    }
    if (argumentCodes.length) {
        lines.push('');
        lines.push('; --- Issabel feature codes that take an argument (e.g. *98<mailbox>) ---');
        lines.push('; The directed-pickup pattern _*X. below matches every *<digits> string, so');
        lines.push('; these forms never reached Issabel. They are declared here as patterns: a');
        lines.push('; more specific pattern wins over _*X. in the same context. When the number');
        lines.push('; after the code is a registered extension the call keeps its Sokrat meaning');
        lines.push('; (directed pickup); otherwise it is handed to Issabel.');
        for (const digits of argumentCodes) {
            lines.push(`exten => _*${digits}.,1,NoOp(--- Issabel feature code *${digits}<arg> (target \${EXTEN:${digits.length + 1}}) ---)`);
            lines.push('same => n,GotoIf($["${DB(DEVICE/${EXTEN:1}/dial)}" != ""]?sokrat-pickup-target,1)');
            lines.push('same => n,Goto(from-internal-additional,${EXTEN},1)');
        }
        lines.push('');
        lines.push('; Directed pickup fallback for the codes above, used when the number after');
        lines.push('; the code is a registered extension (same behaviour as the _*X. pickup).');
        lines.push('exten => sokrat-pickup-target,1,NoOp(--- Directed / Ring Group Pickup for Target ${EXTEN:1} by ${CALLERID(num)} ---)');
        lines.push('same => n,PickupChan(PJSIP/${EXTEN:1}&SIP/${EXTEN:1}&Local/${EXTEN:1}@ext-local,p)');
        lines.push('same => n,Pickup(${EXTEN:1}@ext-local&${EXTEN:1}@from-internal&${EXTEN:1}@from-did-direct&${EXTEN:1}@ext-group)');
        lines.push('same => n,Hangup()');
    }
    lines.push(END_MARK);
    return lines.join('\n') + '\n';
}

/**
 * Insert / refresh the generated block inside [from-internal-custom].
 * Idempotent: re-running it with the same codes leaves the file untouched.
 */
function patchExtensionsCustomConf(filePath, codes, argumentCodes = []) {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        return { changed: false, count: codes.length, argumentCount: argumentCodes.length, error: err.message };
    }

    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const block = buildFeatureCodeBlock(codes, argumentCodes).replace(/\n/g, eol);

    // Drop a previously generated block (if any).
    const beginRe = new RegExp(escapeRegExp(BEGIN_MARK) + '[\\s\\S]*?' + escapeRegExp(END_MARK) + '\\r?\\n?');
    const stripped = content.replace(beginRe, '');

    const header = `[${CONTEXT_NAME}]`;
    let next;
    if (stripped.includes(header + eol)) {
        next = stripped.replace(header + eol, header + eol + block);
    } else if (stripped.includes(header)) {
        next = stripped.replace(header, header + eol + block);
    } else {
        // The context does not exist yet (fresh install before the dialplan was
        // written): create it so the codes are still reachable.
        next = stripped.replace(/\s*$/, '') + eol + eol + header + eol + block;
    }

    if (next === content) {
        return { changed: false, count: codes.length, argumentCount: argumentCodes.length };
    }
    try {
        fs.writeFileSync(filePath, next, 'utf8');
    } catch (err) {
        return { changed: false, count: codes.length, argumentCount: argumentCodes.length, error: err.message };
    }
    return { changed: true, count: codes.length, argumentCount: argumentCodes.length };
}

/**
 * Full sync: read the codes from Issabel and refresh the dialplan.
 */
async function syncFeatureCodeHandOff(pool, options = {}) {
    const filePath = options.filePath || DEFAULT_FILE;
    const issabelFile = options.issabelDialplanFile || DEFAULT_ISSUABEL_FILE;
    const codes = await fetchIssabelFeatureCodes(pool);
    let argumentCodes = [];
    try {
        const dialplan = fs.readFileSync(issabelFile, 'utf8');
        argumentCodes = selectArgumentCodes(dialplan, codes);
    } catch (err) {
        // Issabel's dialplan is not there yet (fresh install): the argument
        // forms are picked up by the next sync.
        argumentCodes = [];
    }
    const result = patchExtensionsCustomConf(filePath, codes, argumentCodes);
    return { codes, argumentCodes, filePath, ...result };
}

module.exports = {
    CONTEXT_NAME,
    BEGIN_MARK,
    END_MARK,
    SOKRAT_OWNED_CODES,
    SOKRAT_PICKUP_ALIAS_PREFIXES,
    FEATURE_CODES_SQL,
    DEFAULT_FILE,
    DEFAULT_ISSUABEL_FILE,
    fetchIssabelFeatureCodes,
    selectArgumentCodes,
    buildFeatureCodeBlock,
    patchExtensionsCustomConf,
    syncFeatureCodeHandOff,
};

// CLI: node lib/feature-code-hand-off.js
if (require.main === module) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        database: process.env.CDR_DB || 'asteriskcdrdb',
        waitForConnections: true,
        connectionLimit: 2
    });
    syncFeatureCodeHandOff(pool)
        .then((res) => {
            console.log(
                `feature-code hand-off: ${res.codes.length} Issabel codes, ` +
                `${res.argumentCodes.length} argument codes, ` +
                `${res.changed ? 'dialplan updated' : 'dialplan already up to date'} (${res.filePath})`
            );
            if (res.error) {
                console.error('feature-code hand-off error:', res.error);
                process.exitCode = 1;
            }
        })
        .catch((err) => {
            console.error('feature-code hand-off error:', err.message);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}
