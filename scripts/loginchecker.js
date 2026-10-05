'use strict';

const config = require('../lib/config');
const logger = require('../lib/logger');
const bw = require('../lib/bitwarden');
const api = require('../lib/api');
const { processBatches, readLines } = require('../lib/utils');

const stats = { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 };

async function processItem(itemName, cache, fetch) {
    stats.total++;
    logger.debug(`Processing: ${itemName}`);
    const item = bw.getCachedItem(cache, itemName);

    if (!item?.login?.uris?.length || !item.login.username || !item.login.password) {
        logger.warn(`▶▶ Skipping "${itemName}" (missing credentials or URI)`);
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
    let status;
    try {
        status = await api.checkLoginStatus(fetch, uri, username, password);
    } catch (err) {
        logger.error(`Network error for "${itemName}": ${err.message}`);
        stats.errored++;
        return;
    }

    if (status === 200) {
        logger.info(`✅ ${itemName} | ${uri} | ${status}`);
        stats.passed++;
    } else {
        logger.warn(`❌ ${itemName} | ${uri} | ${status}`);
        stats.failed++;
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
    logger.info('          LOGIN CHECKER SUMMARY       ');
    logger.info('══════════════════════════════════════');
    logger.info(`  Total processed : ${stats.total}`);
    logger.info(`  ✅ Passed (200)  : ${stats.passed}`);
    logger.info(`  ❌ Failed        : ${stats.failed}`);
    logger.info(`  ⚠️  Skipped       : ${stats.skipped}`);
    logger.info(`  💥 Network error : ${stats.errored}`);
    logger.info('══════════════════════════════════════');
})().catch(err => {
    logger.error('Critical error:', err.message);
    process.exit(1);
});
