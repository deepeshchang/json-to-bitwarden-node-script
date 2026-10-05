'use strict';

const config = require('../lib/config');
const logger = require('../lib/logger');
const bw = require('../lib/bitwarden');
const { readJson } = require('../lib/utils');

/**
 * Reads assets/updatepasswords.json and updates each entry's name, password and/or notes in Bitwarden.
 * At least one of "new_name", "password", or "notes" must be present per entry.
 *
 * Input file format:
 * [
 *   { "name": "Admin - Acme - CustomerA",   "password": "newPassword1" },
 *   { "name": "Admin - Acme - CustomerB",   "notes": "new note text" },
 *   { "name": "Admin - Acme - CustomerC",   "password": "newPass3", "notes": "also updated" },
 *   { "name": "Admin - Acme - OldName",     "new_name": "Admin - Acme - NewName" }
 * ]
 */
(async () => {
    const entries = readJson(config.UPDATE_PASSWORDS_FILE);
    if (!Array.isArray(entries)) throw new Error(`${config.UPDATE_PASSWORDS_FILE} must contain a JSON array`);
    logger.info(`Loaded ${entries.length} entries from ${config.UPDATE_PASSWORDS_FILE}`);

    const sessionToken = await bw.getSessionToken();
    const cache = bw.loadVaultCache(sessionToken); // syncs vault before loading

    const stats = { total: 0, updated: 0, notFound: 0, failed: 0 };
    const failures = [];

    for (const entry of entries) {
        stats.total++;
        const { name, new_name, password, notes } = entry;

        if (!name || (new_name === undefined && password === undefined && notes === undefined)) {
            logger.warn(`Skipping entry with missing name or no fields to update: ${JSON.stringify(entry)}`);
            stats.failed++;
            failures.push(`  • (invalid entry): ${JSON.stringify(entry)}`);
            continue;
        }

        const item = bw.getCachedItem(cache, name);

        if (!item) {
            logger.warn(`Not found in vault: "${name}"`);
            stats.notFound++;
            failures.push(`  • Not found: "${name}"`);
            continue;
        }

        try {
            const fields = {};
            if (new_name !== undefined) fields.name = new_name;
            if (password !== undefined) fields.password = password;
            if (notes !== undefined) fields.notes = notes;
            bw.updateItemFields(sessionToken, item, fields);
            stats.updated++;
        } catch (err) {
            logger.error(`Failed to update "${name}": ${err.message}`);
            stats.failed++;
            failures.push(`  • Failed: "${name}" — ${err.message}`);
        }
    }

    logger.info('');
    logger.info('══════════════════════════════════════');
    logger.info('      UPDATE PASSWORDS SUMMARY        ');
    logger.info('══════════════════════════════════════');
    logger.info(`  Total entries   : ${stats.total}`);
    logger.info(`  ✅ Updated       : ${stats.updated}`);
    logger.info(`  ⚠️  Not found     : ${stats.notFound}`);
    logger.info(`  ❌ Failed        : ${stats.failed}`);
    logger.info('══════════════════════════════════════');
    if (failures.length > 0) {
        logger.info('');
        logger.info('ISSUES:');
        failures.forEach(f => logger.info(f));
    }
})().catch(err => {
    logger.error('Critical error:', err.message);
    process.exit(1);
});
