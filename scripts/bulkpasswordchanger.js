'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const logger = require('../lib/logger');
const bw = require('../lib/bitwarden');
const api = require('../lib/api');
const { withRetry, processBatches, readLines, generatePassword } = require('../lib/utils');

// ---------------------------------------------------------------------------
// Single item processing
// ---------------------------------------------------------------------------
const stats = { total: 0, changed: 0, authOk: 0, skipped: 0, authFailed: 0, changeFailed: 0, bwFailed: 0 };

const VAULT_WRITE_ATTEMPTS = 3;

/**
 * Writes the new password back to Bitwarden, retrying a few times. If every attempt
 * fails, the instance already has the new password — so persist it to a 0600 recovery
 * file rather than losing it. Returns true if the vault was updated.
 */
function saveToVault(sessionToken, item, itemName, uri, newPassword) {
    let lastError;
    for (let attempt = 1; attempt <= VAULT_WRITE_ATTEMPTS; attempt++) {
        try {
            bw.updateItemPassword(sessionToken, item, newPassword);
            return true;
        } catch (err) {
            lastError = err;
            logger.warn(`Bitwarden write attempt ${attempt}/${VAULT_WRITE_ATTEMPTS} failed for "${itemName}": ${err.message}`);
        }
    }

    logger.error(`Bitwarden update failed for "${itemName}": ${lastError.message}`);
    try {
        fs.mkdirSync(path.dirname(config.ROTATION_RECOVERY_FILE), { recursive: true });
        const record = { time: new Date().toISOString(), item: itemName, uri, username: item.login.username, newPassword };
        fs.appendFileSync(config.ROTATION_RECOVERY_FILE, JSON.stringify(record) + '\n', { mode: 0o600 });
        logger.error(`⚠️  "${itemName}": the password WAS changed on ${uri}. The new password was saved to ${config.ROTATION_RECOVERY_FILE} — update the vault item manually, then delete that file.`);
    } catch (writeErr) {
        logger.error(`⚠️  "${itemName}": the password WAS changed on ${uri} but could not be saved anywhere (${writeErr.message}). Reset it manually.`);
    }
    return false;
}

async function processSingleItem(itemName, cache, fetch, sessionToken) {
    stats.total++;
    const item = bw.getCachedItem(cache, itemName);

    if (!item?.login?.uris?.length || !item.login.username || !item.login.password) {
        logger.warn(`Skipping "${itemName}" (missing data or not found)`);
        stats.skipped++;
        return;
    }

    const { username, password } = item.login;
    const uri = api.cleanDomain(item.login.uris[0].uri);
    const newPassword = generatePassword();

    // 1. Authenticate
    let accessToken;
    try {
        accessToken = await withRetry(() => api.authenticate(fetch, uri, username, password));
    } catch (err) {
        logger.error(`Auth failed for "${itemName}": ${err.message}`);
        stats.authFailed++;
        return;
    }

    // 2. Password change (controlled by feature flag)
    if (!config.ENABLE_PASSWORD_CHANGE) {
        logger.info(`Auth OK for "${itemName}" — password change skipped (ENABLE_PASSWORD_CHANGE=false)`);
        stats.authOk++;
        return;
    }

    let changed;
    try {
        changed = await withRetry(() => api.changePassword(fetch, uri, accessToken, password, newPassword));
    } catch (err) {
        logger.error(`Password change failed for "${itemName}": ${err.message}`);
        stats.changeFailed++;
        return;
    }

    if (changed) {
        // 3. Update Bitwarden
        if (saveToVault(sessionToken, item, itemName, uri, newPassword)) stats.changed++;
        else stats.bwFailed++;
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
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

    const itemNames = readLines(config.PASSWORD_CHANGER_FILE);

    await processBatches(
        itemNames,
        config.BATCH_SIZE,
        config.BATCH_DELAY_MS,
        name => processSingleItem(name.trim(), cache, fetch, sessionToken)
    );

    const mode = config.ENABLE_PASSWORD_CHANGE ? 'LIVE' : 'DRY RUN';

    logger.info('');
    logger.info('══════════════════════════════════════');
    logger.info(`     BULK PASSWORD CHANGER SUMMARY [${mode}]`);
    logger.info('══════════════════════════════════════');
    logger.info(`  Total processed         : ${stats.total}`);
    logger.info(`  ⚠️  Skipped (missing data): ${stats.skipped}`);
    logger.info(`  ❌ Auth failed           : ${stats.authFailed}`);
    if (config.ENABLE_PASSWORD_CHANGE) {
        logger.info(`  ✅ Password changed      : ${stats.changed}`);
        logger.info(`  ❌ Change failed         : ${stats.changeFailed}`);
        logger.info(`  ❌ Bitwarden update fail : ${stats.bwFailed}`);
    } else {
        logger.info(`  ✅ Auth OK (not changed) : ${stats.authOk}`);
        logger.info(`  ℹ️  Set ENABLE_PASSWORD_CHANGE=true to apply changes`);
    }
    logger.info('══════════════════════════════════════');
})().catch(err => {
    logger.error('Critical error:', err.message);
    process.exit(1);
});
