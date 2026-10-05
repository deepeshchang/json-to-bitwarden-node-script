'use strict';

const config = require('../lib/config');
const logger = require('../lib/logger');
const bw = require('../lib/bitwarden');
const api = require('../lib/api');
const { withRetry, processBatches, readLines } = require('../lib/utils');

// ---------------------------------------------------------------------------
// Email variant generation
// ---------------------------------------------------------------------------
// Domains used to build email-address variants. Configure via EMAIL_DOMAINS
// (comma-separated); when empty, only username-style variants are generated.
const DOMAINS = config.EMAIL_DOMAINS;

// Examples below assume the name "John Smith" (j = first initial, s = last initial).
function generateEmails(firstName, lastName) {
    const f = firstName.toLowerCase();
    const l = lastName.toLowerCase();
    const fi  = f.charAt(0);           // j
    const li  = l.charAt(0);           // s
    const f2  = f.slice(0, 2);         // jo
    const l2  = l.slice(0, 2);         // sm

    const bases = [
        // ── first name only ──────────────────────────────────────
        f,                              // john

        // ── full first + full last ───────────────────────────────
        `${f}.${l}`,                    // john.smith
        `${f}${l}`,                     // johnsmith
        `${f}.${l}.${f}.${l}`,          // john.smith.john.smith

        // ── first + initial of last ──────────────────────────────
        `${f}${li}`,                    // johns
        `${f}.${li}`,                   // john.s

        // ── initial of first + full last ─────────────────────────
        `${fi}.${l}`,                   // j.smith
        `${fi}${l}`,                    // jsmith

        // ── both initials ────────────────────────────────────────
        `${fi}${li}`,                   // js
        `${fi}.${li}`,                  // j.s

        // ── initial of first + partial last ──────────────────────
        `${fi}${l2}`,                   // jsm  (j + sm)

        // ── partial first + initial of last ──────────────────────
        `${f2}${li}`,                   // jos  (jo + s)

        // ── partial first + partial last ─────────────────────────
        `${f2}${l2}`,                   // josm (jo + sm)

        // ── reversed: last + first ───────────────────────────────
        `${l}.${f}`,                    // smith.john
        `${l}${f}`,                     // smithjohn
        `${l}${fi}`,                    // smithj
        `${l}.${fi}`,                   // smith.j
    ];

    const result = [];
    for (const b of bases) {
        result.push(b);
        result.push(b.toUpperCase());
    }
    for (const b of bases) {
        for (const d of DOMAINS) {
            result.push(`${b}@${d}`);
            result.push(`${b.toUpperCase()}@${d.toUpperCase()}`);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Load search targets (format: "FirstName LastName", one per line)
// ---------------------------------------------------------------------------
const searchTerms = [];
try {
    const rawNames = readLines(config.SEARCH_NAMES_FILE);
    rawNames.forEach(trimmed => {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
            searchTerms.push(...generateEmails(parts[0], parts.slice(1).join(' ')));
        } else {
            const term = parts[0].toLowerCase();
            searchTerms.push(term);
            logger.warn(`"${trimmed}" is a single word — added as a direct match term (username/email/name). For full email-variant search, use "FirstName LastName".`);
        }
    });
    logger.info(`Loaded ${searchTerms.length} search terms from ${config.SEARCH_NAMES_FILE}`);
} catch (err) {
    logger.error(`Failed to load search names: ${err.message}`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const matchedUsers = [];
const stats = { total: 0, authenticated: 0, skipped: 0, authFailed: 0, fetchFailed: 0 };

async function processSingleItem(itemName, cache, fetch) {
    stats.total++;
    const item = bw.getCachedItem(cache, itemName);

    if (!item?.login?.uris?.length || !item.login.username || !item.login.password) {
        logger.warn(`Skipping "${itemName}" (missing credentials or URI)`);
        stats.skipped++;
        return;
    }

    const { username, password } = item.login;
    const uri = api.cleanDomain(item.login.uris[0].uri);

    let accessToken;
    try {
        accessToken = await withRetry(() => api.authenticate(fetch, uri, username, password));
        stats.authenticated++;
    } catch (err) {
        logger.error(`Auth failed for "${itemName}" (${uri}): ${err.message}`);
        stats.authFailed++;
        return;
    }

    let users;
    try {
        users = await withRetry(() => api.listUsers(fetch, uri, accessToken));
    } catch (err) {
        logger.error(`Failed to list users for "${itemName}" (${uri}): ${err.message}`);
        stats.fetchFailed++;
        return;
    }

    const found = users.filter(user =>
        searchTerms.some(term => {
            const t = term.toLowerCase();
            const exactMatch = val => val != null && val.toLowerCase() === t;
            // Split usernames on hyphens/underscores so "svc-admin" matches term "admin"
            const tokenMatch = val => val != null && val.toLowerCase().split(/[\s\-_]+/).some(w => w === t);
            // firstName / lastName: match against each whitespace-separated word
            const wordMatch = val => val != null && val.toLowerCase().split(/\s+/).some(w => w === t);
            return tokenMatch(user[config.USER_FIELD_USERNAME]) || exactMatch(user[config.USER_FIELD_EMAIL]) ||
                   wordMatch(user[config.USER_FIELD_FIRSTNAME]) || wordMatch(user[config.USER_FIELD_LASTNAME]);
        })
    );

    found.forEach(user =>
        matchedUsers.push({
            uri,
            firstName: user[config.USER_FIELD_FIRSTNAME],
            lastName:  user[config.USER_FIELD_LASTNAME],
            email:     user[config.USER_FIELD_EMAIL],
            username:  user[config.USER_FIELD_USERNAME],
        })
    );

    logger.info(`[${itemName}] ${users.length} users fetched — ${found.length} matched`);
}

(async () => {
    const fetch = globalThis.fetch;
    const sessionToken = await bw.getSessionToken();

    let cache;
    try {
        cache = bw.loadVaultCache(sessionToken);
    } catch (err) {
        logger.error(err.message);
        process.exit(1);
    }

    const itemNames = readLines(config.SEARCH_ADMINS_FILE);

    await processBatches(
        itemNames,
        config.BATCH_SIZE,
        config.BATCH_DELAY_MS,
        name => processSingleItem(name.trim(), cache, fetch)
    );

    logger.info('');
    logger.info('══════════════════════════════════════');
    logger.info('         USER SEARCH SUMMARY          ');
    logger.info('══════════════════════════════════════');
    logger.info(`  Instances checked  : ${stats.total}`);
    logger.info(`  ✅ Authenticated    : ${stats.authenticated}`);
    logger.info(`  ⚠️  Skipped          : ${stats.skipped}`);
    logger.info(`  ❌ Auth failed      : ${stats.authFailed}`);
    logger.info(`  ❌ User fetch failed: ${stats.fetchFailed}`);
    logger.info(`  🔍 Matched users    : ${matchedUsers.length}`);
    logger.info('══════════════════════════════════════');

    if (matchedUsers.length > 0) {
        logger.info('');
        logger.info('MATCHED USERS:');
        matchedUsers.forEach(u =>
            logger.info(`  [${u.uri}]  ${u.firstName} ${u.lastName} | ${u.email} | ${u.username}`)
        );
    }
})().catch(err => {
    logger.error('Critical error:', err.message);
    process.exit(1);
});
