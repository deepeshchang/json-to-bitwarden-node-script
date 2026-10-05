'use strict';

// Loads lib modules fresh under a controlled environment, so each test can exercise
// a different config without leaking into the next — and without a developer's real
// .env (dotenv reads from cwd) influencing results.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const MANAGED = /^(BW_|AUTH_|API_|TOKEN_|CHANGE_PASSWORD_|USER_FIELD_|GROUP_FIELD_|USERS_RESPONSE_|GROUPS_RESPONSE_|NEW_USER_|ENABLE_|BATCH_|MAX_RETRIES|REQUEST_TIMEOUT|LOG_LEVEL|EMAIL_DOMAINS|VENDOR_LABEL|ROTATION_|CREATE_|CREDENTIALS_|UPDATE_|SEARCH_|LOGIN_CHECKER|PASSWORD_CHANGER|ADMIN_ACCOUNTS|USER_GROUPS)/;

function cleanEnv(env = {}) {
    for (const key of Object.keys(process.env)) if (MANAGED.test(key)) delete process.env[key];
    Object.assign(process.env, env);
}

function loadFresh(env = {}) {
    cleanEnv(env);
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(path.join(ROOT, 'lib') + path.sep)) delete require.cache[key];
    }
    const cwd = process.cwd();
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'vaultsmith-cwd-')));
    try {
        return {
            config: require('../lib/config'),
            api: require('../lib/api'),
            bw: require('../lib/bitwarden'),
            utils: require('../lib/utils'),
            errors: require('../lib/errors'),
        };
    } finally {
        process.chdir(cwd);
    }
}

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'vaultsmith-'));
}

module.exports = { loadFresh, cleanEnv, tmpDir, ROOT };
