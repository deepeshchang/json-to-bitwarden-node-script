'use strict';

const { execFileSync } = require('child_process');
const readline = require('readline');
const config = require('./config');
const logger = require('./logger');
const { BitwardenError, ConfigError } = require('./errors');

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

/**
 * Runs the `bw` CLI with an argument array — never a shell string — so no value
 * (item ids, names, passwords) is ever interpolated into a shell command.
 * On Windows the `bw` shim is a .cmd file, which Node can only launch through a shell;
 * the arguments passed in this module are fixed literals or Bitwarden-generated ids.
 */
function bwRun(args, { input, env } = {}) {
    return execFileSync(config.BW_CLI_PATH, args, {
        encoding: 'utf-8',
        input,
        maxBuffer: 1024 * 1024 * 50,
        env: env || process.env,
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}

const sessionEnv = sessionToken => ({ ...process.env, BW_SESSION: sessionToken });

/** Throws a ConfigError unless some Bitwarden auth path is configured. */
function assertBitwardenAuthConfigured() {
    const hasSession = !!config.BW_SESSION_ID;
    const hasApiKey = !!(config.BW_CLIENT_ID && config.BW_CLIENT_SECRET);
    if (!hasSession && !hasApiKey) {
        throw new ConfigError(
            'Bitwarden authentication not configured. Set BW_SESSION_ID (from `bw unlock --raw`) ' +
            'or BW_CLIENT_ID + BW_CLIENT_SECRET in your .env (see .env.example).'
        );
    }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Prompts for the Bitwarden master password on stdin (used when BW_MASTER_PASSWORD is not set).
 * Hides input from terminal.
 */
function promptMasterPassword() {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        // Hide typed characters
        rl.stdoutMuted = true;
        rl._writeToOutput = function (str) {
            // Only echo newline, not the password characters
            if (str === '\n' || str === '\r\n') rl.output.write('\n');
        };
        rl.question('Bitwarden master password: ', answer => {
            rl.close();
            resolve(answer.trim());
        });
        rl.on('error', reject);
    });
}

function unlockWithEnvPassword() {
    // Env var, never a CLI argument — invisible in the process list.
    return bwRun(['unlock', '--passwordenv', 'BW_MASTER_PASSWORD', '--raw'], {
        env: { ...process.env, BW_MASTER_PASSWORD: config.BW_MASTER_PASSWORD },
    }).trim();
}

/**
 * Obtains a Bitwarden session token.
 *
 * Flow:
 *   1. If BW_SESSION_ID is set → use it directly (fastest, for scripts with pre-auth).
 *   2. Otherwise:
 *      a. bw login --apikey  (reads BW_CLIENTID + BW_CLIENTSECRET from env automatically)
 *      b. bw unlock --passwordenv BW_MASTER_PASSWORD  (or prompts if not set)
 *      → returns session token
 */
async function getSessionToken() {
    if (config.BW_SESSION_ID) return config.BW_SESSION_ID;
    assertBitwardenAuthConfigured();

    // --- Step 1: check current status ---
    let status;
    try {
        const out = bwRun(['status']);
        status = JSON.parse(out).status; // "unauthenticated" | "locked" | "unlocked"
    } catch (err) {
        throw new BitwardenError(`bw status failed: ${err.message}`);
    }

    // --- Step 2: API key login if not yet authenticated ---
    if (status === 'unauthenticated') {
        logger.info('Logging into Bitwarden via API key...');
        if (!config.BW_CLIENT_ID || !config.BW_CLIENT_SECRET) {
            throw new BitwardenError('BW_CLIENT_ID and BW_CLIENT_SECRET are required for API key login.');
        }
        try {
            bwRun(['login', '--apikey'], {
                env: {
                    ...process.env,
                    BW_CLIENTID: config.BW_CLIENT_ID,
                    BW_CLIENTSECRET: config.BW_CLIENT_SECRET,
                },
            });
            logger.info('API key login successful.');
        } catch (err) {
            throw new BitwardenError(`bw login --apikey failed: ${err.message}`);
        }
        status = 'locked'; // After API key login, vault is locked
    }

    // --- Step 3: unlock vault to get session token ---
    if (status === 'locked') {
        logger.info('Unlocking Bitwarden vault...');

        let sessionToken;

        if (config.BW_MASTER_PASSWORD) {
            // Use env var — never visible in process list
            try {
                sessionToken = unlockWithEnvPassword();
            } catch (err) {
                throw new BitwardenError(`bw unlock failed: ${err.message}`);
            }
        } else {
            // Interactive: prompt on stdin
            const masterPassword = await promptMasterPassword();
            try {
                // Pass password via stdin to avoid env var and CLI arg exposure
                sessionToken = bwRun(['unlock', '--raw'], { input: masterPassword }).trim();
            } catch (err) {
                throw new BitwardenError(`bw unlock failed: ${err.message}`);
            }
        }

        logger.info('Vault unlocked successfully.');
        return sessionToken;
    }

    if (status === 'unlocked') {
        // Already unlocked — just re-unlock to get a fresh session token
        logger.info('Vault already unlocked. Retrieving session token...');
        try {
            if (config.BW_MASTER_PASSWORD) {
                return unlockWithEnvPassword();
            }
            const masterPassword = await promptMasterPassword();
            return bwRun(['unlock', '--raw'], { input: masterPassword }).trim();
        } catch (err) {
            throw new BitwardenError(`bw unlock failed: ${err.message}`);
        }
    }

    throw new BitwardenError(`Unexpected bw status: ${status}`);
}

// ---------------------------------------------------------------------------
// Vault cache
// ---------------------------------------------------------------------------

/**
 * Syncs the local Bitwarden vault with the server to ensure it is up to date.
 */
function syncVault(sessionToken) {
    try {
        logger.info('Syncing Bitwarden vault...');
        bwRun(['sync'], { env: sessionEnv(sessionToken) });
        logger.info('Vault synced successfully.');
    } catch (error) {
        throw new BitwardenError(`Failed to sync Bitwarden vault: ${error.message}`);
    }
}

/**
 * Syncs the vault, then fetches all items and returns a Map keyed by lowercased item name.
 */
function loadVaultCache(sessionToken) {
    syncVault(sessionToken);
    try {
        logger.info('Fetching all Bitwarden items...');
        const stdout = bwRun(['list', 'items'], { env: sessionEnv(sessionToken) });
        const items = JSON.parse(stdout);
        const cache = new Map(items.map(item => [item.name.toLowerCase(), item]));
        logger.info(`Cached ${cache.size} items from Bitwarden.`);
        return cache;
    } catch (error) {
        throw new BitwardenError(`Failed to fetch Bitwarden vault: ${error.message}`);
    }
}

/**
 * Case-insensitive lookup from a vault cache Map.
 */
function getCachedItem(cache, name) {
    return cache.get(name.trim().toLowerCase()) || null;
}

// ---------------------------------------------------------------------------
// Per-item queries
// ---------------------------------------------------------------------------

/**
 * Searches for a single item by name via CLI (used when full vault cache is not loaded).
 * Filters in JS to avoid shell interpolation of user-controlled input.
 */
function searchItem(sessionToken, itemName) {
    try {
        const stdout = bwRun(['list', 'items'], { env: sessionEnv(sessionToken) });
        const items = JSON.parse(stdout);
        const needle = itemName.trim().toLowerCase();
        return items.find(item => item.name.toLowerCase() === needle) || null;
    } catch (error) {
        throw new BitwardenError(`Failed to search for item "${itemName}": ${error.message}`);
    }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Creates a new item in the Bitwarden vault.
 * collection_id must be set on the credential object; BW_ORG_ID must be in config.
 * Pass cache to enable duplicate detection before creation.
 */
function createItem(sessionToken, credential) {
    const { name, username, password, notes } = credential;
    if (!name || !username || !password) {
        throw new BitwardenError("Credential is missing required fields: 'name', 'username', or 'password'.");
    }

    // Accept collection_ids or collection_id, either as a string or an array
    const rawCollections = credential.collection_ids ?? credential.collection_id;
    const collectionIds = [rawCollections].flat().filter(Boolean);

    if (collectionIds.length === 0) {
        throw new BitwardenError(`Credential "${name}" is missing 'collection_ids'.`);
    }

    // Accept uri (string) or uris (array)
    const uris = Array.isArray(credential.uris)
        ? credential.uris
        : credential.uri ? [credential.uri] : [];

    try {
        // Fetch the item template and modify it in JS to avoid shell quoting issues
        const bwEnv = sessionEnv(sessionToken);
        const item = JSON.parse(bwRun(['get', 'template', 'item'], { env: bwEnv }));
        const loginTemplateJson = bwRun(['get', 'template', 'item.login'], { env: bwEnv });

        item.name = name;
        item.organizationId = config.BW_ORG_ID || '';
        item.collectionIds = collectionIds;
        item.notes = notes || '';
        item.login = JSON.parse(loginTemplateJson);
        item.login.username = username;
        item.login.password = password;
        if (uris.length > 0) {
            item.login.uris = uris.map(u => ({ uri: u, match: null }));
        }

        const encoded = bwRun(['encode'], { input: JSON.stringify(item) }).trim();
        const result = bwRun(['create', 'item'], { input: encoded, env: bwEnv }).trim();

        logger.info(`Credential added successfully: ${name}`);
        return result;
    } catch (error) {
        throw new BitwardenError(`Failed to create item "${name}": ${error.message}`);
    }
}

/**
 * Updates an existing item's password in the Bitwarden vault.
 * itemObj is updated in place only after the write succeeds.
 */
function updateItemPassword(sessionToken, itemObj, newPassword) {
    return updateItemFields(sessionToken, itemObj, { password: newPassword });
}

/**
 * Updates one or more fields on an existing Bitwarden item.
 * Supported fields: name (string), password (string), notes (string).
 * At least one field must be provided.
 */
function updateItemFields(sessionToken, itemObj, fields = {}) {
    const { name, password, notes } = fields;
    if (name === undefined && password === undefined && notes === undefined) {
        throw new BitwardenError(`No fields to update for "${itemObj.name}".`);
    }
    try {
        // Work on a copy so a failed write never leaves the cached item half-modified.
        const updated = JSON.parse(JSON.stringify(itemObj));
        if (name !== undefined) updated.name = name;
        if (password !== undefined) updated.login.password = password;
        if (notes !== undefined) updated.notes = notes;
        const encoded = bwRun(['encode'], { input: JSON.stringify(updated) }).trim();
        bwRun(['edit', 'item', itemObj.id], { input: encoded, env: sessionEnv(sessionToken) });
        logger.info(`Bitwarden updated: ${itemObj.name}${name !== undefined ? ` → ${name}` : ''}`);
        Object.assign(itemObj, updated);
    } catch (error) {
        throw new BitwardenError(`Failed to update item "${itemObj.name}": ${error.message}`);
    }
}

module.exports = { assertBitwardenAuthConfigured, getSessionToken, syncVault, loadVaultCache, getCachedItem, searchItem, createItem, updateItemPassword, updateItemFields };
