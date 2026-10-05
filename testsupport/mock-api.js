'use strict';

const http = require('http');

/**
 * Starts a local HTTP server. `handler(req, body)` returns { status, json } and every
 * request is recorded in `requests` as { method, url, headers, body }.
 */
async function startMockApi(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            const record = { method: req.method, url: req.url, headers: req.headers, body: raw };
            requests.push(record);
            const { status = 200, json = {} } = handler(record) || {};
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(json));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    return { url, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

module.exports = { startMockApi };
