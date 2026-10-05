'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadFresh, tmpDir } = require('../testsupport/load');

const { utils, errors } = loadFresh({ BW_SESSION_ID: 'x', LOG_LEVEL: 'error' });

test('generatePassword: length, character classes and randomness', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
        const p = utils.generatePassword();
        assert.equal(p.length, 24);
        assert.match(p, /[a-z]/);
        assert.match(p, /[A-Z]/);
        assert.match(p, /[0-9]/);
        assert.match(p, /[^a-zA-Z0-9]/);
        seen.add(p);
    }
    assert.equal(seen.size, 200);
    assert.equal(utils.generatePassword(40).length, 40);
});

test('readLines: skips blanks and # comments, handles CRLF', () => {
    const file = path.join(tmpDir(), 'list.txt');
    fs.writeFileSync(file, '# comment\r\nOne\r\n\r\n  Two  \n#Three\nFour');
    assert.deepEqual(utils.readLines(file), ['One', 'Two', 'Four']);
});

test('readLines / readJson: friendly errors', () => {
    const dir = tmpDir();
    assert.throws(() => utils.readLines(path.join(dir, 'nope.txt')), errors.ConfigError);
    assert.throws(() => utils.readJson(path.join(dir, 'nope.json')), /examples\//);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    assert.throws(() => utils.readJson(bad), /Invalid JSON/);
});

test('withRetry: retries retryable errors only, up to the limit', async () => {
    let calls = 0;
    const flaky = async () => {
        if (++calls < 3) throw new errors.ApiError('boom', { retryable: true });
        return 'ok';
    };
    assert.equal(await utils.withRetry(flaky, { retries: 3, backoff: [0] }), 'ok');
    assert.equal(calls, 3);

    calls = 0;
    await assert.rejects(utils.withRetry(async () => { calls++; throw new errors.ApiError('fatal'); }, { retries: 3, backoff: [0] }));
    assert.equal(calls, 1);

    calls = 0;
    await assert.rejects(utils.withRetry(async () => { calls++; throw new errors.ApiError('x', { retryable: true }); }, { retries: 2, backoff: [0] }));
    assert.equal(calls, 3);
});

test('withRetry: default retry count comes from MAX_RETRIES', async () => {
    const { utils: u, errors: e } = loadFresh({ BW_SESSION_ID: 'x', LOG_LEVEL: 'error', MAX_RETRIES: '0' });
    let calls = 0;
    await assert.rejects(u.withRetry(async () => { calls++; throw new e.ApiError('x', { retryable: true }); }));
    assert.equal(calls, 1);
});

test('processBatches: processes every item, survives handler failures', async () => {
    const done = [];
    await utils.processBatches(['a', 'b', 'c', 'd', 'e'], 2, 0, async item => {
        if (item === 'c') throw new Error('nope');
        done.push(item);
    });
    assert.deepEqual(done.sort(), ['a', 'b', 'd', 'e']);
});
