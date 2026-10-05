'use strict';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// Resolved after config is loaded to avoid circular dependency
function getLevel() {
    return LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
}

const SENSITIVE_KEYS = new Set(['password', 'access_token', 'form-content', 'token', 'newpassword', 'oldpassword', 'old_password', 'new_password', 'authorization', 'cookie', 'secret', 'value']);

// Matches key=value or key: value patterns with sensitive key names in strings (e.g. error messages)
const SENSITIVE_STRING_PATTERN = /\b(password|token|secret|session)[^\s]*\s*[:=]\s*\S+/gi;

function redactString(str) {
    return str.replace(SENSITIVE_STRING_PATTERN, match => {
        const eqIdx = match.search(/[:=]/);
        return match.slice(0, eqIdx + 1) + ' [REDACTED]';
    });
}

function redact(value, depth = 0) {
    if (depth > 5) return value;
    if (typeof value === 'string') {
        // Redact long base64-looking strings (e.g. session tokens passed as standalone values)
        if (value.length > 20 && /^[A-Za-z0-9+/=]+$/.test(value)) return '[BASE64_REDACTED]';
        // Redact key=value / key: value patterns in error messages and CLI output
        return redactString(value);
    }
    if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
        }
        return out;
    }
    return value;
}

function format(level, args) {
    const safe = args.map(a => {
        if (a instanceof Error) return redactString(`${a.name}: ${a.message}`);
        if (typeof a === 'object') return JSON.stringify(redact(a));
        if (typeof a === 'string') return redactString(a);
        return a;
    });
    return `[${level.toUpperCase()}] ${safe.join(' ')}`;
}

const logger = {
    debug(...args) { if (getLevel() <= LEVELS.debug) console.log(format('debug', args)); },
    info(...args)  { if (getLevel() <= LEVELS.info)  console.log(format('info',  args)); },
    warn(...args)  { if (getLevel() <= LEVELS.warn)  console.warn(format('warn',  args)); },
    error(...args) { if (getLevel() <= LEVELS.error) console.error(format('error', args)); },
};

module.exports = logger;
