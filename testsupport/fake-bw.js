#!/usr/bin/env node
'use strict';

// A stand-in for the Bitwarden CLI used by the tests. Behaviour is driven by env vars:
//   FAKE_BW_ITEMS  path to a JSON file returned by `list items`
//   FAKE_BW_LOG    path to a JSONL file; every invocation is appended as {args, stdin}
//   FAKE_BW_FAIL   a command word ("edit", "create", ...) that should exit non-zero
const fs = require('fs');

const args = process.argv.slice(2);
const stdin = args[0] === 'encode' || args[0] === 'create' || args[0] === 'edit'
    ? fs.readFileSync(0, 'utf-8') : '';

if (process.env.FAKE_BW_LOG) {
    fs.appendFileSync(process.env.FAKE_BW_LOG, JSON.stringify({ args, stdin }) + '\n');
}
if (process.env.FAKE_BW_FAIL && args[0] === process.env.FAKE_BW_FAIL) {
    process.stderr.write('fake bw: forced failure\n');
    process.exit(1);
}

const [cmd, sub] = args;
if (cmd === 'sync') process.stdout.write('Syncing complete.');
else if (cmd === 'list' && sub === 'items') process.stdout.write(fs.readFileSync(process.env.FAKE_BW_ITEMS, 'utf-8'));
else if (cmd === 'get' && args[2] === 'item') process.stdout.write(JSON.stringify({ type: 1, name: '', notes: '', login: null, collectionIds: [] }));
else if (cmd === 'get' && args[2] === 'item.login') process.stdout.write(JSON.stringify({ username: null, password: null, uris: [] }));
else if (cmd === 'encode') process.stdout.write(Buffer.from(stdin).toString('base64'));
else if (cmd === 'create' || cmd === 'edit') process.stdout.write('{}');
else if (cmd === 'status') process.stdout.write(JSON.stringify({ status: 'unauthenticated' }));
else { process.stderr.write(`fake bw: unsupported ${args.join(' ')}\n`); process.exit(2); }
