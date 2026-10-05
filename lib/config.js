'use strict';

require('dotenv').config();
const path = require('path');
const { ConfigError } = require('./errors');

const ROOT = path.resolve(__dirname, '..');

function optional(name, defaultValue) {
    const v = process.env[name];
    return v === undefined || v === '' ? defaultValue : v;
}

function bool(name, defaultValue) {
    const v = optional(name, defaultValue ? 'true' : 'false').toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
}

function positiveInt(name, defaultValue, { min = 1 } = {}) {
    const raw = optional(name, String(defaultValue));
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < min) {
        throw new ConfigError(`${name} must be an integer >= ${min} (got "${raw}")`);
    }
    return n;
}

function oneOf(name, defaultValue, allowed) {
    const v = optional(name, defaultValue).toLowerCase();
    if (!allowed.includes(v)) {
        throw new ConfigError(`${name} must be one of: ${allowed.join(', ')} (got "${v}")`);
    }
    return v;
}

// Input/output files resolve against the working directory (where .env is also read
// from), so `npm run …` from the project root and `npx vaultsmith …` from any folder agree.
function pathFromCwd(name, defaultValue) {
    return path.resolve(process.cwd(), optional(name, defaultValue));
}

const config = Object.freeze({
    ROOT,

    // ── Bitwarden ──────────────────────────────────────────────────────────
    // Auth is validated lazily by bw.getSessionToken() (see lib/bitwarden.js) so that
    // this module can be imported without a configured vault (e.g. in tests).
    BW_SESSION_ID:      process.env.BW_SESSION_ID || null,
    BW_CLIENT_ID:       process.env.BW_CLIENT_ID || null,
    BW_CLIENT_SECRET:   process.env.BW_CLIENT_SECRET || null,
    BW_MASTER_PASSWORD: process.env.BW_MASTER_PASSWORD || null,
    BW_ORG_ID:          process.env.BW_ORG_ID || null,
    // Plain "bw" is resolved via PATH, which works on Linux, macOS (Intel + Apple Silicon) and Windows.
    BW_CLI_PATH:        optional('BW_CLI_PATH', 'bw'),

    // ── Input / output files (resolved relative to the working directory) ──
    CREDENTIALS_FILE:         pathFromCwd('CREDENTIALS_FILE',         'assets/creds.json'),
    UPDATE_PASSWORDS_FILE:    pathFromCwd('UPDATE_PASSWORDS_FILE',    'assets/updatepasswords.json'),
    SEARCH_ADMINS_FILE:       pathFromCwd('SEARCH_ADMINS_FILE',       'assets/searchadmins.txt'),
    SEARCH_NAMES_FILE:        pathFromCwd('SEARCH_NAMES_FILE',        'assets/searchnames.txt'),
    LOGIN_CHECKER_FILE:       pathFromCwd('LOGIN_CHECKER_FILE',       'assets/logincheckerusers.txt'),
    PASSWORD_CHANGER_FILE:    pathFromCwd('PASSWORD_CHANGER_FILE',    'assets/passwordchangers.txt'),
    ADMIN_ACCOUNTS_FILE:      pathFromCwd('ADMIN_ACCOUNTS_FILE',      'assets/admin_accounts.txt'),
    USER_GROUPS_FILE:         pathFromCwd('USER_GROUPS_FILE',         'assets/usergroups.txt'),
    CREATE_USERS_OUTPUT_FILE: pathFromCwd('CREATE_USERS_OUTPUT_FILE', 'assets/createdusers.json'),
    // change-passwords: if the vault write-back fails AFTER the instance password was
    // changed, the new password is appended here (mode 0600) so it is never lost.
    ROTATION_RECOVERY_FILE:   pathFromCwd('ROTATION_RECOVERY_FILE',   'assets/rotation-recovery.jsonl'),

    // ── create-users: the user to provision ────────────────────────────────
    NEW_USER_USERNAME:      optional('NEW_USER_USERNAME',  'service_user'),
    NEW_USER_FIRSTNAME:     optional('NEW_USER_FIRSTNAME', 'Service'),
    NEW_USER_LASTNAME:      optional('NEW_USER_LASTNAME',  'User'),
    NEW_USER_EMAIL:         optional('NEW_USER_EMAIL',     ''),
    NEW_USER_LANGUAGE:      optional('NEW_USER_LANGUAGE',  'en'),
    NEW_USER_COLLECTION_ID: process.env.NEW_USER_COLLECTION_ID || null,
    // Optional middle segment in the emitted Bitwarden item name:
    // "<First> <Last> – <customer>" or "<First> <Last> – <VENDOR_LABEL> – <customer>".
    VENDOR_LABEL:           process.env.VENDOR_LABEL || null,
    // JSON template for the create-user request body. See templates/create-user.json.
    // (the default is the one shipped inside the package)
    CREATE_USER_TEMPLATE_FILE: process.env.CREATE_USER_TEMPLATE_FILE
        ? path.resolve(process.cwd(), process.env.CREATE_USER_TEMPLATE_FILE)
        : path.join(ROOT, 'templates', 'create-user.json'),

    // ── search-users ───────────────────────────────────────────────────────
    // Comma-separated email domains used to generate address variants.
    EMAIL_DOMAINS: (process.env.EMAIL_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean),

    // ── API endpoint paths (relative to each instance's base URL) ──────────
    // {userId} / {entityId} are substituted at call time.
    ENDPOINTS: {
        AUTH_LOGIN:           optional('AUTH_LOGIN_PATH',           '/authentication/login'),
        AUTH_CHANGE_PASSWORD: optional('AUTH_CHANGE_PASSWORD_PATH', '/authentication/change-password'),
        USERS:                optional('API_USERS_PATH',            '/acl-api/users'),
        USER_BY_ID:           optional('API_USER_BY_ID_PATH',       '/acl-api/users/{userId}'),
        USER_GROUPS:          optional('API_USER_GROUPS_PATH',      '/acl-api/users/groups/{entityId}'),
        GROUPS:               optional('API_GROUPS_PATH',           '/acl-api/groups'),
        REGIONS:              optional('API_REGIONS_PATH',          '/acl-api/regions'),
        SALES_REGIONS:        optional('API_SALESREGIONS_PATH',     '/acl-api/salesregions'),
        PERMISSIONS:          optional('API_PERMISSIONS_PATH',      '/acl-api/permissions'),
    },

    // ── API contract: how to log in ────────────────────────────────────────
    //   header (default): AUTH_HEADER_NAME: base64("user:pass")
    //   basic:            Authorization: Basic base64("user:pass")
    //   json:             JSON body { AUTH_USERNAME_FIELD, AUTH_PASSWORD_FIELD }
    AUTH_MODE:           oneOf('AUTH_MODE', 'header', ['header', 'basic', 'json']),
    AUTH_METHOD:         optional('AUTH_METHOD', 'POST').toUpperCase(),
    AUTH_HEADER_NAME:    optional('AUTH_HEADER_NAME', 'form-content'),
    AUTH_USERNAME_FIELD: optional('AUTH_USERNAME_FIELD', 'username'),
    AUTH_PASSWORD_FIELD: optional('AUTH_PASSWORD_FIELD', 'password'),
    // Where to find the token (and user id) in the login response body.
    // Dot paths are supported, e.g. "data.token".
    AUTH_TOKEN_FIELD:    optional('AUTH_TOKEN_FIELD',   'access_token'),
    AUTH_USER_ID_FIELD:  optional('AUTH_USER_ID_FIELD', 'user_id'),

    // ── API contract: how to present the token on authenticated calls ──────
    //   cookie (default): Cookie: <TOKEN_NAME>=<token>
    //   bearer:           Authorization: Bearer <token>
    //   header:           <TOKEN_NAME>: <token>
    TOKEN_TRANSPORT: oneOf('TOKEN_TRANSPORT', 'cookie', ['cookie', 'bearer', 'header']),
    TOKEN_NAME:      optional('TOKEN_NAME', 'access_token'),

    // ── API contract: change-password request ──────────────────────────────
    CHANGE_PASSWORD_METHOD:    optional('CHANGE_PASSWORD_METHOD', 'POST').toUpperCase(),
    CHANGE_PASSWORD_OLD_FIELD: optional('CHANGE_PASSWORD_OLD_FIELD', 'old_password'),
    CHANGE_PASSWORD_NEW_FIELD: optional('CHANGE_PASSWORD_NEW_FIELD', 'new_password'),
    CHANGE_PASSWORD_ENCODING:  oneOf('CHANGE_PASSWORD_ENCODING', 'base64', ['base64', 'plain']),

    // ── API contract: response shapes ──────────────────────────────────────
    // If a list endpoint wraps its array (e.g. { "users": [...] }) name the key; empty = bare array.
    USERS_RESPONSE_KEY:  optional('USERS_RESPONSE_KEY', ''),
    GROUPS_RESPONSE_KEY: optional('GROUPS_RESPONSE_KEY', ''),
    // Field names on user / group objects.
    USER_FIELD_ID:        optional('USER_FIELD_ID',        'id'),
    USER_FIELD_USERNAME:  optional('USER_FIELD_USERNAME',  'username'),
    USER_FIELD_EMAIL:     optional('USER_FIELD_EMAIL',     'email'),
    USER_FIELD_FIRSTNAME: optional('USER_FIELD_FIRSTNAME', 'firstName'),
    USER_FIELD_LASTNAME:  optional('USER_FIELD_LASTNAME',  'lastName'),
    GROUP_FIELD_ID:       optional('GROUP_FIELD_ID',       'id'),
    GROUP_FIELD_NAME:     optional('GROUP_FIELD_NAME',     'name'),

    // ── Tuning ─────────────────────────────────────────────────────────────
    BATCH_SIZE:       positiveInt('BATCH_SIZE', 5),
    BATCH_DELAY_MS:   positiveInt('BATCH_DELAY_MS', 0, { min: 0 }),
    MAX_RETRIES:      positiveInt('MAX_RETRIES', 3, { min: 0 }),
    REQUEST_TIMEOUT_MS: positiveInt('REQUEST_TIMEOUT_MS', 30000),
    LOG_LEVEL:        optional('LOG_LEVEL', 'info'),

    // ── Feature flags (mutating operations are OFF by default) ─────────────
    ENABLE_PASSWORD_CHANGE: bool('ENABLE_PASSWORD_CHANGE', false),
    ENABLE_USER_CREATION:   bool('ENABLE_USER_CREATION',   false),

    // create-users permission model:
    //   ENABLE_PERMISSIONS=false     → don't call the permissions endpoint at all
    //   ENABLE_REGION_SCOPING=false  → grant serviceArea "all" with NO region/location datasource
    ENABLE_PERMISSIONS:    bool('ENABLE_PERMISSIONS',    true),
    ENABLE_REGION_SCOPING: bool('ENABLE_REGION_SCOPING', true),
});

module.exports = config;
