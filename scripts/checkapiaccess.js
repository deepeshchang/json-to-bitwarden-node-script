'use strict';

const config = require('../lib/config');
const logger = require('../lib/logger');
const bw = require('../lib/bitwarden');
const api = require('../lib/api');
const { ApiError } = require('../lib/errors');
const { processBatches, readLines } = require('../lib/utils');

const stats = { total: 0, passed: 0, loginFailed: 0, apiFailed: 0, skipped: 0, errored: 0 };

async function processItem(itemName, cache, fetch) {
    stats.total++;
    logger.debug(`Processing: ${itemName}`);
    const item = bw.getCachedItem(cache, itemName);

    if (!item?.login?.uris?.length || !item.login.username || !item.login.password) {
        logger.warn(`Skipping "${itemName}" (missing credentials or URI)`);
        stats.skipped++;
        return;
    }

    const { username, password } = item.login;
    const rawUri = item.login.uris[0]?.uri;
    if (!rawUri) {
        logger.warn(`No valid URI for "${itemName}". Skipping.`);
        stats.skipped++;
        return;
    }

    const uri = api.cleanDomain(rawUri);

    let auth;
    try {
        auth = await api.authenticateFull(fetch, uri, username, password);
    } catch (err) {
        if (err instanceof ApiError && err.status) {
            logger.warn(`❌ ${itemName} | ${uri} | login=${err.status}`);
            stats.loginFailed++;
        } else {
            logger.error(`Network/auth error for "${itemName}": ${err.message}`);
            stats.errored++;
        }
        return;
    }

    if (!auth.user_id && config.ENDPOINTS.USER_BY_ID.includes('{userId}')) {
        logger.error(`No "${config.AUTH_USER_ID_FIELD}" in login response for "${itemName}" — set AUTH_USER_ID_FIELD or API_USER_BY_ID_PATH`);
        stats.errored++;
        return;
    }

    let apiStatus;
    try {
        apiStatus = await api.getUserById(fetch, uri, auth.access_token, auth.user_id);
    } catch (err) {
        logger.error(`Network error on user-by-id probe (${auth.user_id}) for "${itemName}": ${err.message}`);
        stats.errored++;
        return;
    }

    if (apiStatus === 200) {
        logger.info(`✅ ${itemName} | ${uri} | login=200 api=${apiStatus}`);
        stats.passed++;
    } else {
        logger.warn(`❌ ${itemName} | ${uri} | login=200 api=${apiStatus}`);
        stats.apiFailed++;
    }
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

    const itemNames = readLines(config.LOGIN_CHECKER_FILE);

    await processBatches(
        itemNames,
        config.BATCH_SIZE,
        config.BATCH_DELAY_MS,
        name => processItem(name.trim(), cache, fetch)
    );

    logger.info('');
    logger.info('══════════════════════════════════════');
    logger.info('         CHECK API ACCESS SUMMARY     ');
    logger.info('══════════════════════════════════════');
    logger.info(`  Total processed   : ${stats.total}`);
    logger.info(`  ✅ Passed (login+api): ${stats.passed}`);
    logger.info(`  ❌ Login failed    : ${stats.loginFailed}`);
    logger.info(`  ❌ API failed      : ${stats.apiFailed}`);
    logger.info(`  ⚠️  Skipped         : ${stats.skipped}`);
    logger.info(`  💥 Network error   : ${stats.errored}`);
    logger.info('══════════════════════════════════════');
})().catch(err => {
    logger.error('Critical error:', err.message);
    process.exit(1);
});
