<?php
declare(strict_types=1);

// INFO: end-to-end encrypted, account-free, database-free sync (protocol: README → Sync).
//       One opaque blob per vault at var/sync/<2 hex>/<sha256(token)>.vault. The token is derived from the
//       vault key on the client; the key and with it the encryption key never reach the server.

const NR_SYNC_MAGICS    = ['NRS1', 'NRF1']; // INFO: vault snapshot, forward to a new vault key (after a device was removed)
const NR_SYNC_MIN_BYTES = 4 + 1 + 12 + 16; // INFO: magic + flags + IV + GCM tag

function nr_sync_handle(): never
{
    nr_api_headers('GET, PUT, DELETE', 'Authorization, Content-Type, If-Match, If-None-Match');
    header('Access-Control-Expose-Headers: ETag');
    header('Cache-Control: no-store');

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
    if (!NR_SYNC_ENABLED) {
        nr_error('SYNC_DISABLED', 'Sync is disabled on this server.', 404);
    }
    if (!nr_ip_in_nets((string)($_SERVER['REMOTE_ADDR'] ?? ''), NR_SYNC_ALLOWED_NETS)) {
        nr_error('FORBIDDEN_NETWORK', 'Sync is not available from your network on this server.', 403);
    }
    if ($wait = nr_rate_hit('sync', NR_RATE_SYNC)) {
        nr_rate_reject($wait);
    }

    $file = nr_sync_file(nr_sync_token());

    match ($method) {
        'GET'    => nr_sync_get($file),
        'PUT'    => nr_sync_put($file),
        'DELETE' => nr_sync_delete($file),
        default  => nr_error('METHOD_NOT_ALLOWED', 'Use GET, PUT or DELETE.', 405),
    };
}

function nr_sync_get(string $file): never
{
    $blob = @file_get_contents($file);
    if ($blob === false) {
        nr_error('NOT_FOUND', 'No vault stored for this key yet.', 404);
    }
    $etag = nr_sync_etag($blob);
    header('ETag: ' . $etag);

    // INFO: expiry is based on mtime – keep read-only vaults alive, at most one touch per day
    if (time() - (int)@filemtime($file) > 86400) @touch($file);

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
        nr_error('PRECONDITION_REQUIRED', 'Send If-Match: "<etag>" to update or If-None-Match: * to create.', 428);
    }

    $blob = nr_sync_body();

    $lock = nr_sync_lock();
    try {
        $stored  = @file_get_contents($file);
        $exists  = $stored !== false;
        $current = $exists ? nr_sync_etag($stored) : null;
        if ($exists) nr_sync_refuse_forwarded($stored);

        if ($ifNone === '*' && $exists) {
            header('ETag: ' . $current);
            nr_error('CONFLICT', 'A vault already exists – fetch and merge first.', 412);
        }
        if ($ifMatch !== '' && (!$exists || !nr_sync_etag_matches($ifMatch, $current))) {
            if ($exists) header('ETag: ' . $current);
            nr_error('CONFLICT', 'The vault was changed by another device – fetch and merge first.', 412);
        }
        if (!$exists) {
            if ($wait = nr_rate_hit('sync-create', NR_RATE_SYNC_CREATE)) {
                nr_rate_reject($wait);
            }
            if (nr_sync_count() >= NR_SYNC_MAX_VAULTS) {
                nr_error('SERVER_FULL', 'This server does not accept new vaults right now.', 507);
            }
        }

        $dir = dirname($file);
        if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
            nr_error('SERVER_MISCONFIGURED', 'Sync storage is not writable (var/sync).', 500);
        }
        $tmp = $file . '.' . bin2hex(random_bytes(6)) . '.tmp';
        if (@file_put_contents($tmp, $blob) !== strlen($blob) || !@chmod($tmp, 0660) || !@rename($tmp, $file)) {
            @unlink($tmp);
            nr_error('SYNC_WRITE_FAILED', 'Could not store the vault.', 500);
        }
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }

    if (random_int(1, 100) === 1) nr_sync_gc();

    $etag = nr_sync_etag($blob);
    header('ETag: ' . $etag);
    nr_json(['ok' => true, 'etag' => $etag, 'bytes' => strlen($blob)], $exists ? 200 : 201);
}

function nr_sync_delete(string $file): never
{
    $lock = nr_sync_lock();
    try {
        $stored = @file_get_contents($file);
        if ($stored === false) {
            nr_error('NOT_FOUND', 'No vault stored for this key.', 404);
        }
        nr_sync_refuse_forwarded($stored);
        $ifMatch = trim((string)($_SERVER['HTTP_IF_MATCH'] ?? ''));
        if ($ifMatch !== '' && !nr_sync_etag_matches($ifMatch, nr_sync_etag($stored))) {
            nr_error('CONFLICT', 'The vault was changed meanwhile.', 412);
        }
        @unlink($file);
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
    http_response_code(204);
    exit;
}

// WARNING: a forward is final. Whoever still knows the old key (e.g. a removed device) could otherwise
//          replace or delete it and keep devices that were offline during the key change on the old key.
function nr_sync_refuse_forwarded(string $stored): void
{
    if (str_starts_with($stored, 'NRF1')) {
        nr_error('FORWARDED', 'This vault moved to a new key – fetch it and follow the forward.', 410);
    }
}

// INFO: 32 bytes base64url without padding (43 chars)
function nr_sync_token(): string
{
    $auth = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if (!preg_match('/^Bearer\s+([A-Za-z0-9_-]{43})$/D', $auth, $m)) {
        nr_error('UNAUTHORIZED', 'Send the vault token as "Authorization: Bearer <token>".', 401);
    }
    return $m[1];
}

// INFO: stored under sha256(token) – a leaked directory listing is useless as credentials
function nr_sync_file(string $token): string
{
    $id = hash('sha256', $token);
    return NR_SYNC_DIR . '/' . substr($id, 0, 2) . '/' . $id . '.vault';
}

function nr_sync_body(): string
{
    if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > NR_SYNC_MAX_BYTES) {
        nr_error('PAYLOAD_TOO_LARGE', 'Vault larger than ' . NR_SYNC_MAX_BYTES . ' bytes.', 413);
    }
    $raw = file_get_contents('php://input', false, null, 0, NR_SYNC_MAX_BYTES + 1);
    if ($raw !== false && strlen($raw) > NR_SYNC_MAX_BYTES) {
        nr_error('PAYLOAD_TOO_LARGE', 'Vault larger than ' . NR_SYNC_MAX_BYTES . ' bytes.', 413);
    }
    if ($raw === false || strlen($raw) < NR_SYNC_MIN_BYTES || !in_array(substr($raw, 0, 4), NR_SYNC_MAGICS, true)) {
        nr_error('INVALID_BODY', 'Expected an encrypted vault blob.', 400);
    }
    return $raw;
}

// INFO: one global lock for all writes – writes are tiny and rare
function nr_sync_lock()
{
    if (!is_dir(NR_SYNC_DIR) && !@mkdir(NR_SYNC_DIR, 0770, true) && !is_dir(NR_SYNC_DIR)) {
        nr_error('SERVER_MISCONFIGURED', 'Sync storage is not writable (var/sync).', 500);
    }
    $fh = @fopen(NR_SYNC_DIR . '/.lock', 'c');
    if ($fh === false || !flock($fh, LOCK_EX)) {
        nr_error('SERVER_MISCONFIGURED', 'Sync storage is not writable (var/sync).', 500);
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

// INFO: [] = every address is allowed
function nr_ip_in_nets(string $ip, array $nets): bool
{
    if ($nets === []) return true;
    $addr = @inet_pton($ip);
    if ($addr === false) return false;
    if (strlen($addr) === 16 && str_starts_with($addr, str_repeat("\0", 10) . "\xff\xff")) {
        $addr = substr($addr, 12);
    }
    foreach ($nets as $cidr) {
        [$net, $bits] = array_pad(explode('/', $cidr, 2), 2, null);
        $netBin = @inet_pton((string)$net);
        if ($netBin === false || strlen($netBin) !== strlen($addr)) continue;
        $bits = $bits === null ? strlen($addr) * 8 : max(0, min(strlen($addr) * 8, (int)$bits));
        $bytes = intdiv($bits, 8);
        $rest = $bits % 8;
        if (substr($addr, 0, $bytes) !== substr($netBin, 0, $bytes)) continue;
        if ($rest === 0) return true;
        $mask = (0xFF << (8 - $rest)) & 0xFF;
        if ((ord($addr[$bytes]) & $mask) === (ord($netBin[$bytes]) & $mask)) return true;
    }
    return false;
}
