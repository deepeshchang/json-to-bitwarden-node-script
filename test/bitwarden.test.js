'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadFresh, tmpDir, ROOT } = require('../testsupport/load');

const FAKE_BW = path.join(ROOT, 'testsupport', 'fake-bw.js');

function setup(extraEnv = {}) {
    const dir = tmpDir();
    const log = path.join(dir, 'bw.log');
    const items = path.join(dir, 'items.json');
    fs.writeFileSync(items, JSON.stringify([
        { id: 'id-1', name: 'Service - Prod', login: { username: 'svc', password: 'old', uris: [{ uri: 'https://x.example' }] }, notes: '' },
    ]));
    const mod = loadFresh({ BW_SESSION_ID: 'SESSION', BW_CLI_PATH: FAKE_BW, LOG_LEVEL: 'error', BW_ORG_ID: 'org-1',
        FAKE_BW_LOG: log, FAKE_BW_ITEMS: items, ...extraEnv });
    const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').map(l => JSON.parse(l)) : [];
    return { ...mod, dir, calls };
}

test('loadVaultCache: case-insensitive lookup', () => {
    const { bw } = setup();
    const cache = bw.loadVaultCache('SESSION');
    assert.equal(bw.getCachedItem(cache, '  service - prod ').id, 'id-1');
    assert.equal(bw.getCachedItem(cache, 'missing'), null);
});

test('updateItemFields: secrets with shell metacharacters are passed as data, never to a shell', () => {
    const { bw, calls, dir } = setup();
    const cache = bw.loadVaultCache('SESSION');
    const item = bw.getCachedItem(cache, 'Service - Prod');
    const nasty = `p"a'ss$(touch ${path.join(dir, 'PWNED')}); \`id\` | rm -rf / #`;

    bw.updateItemPassword('SESSION', item, nasty);

    const edit = calls().find(c => c.args[0] === 'edit');
    assert.deepEqual(edit.args, ['edit', 'item', 'id-1']);
    const sent = JSON.parse(Buffer.from(edit.stdin, 'base64').toString());
    assert.equal(sent.login.password, nasty);
    assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
    assert.equal(item.login.password, nasty); // cache updated after success
});

test('updateItemFields: a failed write leaves the cached item untouched', () => {
    const { bw, errors } = setup({ FAKE_BW_FAIL: 'edit' });
    const item = bw.getCachedItem(bw.loadVaultCache('SESSION'), 'Service - Prod');
    assert.throws(() => bw.updateItemFields('SESSION', item, { password: 'new', name: 'Renamed' }), errors.BitwardenError);
    assert.equal(item.login.password, 'old');
    assert.equal(item.name, 'Service - Prod');
});

test('createItem: builds an org item with collections and uris', () => {
    const { bw, calls } = setup();
    bw.createItem('SESSION', { name: 'N', username: 'u', password: 'p', collection_id: 'c1', uri: 'https://a.example', notes: 'hi' });
    const create = calls().find(c => c.args[0] === 'create');
    const item = JSON.parse(Buffer.from(create.stdin, 'base64').toString());
    assert.equal(item.organizationId, 'org-1');
    assert.deepEqual(item.collectionIds, ['c1']);
    assert.equal(item.login.uris[0].uri, 'https://a.example');
    assert.equal(item.login.password, 'p');
});

test('createItem: validates required fields', () => {
    const { bw } = setup();
    assert.throws(() => bw.createItem('SESSION', { name: 'N', username: 'u', password: 'p' }), /collection_ids/);
    assert.throws(() => bw.createItem('SESSION', { name: 'N' }), /required fields/);
});
