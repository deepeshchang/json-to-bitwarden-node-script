'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadFresh, ROOT } = require('../testsupport/load');

test('defaults match the documented reference contract', () => {
    const { config } = loadFresh({ BW_SESSION_ID: 'x' });
    assert.equal(config.BW_CLI_PATH, 'bw');
    assert.equal(config.AUTH_MODE, 'header');
    assert.equal(config.AUTH_HEADER_NAME, 'form-content');
    assert.equal(config.TOKEN_TRANSPORT, 'cookie');
    assert.equal(config.ENDPOINTS.AUTH_LOGIN, '/authentication/login');
    assert.equal(config.ENABLE_PASSWORD_CHANGE, false);
    assert.equal(config.ENABLE_USER_CREATION, false);
    assert.ok(path.isAbsolute(config.CREDENTIALS_FILE));
    assert.ok(config.CREDENTIALS_FILE.endsWith(path.join('assets', 'creds.json')));
    assert.equal(config.CREATE_USER_TEMPLATE_FILE, path.join(ROOT, 'templates', 'create-user.json'));
});

test('importing config never exits the process when Bitwarden auth is unset', () => {
    assert.doesNotThrow(() => loadFresh({}));
});

test('getSessionToken explains missing Bitwarden auth', async () => {
    const { bw, errors } = loadFresh({});
    await assert.rejects(bw.getSessionToken(), errors.ConfigError);
});

test('every endpoint path is overridable via env', () => {
    const { config } = loadFresh({
        AUTH_LOGIN_PATH: '/v2/login', AUTH_CHANGE_PASSWORD_PATH: '/v2/pw', API_USERS_PATH: '/v2/users',
        API_USER_BY_ID_PATH: '/v2/users/{userId}', API_USER_GROUPS_PATH: '/v2/ug/{entityId}',
        API_GROUPS_PATH: '/v2/groups', API_REGIONS_PATH: '/v2/regions', API_SALESREGIONS_PATH: '/v2/sr',
        API_PERMISSIONS_PATH: '/v2/perm',
    });
    assert.deepEqual(config.ENDPOINTS, {
        AUTH_LOGIN: '/v2/login', AUTH_CHANGE_PASSWORD: '/v2/pw', USERS: '/v2/users',
        USER_BY_ID: '/v2/users/{userId}', USER_GROUPS: '/v2/ug/{entityId}', GROUPS: '/v2/groups',
        REGIONS: '/v2/regions', SALES_REGIONS: '/v2/sr', PERMISSIONS: '/v2/perm',
    });
});

test('invalid values are rejected with a clear message', () => {
    assert.throws(() => loadFresh({ AUTH_MODE: 'kerberos' }), /AUTH_MODE must be one of/);
    assert.throws(() => loadFresh({ TOKEN_TRANSPORT: 'smoke' }), /TOKEN_TRANSPORT/);
    assert.throws(() => loadFresh({ BATCH_SIZE: '0' }), /BATCH_SIZE/);
    assert.throws(() => loadFresh({ MAX_RETRIES: 'abc' }), /MAX_RETRIES/);
});

test('boolean flags accept true/1/yes (case-insensitive) and nothing else', () => {
    assert.equal(loadFresh({ ENABLE_PASSWORD_CHANGE: 'TRUE' }).config.ENABLE_PASSWORD_CHANGE, true);
    assert.equal(loadFresh({ ENABLE_PASSWORD_CHANGE: '1' }).config.ENABLE_PASSWORD_CHANGE, true);
    assert.equal(loadFresh({ ENABLE_PASSWORD_CHANGE: 'maybe' }).config.ENABLE_PASSWORD_CHANGE, false);
});
