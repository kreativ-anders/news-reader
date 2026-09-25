<?php
declare(strict_types=1);

/**
 * News Sync – end-to-end encrypted, account-free, database-free.
 *
 *   GET    /api/sync   → the vault blob (ETag), 304 with If-None-Match, 404 if none
 *   PUT    /api/sync   → replace the blob; requires If-Match: "<etag>" (update)
 *                        or If-None-Match: * (create) – optimistic concurrency, 412 on conflict
 *   DELETE /api/sync   → delete the vault
 *
 * Auth: "Authorization: Bearer <token>". The token is derived on the client from the
 * vault key (HKDF); the key itself – and with it the encryption key – never leaves
 * the devices. The server stores one opaque file per vault under sha256(token):
 *
 *   var/sync/<2 hex>/<64 hex>.vault
 *
 * Blob format (checked only superficially): "NRS1" | flags(1) | iv(12) | AES-256-GCM ciphertext.
 * The server has no schema, no merge logic and nothing it could leak in plain text:
 * clients download, decrypt, merge (last write wins per record), encrypt and upload.
 */

const NR_SYNC_MAGIC     = 'NRS1';
const NR_SYNC_MIN_BYTES = 4 + 1 + 12 + 16; // magic + flags + iv + GCM tag

function nr_sync_handle(): never
{
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Authorization, Content-Type, If-Match, If-None-Match');
    header('Access-Control-Expose-Headers: ETag');
    header('Access-Control-Max-Age: 86400');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('X-Robots-Tag: noindex');

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
    if (!NR_SYNC_ENABLED) {
        nr_sync_error('SYNC_DISABLED', 'Sync is disabled on this server.', 404);
    }
    if (!nr_sync_client_allowed((string)($_SERVER['REMOTE_ADDR'] ?? ''))) {
        nr_sync_error('FORBIDDEN_NETWORK', 'Sync is not available from your network on this server.', 403);
    }
    if ($wait = nr_rate_hit('sync', NR_RATE_SYNC)) {
        nr_rate_reject($wait);
    }

    $file = nr_sync_file(nr_sync_token());

    switch ($method) {
        case 'GET':    nr_sync_get($file);
        case 'PUT':    nr_sync_put($file);
        case 'DELETE': nr_sync_delete($file);
        default:       nr_sync_error('METHOD_NOT_ALLOWED', 'Use GET, PUT or DELETE.', 405);
    }
}

// ------------------------------------------------------------------ handlers

function nr_sync_get(string $file): never
{
    clearstatcache(true, $file);
    if (!is_file($file)) {
        nr_sync_error('NOT_FOUND', 'No vault stored for this key yet.', 404);
    }
    $blob = (string)file_get_contents($file);
    $etag = nr_sync_etag($blob);
    header('ETag: ' . $etag);

    // Keep active vaults alive (expiry is based on mtime), at most once a day.
    if (time() - (int)filemtime($file) > 86400) @touch($file);

    if (nr_sync_etag_matches($_SERVER['HTTP_IF_NONE_MATCH'] ?? '', $etag)) {
        http_response_code(304);
        exit;
    }
    http_response_code(200);
    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . strlen($blob));
    echo $blob;
    exit;
}

function nr_sync_put(string $file): never
{
    $ifMatch = trim((string)($_SERVER['HTTP_IF_MATCH'] ?? ''));
    $ifNone  = trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? ''));
    if ($ifMatch === '' && $ifNone !== '*') {
        nr_sync_error('PRECONDITION_REQUIRED', 'Send If-Match: "<etag>" to update or If-None-Match: * to create.', 428);
    }

    $blob = nr_sync_body();

    $lock = nr_sync_lock();
    try {
        clearstatcache(true, $file);
        $exists  = is_file($file);
        $current = $exists ? nr_sync_etag((string)file_get_contents($file)) : null;

        if ($ifNone === '*' && $exists) {
            header('ETag: ' . $current);
            nr_sync_error('CONFLICT', 'A vault already exists – fetch and merge first.', 412);
        }
        if ($ifMatch !== '' && (!$exists || !nr_sync_etag_matches($ifMatch, (string)$current))) {
            if ($current) header('ETag: ' . $current);
            nr_sync_error('CONFLICT', 'The vault was changed by another device – fetch and merge first.', 412);
        }
        if (!$exists) {
            if ($wait = nr_rate_hit('sync-create', NR_RATE_SYNC_CREATE)) {
                nr_rate_reject($wait);
            }
            if (nr_sync_count() >= NR_SYNC_MAX_VAULTS) {
                nr_sync_error('SERVER_FULL', 'This server does not accept new vaults right now.', 507);
            }
        }

        $dir = dirname($file);
        if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
            nr_sync_error('SERVER_MISCONFIGURED', 'Sync storage is not writable (var/sync).', 500);
        }
        $tmp = $file . '.' . bin2hex(random_bytes(6)) . '.tmp';
        if (@file_put_contents($tmp, $blob) !== strlen($blob) || !@rename($tmp, $file)) {
            @unlink($tmp);
            nr_sync_error('SYNC_WRITE_FAILED', 'Could not store the vault.', 500);
        }
        @chmod($file, 0660);
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }

    if (random_int(1, 100) === 1) nr_sync_gc();

    $etag = nr_sync_etag($blob);
    header('ETag: ' . $etag);
    nr_sync_json(['ok' => true, 'etag' => $etag, 'bytes' => strlen($blob)], $exists ? 200 : 201);
}

function nr_sync_delete(string $file): never
{
    $lock = nr_sync_lock();
    try {
        clearstatcache(true, $file);
        if (!is_file($file)) {
            nr_sync_error('NOT_FOUND', 'No vault stored for this key.', 404);
        }
        $ifMatch = trim((string)($_SERVER['HTTP_IF_MATCH'] ?? ''));
        if ($ifMatch !== '' && !nr_sync_etag_matches($ifMatch, nr_sync_etag((string)file_get_contents($file)))) {
            nr_sync_error('CONFLICT', 'The vault was changed meanwhile.', 412);
        }
        @unlink($file);
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
    http_response_code(204);
    exit;
}

// ------------------------------------------------------------------ plumbing

/** Bearer token: 32 random-looking bytes, base64url without padding (43 chars). */
function nr_sync_token(): string
{
    $auth = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if (!preg_match('/^Bearer\s+([A-Za-z0-9_-]{43})$/', $auth, $m)) {
        nr_sync_error('UNAUTHORIZED', 'Send the vault token as "Authorization: Bearer <token>".', 401);
    }
    return $m[1];
}

/** Storage path = sha256(token): a leaked directory listing is useless as credentials. */
function nr_sync_file(string $token): string
{
    $id = hash('sha256', $token);
    return NR_SYNC_DIR . '/' . substr($id, 0, 2) . '/' . $id . '.vault';
}

function nr_sync_body(): string
{
    $len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($len > NR_SYNC_MAX_BYTES) {
        nr_sync_error('PAYLOAD_TOO_LARGE', 'Vault larger than ' . NR_SYNC_MAX_BYTES . ' bytes.', 413);
    }
    $raw = file_get_contents('php://input', false, null, 0, NR_SYNC_MAX_BYTES + 1);
    if ($raw === false || strlen($raw) < NR_SYNC_MIN_BYTES || !str_starts_with($raw, NR_SYNC_MAGIC)) {
        nr_sync_error('INVALID_BODY', 'Expected an encrypted vault blob.', 400);
    }
    if (strlen($raw) > NR_SYNC_MAX_BYTES) {
        nr_sync_error('PAYLOAD_TOO_LARGE', 'Vault larger than ' . NR_SYNC_MAX_BYTES . ' bytes.', 413);
    }
    return $raw;
}

/** One global lock for all writes – writes are tiny and rare, so contention is irrelevant. */
function nr_sync_lock()
{
    if (!is_dir(NR_SYNC_DIR) && !@mkdir(NR_SYNC_DIR, 0770, true) && !is_dir(NR_SYNC_DIR)) {
        nr_sync_error('SERVER_MISCONFIGURED', 'Sync storage is not writable (var/sync).', 500);
    }
    $fh = @fopen(NR_SYNC_DIR . '/.lock', 'c');
    if ($fh === false || !flock($fh, LOCK_EX)) {
        nr_sync_error('SERVER_MISCONFIGURED', 'Sync storage is not writable (var/sync).', 500);
    }
    return $fh;
}

function nr_sync_etag(string $blob): string
{
    return '"' . substr(hash('sha256', $blob), 0, 32) . '"';
}

function nr_sync_etag_matches(string $header, string $etag): bool
{
    foreach (explode(',', $header) as $candidate) {
        $candidate = trim($candidate);
        if (str_starts_with($candidate, 'W/')) $candidate = substr($candidate, 2);
        if ($candidate !== '' && hash_equals($etag, $candidate)) return true;
    }
    return false;
}

function nr_sync_count(): int
{
    return count(glob(NR_SYNC_DIR . '/*/*.vault', GLOB_NOSORT) ?: []);
}

/** Delete vaults that were not read or written for NR_SYNC_EXPIRE_DAYS, and stray temp files. */
function nr_sync_gc(): void
{
    $vaultLimit = time() - NR_SYNC_EXPIRE_DAYS * 86400;
    foreach (glob(NR_SYNC_DIR . '/*/*.vault', GLOB_NOSORT) ?: [] as $f) {
        if (@filemtime($f) < $vaultLimit) @unlink($f);
    }
    foreach (glob(NR_SYNC_DIR . '/*/*.tmp', GLOB_NOSORT) ?: [] as $f) {
        if (@filemtime($f) < time() - 3600) @unlink($f);
    }
}

/** true if $ip is inside one of NR_SYNC_ALLOWED_NETS (empty list = everyone). */
function nr_sync_client_allowed(string $ip): bool
{
    if (NR_SYNC_ALLOWED_NETS === []) return true;
    $addr = @inet_pton($ip);
    if ($addr === false) return false;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) → plain IPv4
    if (strlen($addr) === 16 && str_starts_with($addr, str_repeat("\0", 10) . "\xff\xff")) {
        $addr = substr($addr, 12);
    }
    foreach (NR_SYNC_ALLOWED_NETS as $cidr) {
        [$net, $bits] = array_pad(explode('/', $cidr, 2), 2, null);
        $netBin = @inet_pton((string)$net);
        if ($netBin === false || strlen($netBin) !== strlen($addr)) continue;
        $bits = $bits === null ? strlen($addr) * 8 : (int)$bits;
        $bytes = intdiv($bits, 8);
        $rest = $bits % 8;
        if (substr($addr, 0, $bytes) !== substr($netBin, 0, $bytes)) continue;
        if ($rest === 0) return true;
        $mask = (0xFF << (8 - $rest)) & 0xFF;
        if ((ord($addr[$bytes]) & $mask) === (ord($netBin[$bytes]) & $mask)) return true;
    }
    return false;
}

function nr_sync_error(string $code, string $message, int $status): never
{
    nr_sync_json(['error' => ['code' => $code, 'message' => $message]], $status);
}

function nr_sync_json(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
