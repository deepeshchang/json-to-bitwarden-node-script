'use strict';

const fs = require('fs');
const { ConfigError } = require('./errors');

/**
 * Renders a JSON request-body template.
 *
 * Any string equal to exactly "{{name}}" is replaced by the variable's raw value (so
 * arrays, booleans and numbers keep their type). A "{{name}}" embedded in a longer
 * string is replaced with String(value). Unknown variables throw a ConfigError, so a
 * typo in a template fails loudly instead of sending a broken request.
 */
function render(node, vars) {
    if (typeof node === 'string') {
        const whole = node.match(/^\{\{\s*(\w+)\s*\}\}$/);
        if (whole) return lookup(vars, whole[1]);
        return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => String(lookup(vars, name)));
    }
    if (Array.isArray(node)) return node.map(n => render(n, vars));
    if (node && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, render(v, vars)]));
    }
    return node;
}

function lookup(vars, name) {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
        throw new ConfigError(`Unknown template variable "{{${name}}}". Available: ${Object.keys(vars).join(', ')}`);
    }
    return vars[name];
}

function loadTemplate(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
        throw new ConfigError(`Cannot load create-user template ${file}: ${err.message}`);
    }
}

module.exports = { render, loadTemplate };
