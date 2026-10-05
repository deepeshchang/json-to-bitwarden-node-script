'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'debug';
const logger = require('../lib/logger');

function capture(fn) {
    const lines = [];
    const orig = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = (...a) => lines.push(a.join(' '));
    try { fn(); } finally { [console.log, console.warn, console.error] = orig; }
    return lines.join('\n');
}

test('logger redacts sensitive object keys', () => {
    const out = capture(() => logger.info({ username: 'bob', password: 'hunter2', new_password: 'abc', nested: { access_token: 'tok' } }));
    assert.match(out, /bob/);
    assert.doesNotMatch(out, /hunter2|"abc"|tok"/);
});

test('logger redacts key=value secrets in strings and errors', () => {
    const out = capture(() => {
        logger.error('failed: password=hunter2 token: abc123');
        logger.error(new Error('bad session=s3cr3t'));
    });
    assert.doesNotMatch(out, /hunter2|abc123|s3cr3t/);
});
