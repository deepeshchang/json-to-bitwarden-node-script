'use strict';

const config = require('../lib/config');
const logger = require('../lib/logger');
const bw = require('../lib/bitwarden');
const { readJson } = require('../lib/utils');

(async () => {
    const credentials = readJson(config.CREDENTIALS_FILE);
    if (!Array.isArray(credentials)) throw new Error(`${config.CREDENTIALS_FILE} must contain a JSON array`);

    if (!config.BW_ORG_ID) {
        throw new Error('BW_ORG_ID is required for add-credentials (items are created in an organization). Set it in .env.');
    }
    logger.info(`Org ID       : ${config.BW_ORG_ID}`);
    logger.info(`Credentials  : ${credentials.length} items to process`);

    const sessionToken = await bw.getSessionToken();
    const cache = bw.loadVaultCache(sessionToken); // syncs, and lets us skip names that already exist

    let added = 0, skipped = 0, failed = 0;
    const failures = [];
    const seen = new Set();

    for (const credential of credentials) {
        const key = String(credential?.name ?? '').trim().toLowerCase();
        if (key && (cache.has(key) || seen.has(key))) {
            logger.warn(`Skipping "${credential.name}" — an item with this name already exists`);
            skipped++;
            continue;
        }
        try {
            bw.createItem(sessionToken, credential);
            if (key) seen.add(key);
            added++;
        } catch (err) {
            failed++;
            failures.push(`  • ${credential?.name}: ${err.message}`);
        }
    }

    logger.info('');
    logger.info('══════════════════════════════════════');
    logger.info('       ADD CREDENTIALS SUMMARY        ');
    logger.info('══════════════════════════════════════');
    logger.info(`  Total processed       : ${credentials.length}`);
    logger.info(`  ✅ Added              : ${added}`);
    logger.info(`  ⏭️  Skipped (duplicate): ${skipped}`);
    logger.info(`  ❌ Failed             : ${failed}`);
    logger.info('══════════════════════════════════════');
    if (failures.length > 0) {
        logger.info('');
        logger.info('FAILURES:');
        failures.forEach(f => logger.info(f));
    }
})().catch(err => {
    logger.error('Critical error:', err.message);
    process.exit(1);
});
