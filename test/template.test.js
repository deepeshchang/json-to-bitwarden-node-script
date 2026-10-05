'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { render, loadTemplate } = require('../lib/template');
const { ROOT } = require('../testsupport/load');

test('render: whole-string placeholders keep their type, embedded ones are stringified', () => {
    const out = render(
        { a: '{{list}}', b: 'id-{{n}}', c: [{ d: '{{flag}}' }], e: 5 },
        { list: ['x', 'y'], n: 7, flag: true }
    );
    assert.deepEqual(out, { a: ['x', 'y'], b: 'id-7', c: [{ d: true }], e: 5 });
});

test('render: unknown variable fails loudly', () => {
    assert.throws(() => render({ a: '{{nope}}' }, {}), /Unknown template variable/);
});

test('shipped create-user template renders to the reference payload', () => {
    const tpl = loadTemplate(path.join(ROOT, 'templates', 'create-user.json'));
    const body = render(tpl, {
        username: 'svc', firstName: 'S', lastName: 'U', email: '', language: 'en',
        password: 'p@ss"word', groupIds: ['g1', 'g2'], groupIdsJson: JSON.stringify(['g1', 'g2']),
    });
    assert.equal(body.username, 'svc');
    assert.equal(body.credentials[0].value, 'p@ss"word');
    assert.equal(body.attributes.group_id, '["g1","g2"]');
    assert.equal(body.credentials[0].temporary, false);
});
