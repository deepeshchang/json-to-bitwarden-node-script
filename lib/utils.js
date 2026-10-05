'use strict';

const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');
const { ApiError, ConfigError } = require('./errors');
const logger = require('./logger');

/**
 * Retries an async function on retryable ApiErrors with exponential backoff.
 * @param {Function} fn - Async function to call (no arguments)
 * @param {object} options
 * @param {number} options.retries - Max retry attempts (default: MAX_RETRIES from config)
 * @param {number[]} options.backoff - Delay in ms per attempt (default [1000, 2000, 4000])
 */
async function withRetry(fn, { retries = config.MAX_RETRIES, backoff = [1000, 2000, 4000] } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const isRetryable = err instanceof ApiError && err.retryable;
            if (!isRetryable || attempt === retries) throw err;
            const delay = backoff[attempt] ?? backoff[backoff.length - 1];
            logger.warn(`Retryable error (attempt ${attempt + 1}/${retries}): ${err.message}. Retrying in ${delay}ms...`);
            await sleep(delay);
        }
    }
    throw lastError;
}

/**
 * Returns a promise that resolves after ms milliseconds.
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Processes items in batches of batchSize, with an optional delay between batches.
 * Uses Promise.allSettled so one item's failure doesn't abort the rest of the batch.
 * @param {Array} items
 * @param {number} batchSize
 * @param {number} batchDelayMs
 * @param {Function} handler - async (item) => void
 */
async function processBatches(items, batchSize, batchDelayMs, handler) {
    for (let i = 0; i < items.length; i += batchSize) {
        const chunk = items.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        logger.info(`\n--- Processing Batch ${batchNum} (${chunk.length} items) ---`);

        const results = await Promise.allSettled(chunk.map(item => handler(item)));

        results.forEach((result, idx) => {
            if (result.status === 'rejected') {
                logger.error(`Item "${chunk[idx]}" failed in batch ${batchNum}: ${result.reason?.message}`);
            }
        });

        if (batchDelayMs > 0 && i + batchSize < items.length) {
            await sleep(batchDelayMs);
        }
    }
}

/**
 * Generates a cryptographically-random password.
 * Length defaults to 24 chars and is guaranteed to contain at least one
 * lowercase, uppercase, digit, and special character. Passwords are only ever
 * transmitted in JSON bodies (fetch requests, `bw encode` stdin), so the full
 * special-character set is safe to use — no shell-metacharacter restriction.
 * @param {number} length - Total password length (minimum 4). Default 24.
 */
function generatePassword(length = 24) {
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numChars = '0123456789';
    const specialChars = '!@#$%^&*()-_=+[]{}:?';
    const allChars = lower + upper + numChars + specialChars;

    const pick = charset => charset[crypto.randomInt(charset.length)];

    // Guarantee at least one of each required class.
    const required = [pick(lower), pick(upper), pick(numChars), pick(specialChars)];
    const remaining = Math.max(0, length - required.length);
    const chars = required.concat(
        Array.from({ length: remaining }, () => pick(allChars))
    );

    // Fisher–Yates shuffle so the guaranteed chars aren't always in front.
    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    return chars.join('');
}

/**
 * Reads a newline-delimited input file into a list of non-empty, trimmed lines.
 * Blank lines and lines starting with "#" are ignored. Throws a ConfigError with a
 * pointer to the examples/ folder when the file is missing.
 */
function readLines(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new ConfigError(`Input file not found: ${file}. Copy a template from examples/ (see README → Input Files).`);
        }
        throw err;
    }
    return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

/**
 * Reads and parses a JSON input file, with the same friendly missing-file error as readLines.
 */
function readJson(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new ConfigError(`Input file not found: ${file}. Copy a template from examples/ (see README → Input Files).`);
        }
        throw err;
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new ConfigError(`Invalid JSON in ${file}: ${err.message}`);
    }
}

module.exports = { withRetry, sleep, processBatches, generatePassword, readLines, readJson };
