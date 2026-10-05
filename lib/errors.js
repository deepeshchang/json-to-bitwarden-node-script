'use strict';

class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}

class BitwardenError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BitwardenError';
    }
}

class ApiError extends Error {
    constructor(message, { status, retryable = false } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.retryable = retryable;
    }
}

module.exports = { ConfigError, BitwardenError, ApiError };
