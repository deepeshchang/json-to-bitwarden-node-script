'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFresh } = require('../testsupport/load');
const { startMockApi } = require('../testsupport/mock-api');

const BASE = { BW_SESSION_ID: 'x', LOG_LEVEL: 'error', REQUEST_TIMEOUT_MS: '2000' };
const b64 = s => Buffer.from(s).toString('base64');

async function withApi(env, handler, fn) {
    const mod = loadFresh({ ...BASE, ...env });
    const mock = await startMockApi(handler);
    try { await fn({ ...mod, mock, fetch: globalThis.fetch }); } finally { await mock.close(); }
}

test('default contract: base64 form-content login, cookie token, default paths', async () => {
    await withApi({}, req => {
        if (req.url === '/authentication/login') return { json: { access_token: 'T1', user_id: 'u1' } };
        return { json: [{ id: '1', username: 'bob' }] };
    }, async ({ api, mock, fetch }) => {
        const auth = await api.authenticateFull(fetch, mock.url, 'admin', 'pa:ss');
        assert.deepEqual(auth, { access_token: 'T1', user_id: 'u1' });
        assert.equal(mock.requests[0].method, 'POST');
        assert.equal(mock.requests[0].headers['form-content'], b64('admin:pa:ss'));

        const users = await api.listUsers(fetch, mock.url, 'T1');
        assert.equal(users[0].username, 'bob');
        assert.equal(mock.requests[1].url, '/acl-api/users');
        assert.equal(mock.requests[1].headers.cookie, 'access_token=T1');
    });
});

test('AUTH_MODE=basic sends a standard Authorization: Basic header', async () => {
    await withApi({ AUTH_MODE: 'basic' }, () => ({ json: { access_token: 'T' } }), async ({ api, mock, fetch }) => {
        await api.authenticate(fetch, mock.url, 'u', 'p');
        assert.equal(mock.requests[0].headers.authorization, `Basic ${b64('u:p')}`);
        assert.equal(mock.requests[0].headers['form-content'], undefined);
    });
});

test('AUTH_MODE=json posts credentials in a JSON body with configurable field names', async () => {
    await withApi({ AUTH_MODE: 'json', AUTH_USERNAME_FIELD: 'email', AUTH_PASSWORD_FIELD: 'pwd' },
        () => ({ json: { access_token: 'T' } }), async ({ api, mock, fetch }) => {
            await api.authenticate(fetch, mock.url, 'a@b.c', 'secret');
            assert.deepEqual(JSON.parse(mock.requests[0].body), { email: 'a@b.c', pwd: 'secret' });
            assert.match(mock.requests[0].headers['content-type'], /application\/json/);
        });
});

test('custom header name, token field (dot path) and method', async () => {
    await withApi({ AUTH_HEADER_NAME: 'x-creds', AUTH_TOKEN_FIELD: 'data.token', AUTH_USER_ID_FIELD: 'data.id', AUTH_METHOD: 'put' },
        () => ({ json: { data: { token: 'DEEP', id: 42 } } }), async ({ api, mock, fetch }) => {
            const auth = await api.authenticateFull(fetch, mock.url, 'u', 'p');
            assert.deepEqual(auth, { access_token: 'DEEP', user_id: 42 });
            assert.equal(mock.requests[0].method, 'PUT');
            assert.equal(mock.requests[0].headers['x-creds'], b64('u:p'));
        });
});

test('TOKEN_TRANSPORT=bearer and =header', async () => {
    await withApi({ TOKEN_TRANSPORT: 'bearer' }, () => ({ json: [] }), async ({ api, mock, fetch }) => {
        await api.listUsers(fetch, mock.url, 'TOK');
        assert.equal(mock.requests[0].headers.authorization, 'Bearer TOK');
        assert.equal(mock.requests[0].headers.cookie, undefined);
    });
    await withApi({ TOKEN_TRANSPORT: 'header', TOKEN_NAME: 'X-Auth' }, () => ({ json: [] }), async ({ api, mock, fetch }) => {
        await api.listUsers(fetch, mock.url, 'TOK');
        assert.equal(mock.requests[0].headers['x-auth'], 'TOK');
    });
});

test('custom paths, {placeholders} and a base path on the instance URL', async () => {
    await withApi({ API_USERS_PATH: '/v2/people', API_USER_BY_ID_PATH: '/v2/people/{userId}/profile' },
        () => ({ json: [] }), async ({ api, mock, fetch }) => {
            const base = `${api.cleanDomain(`${mock.url}/tenant-a/`)}`;
            assert.equal(base, `${mock.url}/tenant-a`);
            await api.listUsers(fetch, base, 'T');
            await api.getUserById(fetch, base, 'T', 'a b/c');
            assert.equal(mock.requests[0].url, '/tenant-a/v2/people');
            assert.equal(mock.requests[1].url, '/tenant-a/v2/people/a%20b%2Fc/profile');
        });
});

test('USERS_RESPONSE_KEY unwraps an enveloped list', async () => {
    await withApi({ USERS_RESPONSE_KEY: 'data.users' }, () => ({ json: { data: { users: [{ id: 1 }] } } }), async ({ api, mock, fetch }) => {
        assert.deepEqual(await api.listUsers(fetch, mock.url, 'T'), [{ id: 1 }]);
    });
});

test('changePassword: default is base64 old_password/new_password', async () => {
    await withApi({}, () => ({ json: {} }), async ({ api, mock, fetch }) => {
        assert.equal(await api.changePassword(fetch, mock.url, 'T', 'old', 'new'), true);
        assert.deepEqual(JSON.parse(mock.requests[0].body), { old_password: b64('old'), new_password: b64('new') });
        assert.equal(mock.requests[0].url, '/authentication/change-password');
    });
});

test('changePassword: plain encoding, custom fields and method', async () => {
    await withApi({ CHANGE_PASSWORD_ENCODING: 'plain', CHANGE_PASSWORD_OLD_FIELD: 'current', CHANGE_PASSWORD_NEW_FIELD: 'next', CHANGE_PASSWORD_METHOD: 'patch' },
        () => ({ json: {} }), async ({ api, mock, fetch }) => {
            await api.changePassword(fetch, mock.url, 'T', 'old', 'new');
            assert.equal(mock.requests[0].method, 'PATCH');
            assert.deepEqual(JSON.parse(mock.requests[0].body), { current: 'old', next: 'new' });
        });
});

test('error classification: 401 is final, 5xx is retryable, missing token is an error', async () => {
    await withApi({}, () => ({ status: 401 }), async ({ api, mock, fetch }) => {
        await assert.rejects(api.authenticate(fetch, mock.url, 'u', 'p'), e => e.status === 401 && e.retryable === false);
        assert.equal(await api.checkLoginStatus(fetch, mock.url, 'u', 'p'), 401);
    });
    await withApi({}, () => ({ status: 503 }), async ({ api, mock, fetch }) => {
        await assert.rejects(api.authenticate(fetch, mock.url, 'u', 'p'), e => e.retryable === true);
    });
    await withApi({}, () => ({ json: { nothing: true } }), async ({ api, mock, fetch }) => {
        await assert.rejects(api.authenticate(fetch, mock.url, 'u', 'p'), /No "access_token"/);
    });
});

test('network errors are retryable, except for change-password where the outcome is ambiguous', async () => {
    const { api, errors } = loadFresh({ ...BASE, REQUEST_TIMEOUT_MS: '500' });
    const dead = 'http://127.0.0.1:1';
    await assert.rejects(api.listUsers(globalThis.fetch, dead, 'T'), e => e instanceof errors.ApiError && e.retryable === true);
    await assert.rejects(api.changePassword(globalThis.fetch, dead, 'T', 'a', 'b'),
        e => e instanceof errors.ApiError && e.retryable === false && /outcome unknown/.test(e.message));
});

test('createUser returns the status (409 stays distinguishable) and sends the rendered body', async () => {
    await withApi({}, () => ({ status: 409 }), async ({ api, mock, fetch }) => {
        assert.equal(await api.createUser(fetch, mock.url, 'T', { username: 'svc' }), 409);
        assert.deepEqual(JSON.parse(mock.requests[0].body), { username: 'svc' });
    });
});
