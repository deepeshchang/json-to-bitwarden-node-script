'use strict';

const fs = require('fs');
const readline = require('readline');
const config = require('../lib/config');
const logger = require('../lib/logger');
const bw = require('../lib/bitwarden');
const api = require('../lib/api');
const { withRetry, processBatches, generatePassword, readLines } = require('../lib/utils');
const { render, loadTemplate } = require('../lib/template');

// ---------------------------------------------------------------------------
// State (processBatches discards handler return values, so results and the
// per-run stats are accumulated here at module scope — established pattern).
// ---------------------------------------------------------------------------
const stats = {
    total: 0,
    skipped: 0,
    authFailed: 0,
    noGroups: 0,
    dryRun: 0,
    created: 0,
    existingSkipped: 0,
    createFailed: 0,
    permFailed: 0,
};

// Newly created users, carrying everything needed for the Bitwarden export AND
// the post-run login verification pass (uri, credentials, entityId).
const newUsers = [];

// Loaded once in main(); the request body for POST <users endpoint>.
let createUserTemplate;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Asks a yes/no question on stdin and resolves true only for an explicit "y"/"yes".
 */
function confirm(question) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        rl.question(`${question} `, answer => {
            rl.close();
            resolve(/^y(es)?$/i.test(answer.trim()));
        });
    });
}

/**
 * Derives the customer label from an admin item name, e.g.
 * "Admin - Acme - CustomerX" -> "CustomerX".
 */
function customerFromItemName(itemName) {
    return itemName.split(' - ').pop().trim();
}

/**
 * Builds the Bitwarden item name for a created user:
 *   "<First> <Last> – <customer>", or
 *   "<First> <Last> – <VENDOR_LABEL> – <customer>" when VENDOR_LABEL is set.
 */
function credItemName(customer) {
    const person = `${config.NEW_USER_FIRSTNAME} ${config.NEW_USER_LASTNAME}`;
    return config.VENDOR_LABEL
        ? `${person} – ${config.VENDOR_LABEL} – ${customer}`
        : `${person} – ${customer}`;
}

/**
 * Builds the permissions `datasource` for an instance from its regions and sales
 * regions. Each region maps to { region: <region._id>, salesRegions: [...] }, and
 * every sales-region id in region.sales_region maps to
 * { salesRegion: <id>, locations: ['all'] }. The salesregions endpoint is used as a
 * validation set — a region reference not present there is logged but still granted
 * (so scope is never silently reduced).
 */
async function buildDatasource(fetch, uri, accessToken, itemName) {
    const [regions, salesRegions] = await Promise.all([
        api.listRegions(fetch, uri, accessToken),
        api.listSalesRegions(fetch, uri, accessToken),
    ]);

    const knownSalesRegionIds = new Set((salesRegions || []).map(s => s._id));

    return (regions || []).map(region => {
        const salesRegionIds = Array.isArray(region.sales_region) ? region.sales_region : [];
        const unknown = salesRegionIds.filter(id => !knownSalesRegionIds.has(id));
        if (unknown.length > 0) {
            logger.warn(`"${itemName}" | region ${region.name || region._id} references unknown sales region(s): ${unknown.join(', ')}`);
        }
        return {
            region: region._id,
            salesRegions: salesRegionIds.map(id => ({ salesRegion: id, locations: ['all'] })),
        };
    }).filter(entry => entry.salesRegions.length > 0);
}

/**
 * Grants a user serviceArea "all" across every region/sales-region (locations "all").
 * Returns true on success, false on failure (logged). The caller decides how to count it.
 */
async function grantPermissions(fetch, uri, accessToken, entityId, itemName) {
    // Some backends assign access purely via group membership at create time and
    // have no separate permissions endpoint — skip the grant entirely.
    if (!config.ENABLE_PERMISSIONS) return true;

    try {
        const entry = { entityId, serviceArea: ['all'] };

        // Region/location scoping only applies to backends that expose regions +
        // sales regions. When disabled, grant serviceArea "all" with no datasource.
        if (config.ENABLE_REGION_SCOPING) {
            const datasource = await buildDatasource(fetch, uri, accessToken, itemName);
            if (datasource.length === 0) {
                logger.warn(`"${itemName}" | no regions/sales regions found — granting empty datasource`);
            }
            entry.datasource = datasource;
        }

        await api.setPermissions(fetch, uri, accessToken, [entry]);
        return true;
    } catch (err) {
        logger.error(`Permissions failed for "${itemName}": ${err.message}`);
        return false;
    }
}

/**
 * Looks up a user by exact username via the users endpoint. Returns the user
 * object or null.
 */
async function findUserByUsername(fetch, uri, accessToken, username) {
    const users = await api.listUsers(fetch, uri, accessToken);
    return Array.isArray(users) ? users.find(u => u[config.USER_FIELD_USERNAME] === username) || null : null;
}

// ---------------------------------------------------------------------------
// Single instance processing
// ---------------------------------------------------------------------------

async function processSingleItem(itemName, cache, fetch, requestedGroups) {
    stats.total++;
    const item = bw.getCachedItem(cache, itemName);

    if (!item?.login?.uris?.length || !item.login.username || !item.login.password) {
        logger.warn(`Skipping "${itemName}" (missing credentials or URI)`);
        stats.skipped++;
        return;
    }

    const { username, password } = item.login;
    const uri = api.cleanDomain(item.login.uris[0].uri);

    // 1. Authenticate as the admin account.
    let accessToken;
    try {
        accessToken = await withRetry(() => api.authenticate(fetch, uri, username, password));
    } catch (err) {
        logger.warn(`❌ ${itemName} | ${uri} | auth failed: ${err.message}`);
        stats.authFailed++;
        return;
    }

    // 2. Fetch and filter ACL groups by name.
    let groups;
    try {
        groups = await withRetry(() => api.listGroups(fetch, uri, accessToken));
    } catch (err) {
        logger.error(`Failed to fetch groups for "${itemName}": ${err.message}`);
        stats.noGroups++;
        return;
    }

    const groupName = g => String(g[config.GROUP_FIELD_NAME]);
    const matched = groups.filter(g => requestedGroups.has(groupName(g).toLowerCase()));
    const groupIds = matched.map(g => g[config.GROUP_FIELD_ID]);
    const matchedNames = new Set(matched.map(g => groupName(g).toLowerCase()));
    const missing = [...requestedGroups].filter(n => !matchedNames.has(n));
    if (missing.length > 0) {
        logger.warn(`"${itemName}" | groups not found on instance: ${missing.join(', ')}`);
    }

    if (groupIds.length === 0) {
        logger.warn(`Skipping "${itemName}" (none of the requested groups exist on ${uri})`);
        stats.noGroups++;
        return;
    }

    logger.info(`${itemName} | matched ${groupIds.length} group(s): ${matched.map(groupName).join(', ')}`);

    // 3. Check whether the user already exists on this instance.
    let existingUser;
    try {
        existingUser = await findUserByUsername(fetch, uri, accessToken, config.NEW_USER_USERNAME);
    } catch (err) {
        logger.error(`Failed to list users for "${itemName}": ${err.message}`);
        stats.createFailed++;
        return;
    }

    // 4. Dry-run gate — no create/permission POSTs unless explicitly enabled.
    if (!config.ENABLE_USER_CREATION) {
        if (existingUser) {
            logger.info(`[DRY RUN] "${config.NEW_USER_USERNAME}" exists on ${uri} (${itemName}) — would skip (already exists)`);
        } else {
            logger.info(`[DRY RUN] would create "${config.NEW_USER_USERNAME}" on ${uri} with groups [${matched.map(groupName).join(', ')}]`);
        }
        stats.dryRun++;
        return;
    }

    // 5. User already exists → skip entirely. Leave the existing user untouched:
    //    no permission update, and no new credential emitted for Bitwarden.
    if (existingUser) {
        logger.info(`⏭️  "${config.NEW_USER_USERNAME}" already exists on ${uri} (${itemName}) — skipping`);
        stats.existingSkipped++;
        return;
    }

    // 6. Create the user with a generated password.
    const newPassword = generatePassword();
    const payload = render(createUserTemplate, {
        username: config.NEW_USER_USERNAME,
        firstName: config.NEW_USER_FIRSTNAME,
        lastName: config.NEW_USER_LASTNAME,
        email: config.NEW_USER_EMAIL,
        language: config.NEW_USER_LANGUAGE,
        password: newPassword,
        groupIds,                              // raw array
        groupIdsJson: JSON.stringify(groupIds), // JSON-stringified array, for APIs that expect that
    });

    let createStatus;
    try {
        createStatus = await api.createUser(fetch, uri, accessToken, payload);
    } catch (err) {
        logger.error(`Create user failed for "${itemName}": ${err.message}`);
        stats.createFailed++;
        return;
    }

    // Handle a race: user was created between our existence check and this call.
    if (createStatus === 409) {
        logger.warn(`⏭️  "${config.NEW_USER_USERNAME}" already exists on ${uri} (${itemName}) — skipping`);
        stats.existingSkipped++;
        return;
    }
    if (createStatus < 200 || createStatus >= 300) {
        logger.error(`Create user failed for "${itemName}" (HTTP ${createStatus})`);
        stats.createFailed++;
        return;
    }

    // 7. Resolve the new user's entityId by matching username.
    let entityId;
    try {
        const found = await findUserByUsername(fetch, uri, accessToken, config.NEW_USER_USERNAME);
        entityId = found?.[config.USER_FIELD_ID];
    } catch (err) {
        logger.error(`Failed to look up new user on "${itemName}": ${err.message}`);
        stats.createFailed++;
        return;
    }

    if (!entityId) {
        logger.error(`Created user not found in user list on ${uri} (${itemName})`);
        stats.createFailed++;
        return;
    }

    // 8. Grant permissions. The user exists now, so record the credential regardless.
    if (!await grantPermissions(fetch, uri, accessToken, entityId, itemName)) {
        stats.permFailed++;
    }

    newUsers.push({
        itemName,
        customer: customerFromItemName(itemName),
        uri,
        username: config.NEW_USER_USERNAME,
        password: newPassword,
        entityId,
    });
    logger.info(`✅ Created "${config.NEW_USER_USERNAME}" on ${uri} (${itemName})`);
    stats.created++;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
    const fetch = globalThis.fetch;
    createUserTemplate = loadTemplate(config.CREATE_USER_TEMPLATE_FILE);
    const sessionToken = await bw.getSessionToken();

    let cache;
    try {
        cache = bw.loadVaultCache(sessionToken);
    } catch (err) {
        logger.error(err.message);
        process.exit(1);
    }

    // Requested ACL group names (one per line), lowercased for matching.
    const groupNames = readLines(config.USER_GROUPS_FILE);
    if (groupNames.length === 0) {
        logger.error(`No group names found in ${config.USER_GROUPS_FILE}. Aborting.`);
        process.exit(1);
    }
    const requestedGroups = new Set(groupNames.map(n => n.toLowerCase()));

    // Admin instance item names (one per line).
    const itemNames = readLines(config.ADMIN_ACCOUNTS_FILE);

    await processBatches(
        itemNames,
        config.BATCH_SIZE,
        config.BATCH_DELAY_MS,
        name => processSingleItem(name.trim(), cache, fetch, requestedGroups)
    );

    const mode = config.ENABLE_USER_CREATION ? 'LIVE' : 'DRY RUN';

    logger.info('');
    logger.info('══════════════════════════════════════');
    logger.info(`        CREATE USERS SUMMARY [${mode}]`);
    logger.info('══════════════════════════════════════');
    logger.info(`  Total processed        : ${stats.total}`);
    logger.info(`  ⚠️  Skipped (missing data): ${stats.skipped}`);
    logger.info(`  ❌ Auth failed          : ${stats.authFailed}`);
    logger.info(`  ⚠️  No matching groups   : ${stats.noGroups}`);
    if (config.ENABLE_USER_CREATION) {
        logger.info(`  ✅ Users created        : ${stats.created}`);
        logger.info(`  ⏭️  Existing (skipped)   : ${stats.existingSkipped}`);
        logger.info(`  ❌ Create failed        : ${stats.createFailed}`);
        logger.info(`  ⚠️  Permission failures  : ${stats.permFailed}`);
    } else {
        logger.info(`  🧪 Would create (dry run): ${stats.dryRun}`);
        logger.info(`  ℹ️  Set ENABLE_USER_CREATION=true to apply changes`);
    }
    logger.info('══════════════════════════════════════');

    if (newUsers.length === 0) {
        return;
    }

    // Verification pass — log in as each newly created user (one by one), then hit
    // the user-groups endpoint to prove login works AND they can read
    // their group assignments (i.e. the ACL/permissions actually took effect).
    logger.info('');
    logger.info('--- Verifying new user logins ---');
    let verified = 0;
    let verifyFailed = 0;
    for (const u of newUsers) {
        let token;
        try {
            token = await withRetry(() => api.authenticate(fetch, u.uri, u.username, u.password));
        } catch (err) {
            logger.warn(`❌ ${u.username} @ ${u.uri} (${u.itemName}) — login failed: ${err.message}`);
            verifyFailed++;
            continue;
        }

        let groupsStatus;
        try {
            groupsStatus = await api.getUserGroups(fetch, u.uri, token, u.entityId);
        } catch (err) {
            logger.warn(`❌ ${u.username} @ ${u.uri} (${u.itemName}) — groups fetch error: ${err.message}`);
            verifyFailed++;
            continue;
        }

        if (groupsStatus === 200) {
            logger.info(`✅ ${u.username} @ ${u.uri} (${u.itemName}) — login OK, groups=${groupsStatus}`);
            verified++;
        } else {
            logger.warn(`❌ ${u.username} @ ${u.uri} (${u.itemName}) — login OK, groups=${groupsStatus}`);
            verifyFailed++;
        }
    }

    logger.info('');
    logger.info('══════════════════════════════════════');
    logger.info('       NEW USER LOGIN VERIFICATION    ');
    logger.info('══════════════════════════════════════');
    logger.info(`  ✅ Verified : ${verified}`);
    logger.info(`  ❌ Failed   : ${verifyFailed}`);
    logger.info('══════════════════════════════════════');

    // Build the creds.json-shaped records for Bitwarden from the created users.
    const creds = newUsers.map(u => ({
        name: credItemName(u.customer),
        username: u.username,
        password: u.password,
        uri: u.uri,
        collection_ids: config.NEW_USER_COLLECTION_ID ? [config.NEW_USER_COLLECTION_ID] : [],
    }));

    if (!config.NEW_USER_COLLECTION_ID) {
        logger.warn('NEW_USER_COLLECTION_ID is not set — emitted credentials have no collection and cannot be imported until you add one.');
    }

    // Write the output file.
    // Contains plaintext passwords — owner-only permissions.
    fs.writeFileSync(config.CREATE_USERS_OUTPUT_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
    logger.info('');
    logger.info(`Wrote ${creds.length} credential(s) to ${config.CREATE_USERS_OUTPUT_FILE}`);

    // Confirm before pushing into Bitwarden.
    const proceed = await confirm(`Add ${creds.length} credential(s) to Bitwarden now? [y/N]`);
    if (!proceed) {
        logger.info(`Skipped Bitwarden import. Import later with: CREDENTIALS_FILE=${config.CREATE_USERS_OUTPUT_FILE} npm run add-credentials`);
        return;
    }

    let added = 0;
    let failed = 0;
    const failures = [];
    for (const cred of creds) {
        try {
            bw.createItem(sessionToken, cred);
            added++;
        } catch (err) {
            failed++;
            failures.push(`  • ${cred.name}: ${err.message}`);
        }
    }

    logger.info('');
    logger.info('══════════════════════════════════════');
    logger.info('       BITWARDEN IMPORT SUMMARY       ');
    logger.info('══════════════════════════════════════');
    logger.info(`  ✅ Added : ${added}`);
    logger.info(`  ❌ Failed: ${failed}`);
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
