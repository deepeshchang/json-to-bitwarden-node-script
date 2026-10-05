'use strict';

// End-to-end: runs the real scripts as child processes against a fake `bw` CLI and a
// local mock API, exercising config → vault → HTTP → vault write-back wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir, ROOT } = require('../testsupport/load');
const { startMockApi } = require('../testsupport/mock-api');

const FAKE_BW = path.join(ROOT, 'testsupport', 'fake-bw.js');
const b64 = s => Buffer.from(s).toString('base64');

function run(script, env, input = '') {
    return new Promise(resolve => {
        const cwd = tmpDir(); // no stray .env is picked up from here
        const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script)], {
            cwd,
            env: { PATH: process.env.PATH, BW_SESSION_ID: 'SESSION', BW_CLI_PATH: FAKE_BW, LOG_LEVEL: 'info', ...env },
        });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        child.on('close', code => resolve({ code, out }));
        child.stdin.end(input);
    });
}

function fixture(mockUrl, names = ['Svc - One']) {
    const dir = tmpDir();
    const items = path.join(dir, 'items.json');
    fs.writeFileSync(items, JSON.stringify(names.map((name, i) => ({
        id: `id-${i}`, name,
        login: { username: 'svc', password: 'old-pass', uris: [{ uri: `${mockUrl}/` }] }, notes: '',
    }))));
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, `# comment\n${names.join('\n')}\n`);
    const log = path.join(dir, 'bw.log');
    const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').map(l => JSON.parse(l)) : [];
    return { dir, items, list, log, calls, env: { FAKE_BW_ITEMS: items, FAKE_BW_LOG: log } };
}

test('check-logins: reports pass/fail per instance', async () => {
    const mock = await startMockApi(() => ({ json: { access_token: 'T' } }));
    try {
        const fx = fixture(mock.url);
        const { code, out } = await run('loginchecker.js', { ...fx.env, LOGIN_CHECKER_FILE: fx.list });
        assert.equal(code, 0, out);
        assert.match(out, /Passed \(200\)\s*: 1/);
        assert.equal(mock.requests[0].headers['form-content'], b64('svc:old-pass'));
    } finally { await mock.close(); }
});

test('check-api-access: login then authenticated probe using configured contract', async () => {
    const mock = await startMockApi(req => req.url.startsWith('/login')
        ? { json: { data: { token: 'T', id: 'u9' } } } : { json: {} });
    try {
        const fx = fixture(mock.url);
        const { code, out } = await run('checkapiaccess.js', { ...fx.env, LOGIN_CHECKER_FILE: fx.list,
            AUTH_LOGIN_PATH: '/login', AUTH_TOKEN_FIELD: 'data.token', AUTH_USER_ID_FIELD: 'data.id',
            API_USER_BY_ID_PATH: '/people/{userId}', TOKEN_TRANSPORT: 'bearer' });
        assert.equal(code, 0, out);
        assert.match(out, /Passed \(login\+api\): 1/);
        assert.equal(mock.requests[1].url, '/people/u9');
        assert.equal(mock.requests[1].headers.authorization, 'Bearer T');
    } finally { await mock.close(); }
});

test('change-passwords: dry run authenticates but changes nothing', async () => {
    const mock = await startMockApi(() => ({ json: { access_token: 'T' } }));
    try {
        const fx = fixture(mock.url);
        const { code, out } = await run('bulkpasswordchanger.js', { ...fx.env, PASSWORD_CHANGER_FILE: fx.list });
        assert.equal(code, 0, out);
        assert.match(out, /DRY RUN/);
        assert.equal(mock.requests.length, 1); // login only
        assert.equal(fx.calls().filter(c => c.args[0] === 'edit').length, 0);
    } finally { await mock.close(); }
});

test('change-passwords: live run rotates on the instance and writes the SAME password to the vault', async () => {
    const mock = await startMockApi(() => ({ json: { access_token: 'T' } }));
    try {
        const fx = fixture(mock.url);
        const { code, out } = await run('bulkpasswordchanger.js', { ...fx.env, PASSWORD_CHANGER_FILE: fx.list, ENABLE_PASSWORD_CHANGE: 'true' });
        assert.equal(code, 0, out);
        assert.match(out, /Password changed\s*: 1/);

        const change = mock.requests.find(r => r.url === '/authentication/change-password');
        const body = JSON.parse(change.body);
        assert.equal(Buffer.from(body.old_password, 'base64').toString(), 'old-pass');
        const newPw = Buffer.from(body.new_password, 'base64').toString();
        assert.equal(newPw.length, 24);

        const edit = fx.calls().find(c => c.args[0] === 'edit');
        const saved = JSON.parse(Buffer.from(edit.stdin, 'base64').toString());
        assert.equal(saved.login.password, newPw);
        assert.ok(!out.includes(newPw), 'new password must not appear in output');
    } finally { await mock.close(); }
});

test('change-passwords: vault failure after rotation saves the new password to a 0600 recovery file', async () => {
    const mock = await startMockApi(() => ({ json: { access_token: 'T' } }));
    try {
        const fx = fixture(mock.url);
        const recovery = path.join(fx.dir, 'recovery.jsonl');
        const { code, out } = await run('bulkpasswordchanger.js', { ...fx.env, PASSWORD_CHANGER_FILE: fx.list,
            ENABLE_PASSWORD_CHANGE: 'true', FAKE_BW_FAIL: 'edit', ROTATION_RECOVERY_FILE: recovery });
        assert.equal(code, 0, out);
        assert.match(out, /Bitwarden update fail\s*: 1/);
        assert.match(out, /WAS changed/);

        const change = JSON.parse(mock.requests.find(r => r.url.endsWith('change-password')).body);
        const record = JSON.parse(fs.readFileSync(recovery, 'utf-8').trim());
        assert.equal(record.newPassword, Buffer.from(change.new_password, 'base64').toString());
        assert.equal(fs.statSync(recovery).mode & 0o777, 0o600);
        assert.equal(fx.calls().filter(c => c.args[0] === 'edit').length, 3); // 3 attempts
    } finally { await mock.close(); }
});

test('search-users: matches by generated variants using configured field names', async () => {
    const mock = await startMockApi(req => req.url === '/authentication/login'
        ? { json: { access_token: 'T' } }
        : { json: { items: [
            { uid: '1', login: 'john.smith', mail: 'x@y.z', given: 'John', family: 'Smith' },
            { uid: '2', login: 'nobody', mail: 'n@y.z', given: 'No', family: 'Body' },
        ] } });
    try {
        const fx = fixture(mock.url);
        const names = path.join(fx.dir, 'names.txt');
        fs.writeFileSync(names, 'John Smith\n');
        const { code, out } = await run('searchuser.js', { ...fx.env, SEARCH_ADMINS_FILE: fx.list, SEARCH_NAMES_FILE: names,
            USERS_RESPONSE_KEY: 'items', USER_FIELD_USERNAME: 'login', USER_FIELD_EMAIL: 'mail',
            USER_FIELD_FIRSTNAME: 'given', USER_FIELD_LASTNAME: 'family' });
        assert.equal(code, 0, out);
        assert.match(out, /Matched users\s*: 1/);
        assert.match(out, /John Smith \| x@y\.z \| john\.smith/);
    } finally { await mock.close(); }
});

test('create-users: live run renders the template, grants permissions, verifies login and writes creds 0600', async () => {
    let created = null;
    const mock = await startMockApi(req => {
        if (req.url === '/authentication/login') return { json: { access_token: 'T', user_id: 'u' } };
        if (req.url === '/acl-api/groups') return { json: [{ id: 'g1', name: 'Example Administrator' }, { id: 'g2', name: 'Other' }] };
        if (req.url === '/acl-api/regions') return { json: [{ _id: 'r1', name: 'R', sales_region: ['s1'] }] };
        if (req.url === '/acl-api/salesregions') return { json: { salesRegions: [{ _id: 's1' }] } };
        if (req.url === '/acl-api/users' && req.method === 'POST') { created = JSON.parse(req.body); return { status: 201 }; }
        if (req.url === '/acl-api/users') return { json: created ? [{ id: 'new-1', username: created.username }] : [] };
        if (req.url === '/acl-api/permissions') return { json: {} };
        if (req.url === '/acl-api/users/groups/new-1') return { json: [] };
        return { status: 404 };
    });
    try {
        const fx = fixture(mock.url, ['Admin - Acme - CustomerA']);
        const groups = path.join(fx.dir, 'groups.txt');
        fs.writeFileSync(groups, 'example administrator\nNot On Instance\n');
        const output = path.join(fx.dir, 'created.json');
        const { code, out } = await run('createusers.js', { ...fx.env, ADMIN_ACCOUNTS_FILE: fx.list, USER_GROUPS_FILE: groups,
            CREATE_USERS_OUTPUT_FILE: output, ENABLE_USER_CREATION: 'true', NEW_USER_COLLECTION_ID: 'col-1',
            VENDOR_LABEL: 'Acme' }, 'n\n');
        assert.equal(code, 0, out);
        assert.match(out, /Users created\s*: 1/);
        assert.match(out, /groups not found on instance: not on instance/);

        assert.equal(created.username, 'service_user');
        assert.equal(created.attributes.group_id, '["g1"]');
        assert.equal(created.credentials[0].value.length, 24);

        const perm = JSON.parse(mock.requests.find(r => r.url === '/acl-api/permissions').body);
        assert.deepEqual(perm.permissions[0], {
            entityId: 'new-1', serviceArea: ['all'],
            datasource: [{ region: 'r1', salesRegions: [{ salesRegion: 's1', locations: ['all'] }] }],
        });

        const creds = JSON.parse(fs.readFileSync(output, 'utf-8'));
        assert.equal(creds[0].name, 'Service User – Acme – CustomerA');
        assert.equal(creds[0].password, created.credentials[0].value);
        assert.deepEqual(creds[0].collection_ids, ['col-1']);
        assert.equal(fs.statSync(output).mode & 0o777, 0o600);
        assert.match(out, /Verified : 1/);
    } finally { await mock.close(); }
});

test('create-users: dry run makes no create/permission calls and writes nothing', async () => {
    const mock = await startMockApi(req => {
        if (req.url === '/authentication/login') return { json: { access_token: 'T' } };
        if (req.url === '/acl-api/groups') return { json: [{ id: 'g1', name: 'Example Administrator' }] };
        return { json: [] };
    });
    try {
        const fx = fixture(mock.url, ['Admin - Acme - CustomerA']);
        const groups = path.join(fx.dir, 'groups.txt');
        fs.writeFileSync(groups, 'Example Administrator\n');
        const output = path.join(fx.dir, 'created.json');
        const { code, out } = await run('createusers.js', { ...fx.env, ADMIN_ACCOUNTS_FILE: fx.list, USER_GROUPS_FILE: groups, CREATE_USERS_OUTPUT_FILE: output });
        assert.equal(code, 0, out);
        assert.match(out, /DRY RUN/);
        assert.equal(mock.requests.filter(r => r.method === 'POST' && r.url !== '/authentication/login').length, 0);
        assert.equal(fs.existsSync(output), false);
    } finally { await mock.close(); }
});

test('add-credentials: skips names already in the vault, requires BW_ORG_ID', async () => {
    const fx = fixture('http://unused.example', ['Existing Item']);
    const creds = path.join(fx.dir, 'creds.json');
    fs.writeFileSync(creds, JSON.stringify([
        { name: 'existing item', username: 'u', password: 'p', collection_ids: ['c'] },
        { name: 'Brand New', username: 'u', password: 'p', collection_ids: ['c'] },
    ]));

    const noOrg = await run('addcredentials.js', { ...fx.env, CREDENTIALS_FILE: creds });
    assert.equal(noOrg.code, 1);
    assert.match(noOrg.out, /BW_ORG_ID is required/);

    const { code, out } = await run('addcredentials.js', { ...fx.env, CREDENTIALS_FILE: creds, BW_ORG_ID: 'org' });
    assert.equal(code, 0, out);
    assert.match(out, /Added\s*: 1/);
    assert.match(out, /Skipped \(duplicate\): 1/);
});

test('missing input file and missing Bitwarden auth give actionable errors', async () => {
    const empty = path.join(tmpDir(), 'items.json');
    fs.writeFileSync(empty, '[]');
    const a = await run('loginchecker.js', { LOGIN_CHECKER_FILE: '/nonexistent/list.txt', FAKE_BW_ITEMS: empty });
    assert.equal(a.code, 1);
    assert.match(a.out, /Input file not found/);

    const b = await run('loginchecker.js', { BW_SESSION_ID: '' });
    assert.equal(b.code, 1);
    assert.match(b.out, /Bitwarden authentication not configured/);
});
