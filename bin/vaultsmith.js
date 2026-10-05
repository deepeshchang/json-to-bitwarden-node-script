#!/usr/bin/env node
'use strict';

// `vaultsmith <command>` — thin dispatcher over the scripts in ./scripts, so the
// tool can be used as `npx vaultsmith check-logins` or via the npm scripts.

const path = require('path');

const COMMANDS = {
    'add-credentials':  ['addcredentials.js',      'Bulk-import credentials from a JSON file into Bitwarden'],
    'search-users':     ['searchuser.js',          'Search for specific people across all instances'],
    'check-logins':     ['loginchecker.js',        'Verify stored credentials can log into their instances'],
    'check-api-access': ['checkapiaccess.js',      'Verify login + a follow-up authenticated API call'],
    'change-passwords': ['bulkpasswordchanger.js', 'Bulk-rotate passwords and sync them back to Bitwarden'],
    'update-passwords': ['updatepasswords.js',     'Update specific Bitwarden vault items from a JSON file'],
    'create-users':     ['createusers.js',         'Provision a standard user across many instances'],
};

function usage() {
    console.log('Usage: vaultsmith <command>\n\nCommands:');
    for (const [name, [, desc]] of Object.entries(COMMANDS)) {
        console.log(`  ${name.padEnd(18)} ${desc}`);
    }
    console.log('\nMutating commands (change-passwords, create-users) are dry-run unless enabled in .env.');
}

const command = process.argv[2];
if (!command || command === '-h' || command === '--help') {
    usage();
    process.exit(command ? 0 : 1);
}
if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
    console.error(`Unknown command: ${command}\n`);
    usage();
    process.exit(1);
}

require(path.join(__dirname, '..', 'scripts', COMMANDS[command][0]));
