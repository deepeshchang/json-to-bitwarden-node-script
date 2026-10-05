'use strict';

const { ApiError } = require('./errors');
const config = require('./config');
const logger = require('./logger');

// All instance I/O lives here. Paths come from config.ENDPOINTS; the request/response
// *shape* (login style, token transport, field names) comes from the API-contract
// settings in lib/config.js, so adapting to a new backend is configuration, not code.

// ---------------------------------------------------------------------------
// URL + request helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the canonical base URL (origin + path, no trailing slash) from a raw URI string.
 */
function cleanDomain(uri) {
    const url = new URL(uri);
    const path = url.pathname.replace(/\/+$/, '');
    return path ? `${url.origin}${path}` : url.origin;
}

/**
 * Joins an instance base URL with a configured endpoint path, substituting any
 * {token} placeholders (e.g. {userId}, {entityId}) from `params`.
 */
function endpointUrl(uri, pathTemplate, params = {}) {
    const path = pathTemplate.replace(/\{(\w+)\}/g, (_, key) => {
        if (params[key] === undefined) throw new ApiError(`Endpoint "${pathTemplate}" needs a "${key}" value`);
        return encodeURIComponent(params[key]);
    });
    return `${uri}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Reads a (possibly dotted) path from an object: getPath({a:{b:1}}, 'a.b') === 1. */
function getPath(obj, dotted) {
    return String(dotted).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/** Returns the array inside a list response, honouring an optional envelope key. */
function extractList(data, key) {
    const list = key ? getPath(data, key) : data;
    return Array.isArray(list) ? list : [];
}

/** Headers that carry the access token, per TOKEN_TRANSPORT. */
function authHeaders(accessToken) {
    switch (config.TOKEN_TRANSPORT) {
        case 'bearer': return { Authorization: `Bearer ${accessToken}` };
        case 'header': return { [config.TOKEN_NAME]: accessToken };
        default:       return { Cookie: `${config.TOKEN_NAME}=${accessToken}` };
    }
}

const base64 = s => Buffer.from(s).toString('base64');

/** Builds the login request (headers + optional body) per AUTH_MODE. */
function loginRequest(username, password) {
    const headers = { Accept: 'application/json, text/plain, */*', 'Cache-Control': 'no-cache' };
    let body;
    switch (config.AUTH_MODE) {
        case 'basic':
            headers.Authorization = `Basic ${base64(`${username}:${password}`)}`;
            break;
        case 'json':
            headers['Content-Type'] = 'application/json; charset=UTF-8';
            body = JSON.stringify({ [config.AUTH_USERNAME_FIELD]: username, [config.AUTH_PASSWORD_FIELD]: password });
            break;
        default:
            headers[config.AUTH_HEADER_NAME] = base64(`${username}:${password}`);
    }
    return { headers, body };
}

/**
 * fetch() wrapper: applies the request timeout and converts network-level failures
 * into retryable ApiErrors. `what` completes "Network error <what>: ...".
 */
async function send(fetch, url, init, what) {
    try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS) });
    } catch (err) {
        throw new ApiError(`Network error ${what}: ${err.message}`, { retryable: true });
    }
}

/** GET with the access token; returns the parsed JSON body or throws ApiError. */
async function authedGetJson(fetch, uri, accessToken, pathTemplate, what) {
    const response = await send(fetch, endpointUrl(uri, pathTemplate), {
        method: 'GET',
        headers: { Accept: 'application/json, text/plain, */*', 'Cache-Control': 'no-cache', ...authHeaders(accessToken) },
    }, `fetching ${what} from ${uri}`);

    if (!response.ok) {
        throw new ApiError(`Failed to list ${what} (${response.status}) from ${uri}`, {
            status: response.status,
            retryable: response.status >= 500,
        });
    }
    let data;
    try {
        data = await response.json();
    } catch (err) {
        throw new ApiError(`Invalid JSON in ${what} response from ${uri}: ${err.message}`);
    }
    logger.debug(`${what} response from ${uri}:`, data);
    return data;
}

/** GET with the access token; returns only the HTTP status. */
async function authedGetStatus(fetch, url, accessToken, what) {
    const response = await send(fetch, url, {
        method: 'GET',
        headers: { Accept: 'application/json, text/plain, */*', 'Cache-Control': 'no-cache', ...authHeaders(accessToken) },
    }, what);
    return response.status;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function login(fetch, uri, username, password) {
    const { headers, body } = loginRequest(username, password);
    return send(fetch, endpointUrl(uri, config.ENDPOINTS.AUTH_LOGIN), { method: config.AUTH_METHOD, headers, body }, `authenticating to ${uri}`);
}

/**
 * Like authenticate(), but returns both access_token and user_id from the response body.
 * Used by check-api-access to chain a follow-up authenticated call.
 */
async function authenticateFull(fetch, uri, username, password) {
    const response = await login(fetch, uri, username, password);

    if (response.status >= 500) {
        throw new ApiError(`Server error ${response.status} authenticating to ${uri}`, {
            status: response.status,
            retryable: true,
        });
    }
    if (!response.ok) {
        throw new ApiError(`Auth failed (${response.status}) for ${uri}`, { status: response.status, retryable: false });
    }

    let data;
    try {
        data = await response.json();
    } catch (err) {
        throw new ApiError(`Invalid JSON in auth response from ${uri}: ${err.message}`);
    }
    const accessToken = getPath(data, config.AUTH_TOKEN_FIELD);
    if (!accessToken) throw new ApiError(`No "${config.AUTH_TOKEN_FIELD}" in auth response from ${uri}`);
    return { access_token: accessToken, user_id: getPath(data, config.AUTH_USER_ID_FIELD) };
}

/**
 * Authenticates to an instance and returns an access token. Throws ApiError on failure.
 */
async function authenticate(fetch, uri, username, password) {
    return (await authenticateFull(fetch, uri, username, password)).access_token;
}

/**
 * Attempts authentication and returns the HTTP status code (no body parsing).
 */
async function checkLoginStatus(fetch, uri, username, password) {
    return (await login(fetch, uri, username, password)).status;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Fetches the user list from an instance (array, envelope unwrapped). */
async function listUsers(fetch, uri, accessToken) {
    const data = await authedGetJson(fetch, uri, accessToken, config.ENDPOINTS.USERS, 'users');
    return extractList(data, config.USERS_RESPONSE_KEY);
}

/**
 * GET the user-by-id endpoint. Returns the HTTP status code so callers can bucket
 * pass/fail without parsing the body.
 */
async function getUserById(fetch, uri, accessToken, userId) {
    return authedGetStatus(fetch, endpointUrl(uri, config.ENDPOINTS.USER_BY_ID, { userId }), accessToken,
        `fetching user ${userId} from ${uri}`);
}

/**
 * GET the user-groups endpoint. Returns the HTTP status code. Used to verify a
 * freshly-created user can log in and read their own group assignments.
 */
async function getUserGroups(fetch, uri, accessToken, entityId) {
    return authedGetStatus(fetch, endpointUrl(uri, config.ENDPOINTS.USER_GROUPS, { entityId }), accessToken,
        `fetching groups for user ${entityId} from ${uri}`);
}

/**
 * Creates a user via POST to the users endpoint. `payload` is the full request body
 * (rendered from the create-user template). Returns the HTTP status code so callers
 * can distinguish success, conflict (already exists) and hard failures.
 */
async function createUser(fetch, uri, accessToken, payload) {
    const response = await send(fetch, endpointUrl(uri, config.ENDPOINTS.USERS), {
        method: 'POST',
        headers: {
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json; charset=UTF-8',
            ...authHeaders(accessToken),
        },
        body: JSON.stringify(payload),
    }, `creating user on ${uri}`);

    if (response.status >= 500) {
        throw new ApiError(`Server error ${response.status} creating user on ${uri}`, {
            status: response.status,
            retryable: true,
        });
    }
    return response.status;
}

// ---------------------------------------------------------------------------
// ACL: groups, regions, permissions
// ---------------------------------------------------------------------------

/** Fetches the ACL groups (array, envelope unwrapped). */
async function listGroups(fetch, uri, accessToken) {
    const data = await authedGetJson(fetch, uri, accessToken, config.ENDPOINTS.GROUPS, 'groups');
    return extractList(data, config.GROUPS_RESPONSE_KEY);
}

/** Fetches ACL regions: [{ _id, name, sales_region: [<id>, ...] }, ...]. */
async function listRegions(fetch, uri, accessToken) {
    const data = await authedGetJson(fetch, uri, accessToken, config.ENDPOINTS.REGIONS, 'regions');
    return Array.isArray(data) ? data : [];
}

/** Fetches ACL sales regions, unwrapping the { salesRegions: [...] } envelope if present. */
async function listSalesRegions(fetch, uri, accessToken) {
    const data = await authedGetJson(fetch, uri, accessToken, config.ENDPOINTS.SALES_REGIONS, 'sales regions');
    return Array.isArray(data) ? data : (data && data.salesRegions) || [];
}

/**
 * Grants permissions via POST, wrapping `permissions` in the { permissions: [...] } envelope.
 * Returns true on success, throws ApiError on failure.
 */
async function setPermissions(fetch, uri, accessToken, permissions) {
    const response = await send(fetch, endpointUrl(uri, config.ENDPOINTS.PERMISSIONS), {
        method: 'POST',
        headers: {
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json; charset=UTF-8',
            ...authHeaders(accessToken),
        },
        body: JSON.stringify({ permissions }),
    }, `setting permissions on ${uri}`);

    if (!response.ok) {
        throw new ApiError(`Failed to set permissions (${response.status}) on ${uri}`, {
            status: response.status,
            retryable: response.status >= 500,
        });
    }
    return true;
}

// ---------------------------------------------------------------------------
// Password change
// ---------------------------------------------------------------------------

/**
 * Changes the authenticated user's password. Returns true on success, throws ApiError on failure.
 */
async function changePassword(fetch, uri, accessToken, oldPassword, newPassword) {
    const encode = config.CHANGE_PASSWORD_ENCODING === 'base64' ? base64 : s => s;
    const payload = {
        [config.CHANGE_PASSWORD_OLD_FIELD]: encode(oldPassword),
        [config.CHANGE_PASSWORD_NEW_FIELD]: encode(newPassword),
    };

    let response;
    try {
        response = await send(fetch, endpointUrl(uri, config.ENDPOINTS.AUTH_CHANGE_PASSWORD), {
            method: config.CHANGE_PASSWORD_METHOD,
            headers: { 'Content-Type': 'application/json; charset=UTF-8', ...authHeaders(accessToken) },
            body: JSON.stringify(payload),
        }, `changing password on ${uri}`);
    } catch (err) {
        // A timeout/reset is ambiguous: the server may have applied the change. Never
        // auto-retry — a blind retry would send the old password again.
        throw new ApiError(`${err.message} (outcome unknown — verify the login manually before retrying)`, { retryable: false });
    }

    if (!response.ok) {
        throw new ApiError(`Password change failed (${response.status}) on ${uri}`, {
            status: response.status,
            retryable: response.status >= 500,
        });
    }
    return true;
}

module.exports = {
    cleanDomain, endpointUrl, getPath, extractList,
    authenticate, authenticateFull, checkLoginStatus,
    listUsers, getUserById, getUserGroups, createUser,
    listGroups, listRegions, listSalesRegions, setPermissions,
    changePassword,
};
