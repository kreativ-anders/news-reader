<?php
declare(strict_types=1);

const NR_ACCEPT      = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.1';
const NR_ACCEPT_HTML = 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1';

// INFO: redirects are followed manually so that every hop passes nr_validate_target().
//       $conditional = ['etag' => …, 'lastModified' => …] sends If-None-Match/If-Modified-Since (304 → status 304).
//       A response prepared by nr_fetch_prime() is returned without a request.
function nr_fetch(string $url, string $accept = NR_ACCEPT, array $conditional = []): array
{
    if (($primed = nr_fetch_prime($url)) !== null) return $primed;
    $current = $url;
    $extra = array_values(array_filter([
        isset($conditional['etag']) ? 'If-None-Match: ' . $conditional['etag'] : null,
        isset($conditional['lastModified']) ? 'If-Modified-Since: ' . $conditional['lastModified'] : null,
    ]));

    for ($hop = 0; $hop <= NR_MAX_REDIRECTS; $hop++) {
        $check = nr_validate_target($current);
        if ($check !== null) {
            return $check;
        }

        $timeout = min(NR_REQUEST_TIMEOUT, nr_time_left());
        if ($timeout < 1) {
            return nr_err('UPSTREAM_FETCH_FAILED', 'The time budget for upstream requests is exhausted.');
        }

        $res = extension_loaded('curl')
            ? nr_request_curl($current, $accept, $timeout, $extra)
            : nr_request_stream($current, $accept, $timeout, $extra);

        if ($res['tooLarge']) {
            return nr_err('UPSTREAM_TOO_LARGE', 'The source response exceeded ' . NR_MAX_BODY_BYTES . ' bytes.');
        }
        if ($res['error'] !== null) {
            return nr_err('UPSTREAM_FETCH_FAILED', 'The source could not be fetched: ' . $res['error']);
        }

        $status = $res['status'];
        $headers = $res['headers'];

        if ($status >= 300 && $status < 400 && isset($headers['location'])) {
            $current = nr_absolute_url($headers['location'], $current, false);
            continue;
        }
        if ($status >= 400) {
            return nr_err('UPSTREAM_HTTP_ERROR', 'The source returned HTTP ' . $status . '.', ['status' => $status]);
        }

        $ok = [
            'ok'          => true,
            'body'        => $res['body'],
            'contentType' => strtolower($headers['content-type'] ?? ''),
            'finalUrl'    => $current,
            'status'      => $status,
        ];
        nr_fetch_validators($current, array_filter([
            'etag'         => isset($headers['etag']) && strlen($headers['etag']) <= 200 ? $headers['etag'] : null,
            'lastModified' => isset($headers['last-modified']) && strlen($headers['last-modified']) <= 100 ? $headers['last-modified'] : null,
        ]));
        return $ok;
    }

    return nr_err('TOO_MANY_REDIRECTS', 'More than ' . NR_MAX_REDIRECTS . ' redirects.');
}

// INFO: upstream validators (ETag/Last-Modified) of the responses fetched in this request, by final URL
function nr_fetch_validators(string $url, ?array $set = null): array
{
    static $seen = [];
    if ($set !== null) $seen[$url] = $set;
    return $seen[$url] ?? [];
}

// INFO: hands a response that was already fetched (conditional refresh) to the next nr_fetch() of the same URL
function nr_fetch_prime(string $url, ?array $res = null): ?array
{
    static $primed = [];
    if ($res !== null) { $primed[$url] = $res; return null; }
    $hit = $primed[$url] ?? null;
    unset($primed[$url]);
    return $hit;
}

// INFO: set_time_limit() counts CPU time only on Linux – network waits need their own wall-clock budget
function nr_time_left(): int
{
    static $start = null;
    $start ??= (float)($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true));
    return (int)floor(NR_TIME_BUDGET - (microtime(true) - $start));
}

// INFO: one handle per request – curl_reset() clears the options, connections and TLS sessions are reused
function nr_request_curl(string $url, string $accept, int $timeout, array $extraHeaders = []): array
{
    static $ch = null;
    $body = '';
    $tooLarge = false;
    $headers = [];

    $ch ??= curl_init();
    curl_reset($ch);
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROXY          => '',   // WARNING: a proxy would bypass the IP pinning below
        CURLOPT_CONNECTTIMEOUT => min(NR_CONNECT_TIMEOUT, $timeout),
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_LOW_SPEED_LIMIT => NR_LOW_SPEED_LIMIT,
        CURLOPT_LOW_SPEED_TIME => NR_LOW_SPEED_TIME,
        CURLOPT_USERAGENT      => NR_USER_AGENT,
        CURLOPT_ENCODING       => '',
        CURLOPT_PROTOCOLS      => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_HTTPHEADER     => ['Accept: ' . $accept, 'Accept-Language: en,de;q=0.8', ...$extraHeaders],
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HEADERFUNCTION => function ($ch, string $line) use (&$headers): int {
            if (preg_match('#^HTTP/\S+\s+\d+#', $line)) {
                $headers = [];
            }
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) {
                $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
            }
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION  => function ($ch, string $chunk) use (&$body, &$tooLarge): int {
            if (strlen($body) + strlen($chunk) > NR_MAX_BODY_BYTES) {
                $tooLarge = true;
                return 0;
            }
            $body .= $chunk;
            return strlen($chunk);
        },
    ]);

    // INFO: connect to exactly the addresses nr_validate_target() approved (no DNS rebinding)
    $host = trim((string)parse_url($url, PHP_URL_HOST), '[]');
    $pin = nr_pinned_ips($host);
    if ($pin) {
        $addr = str_contains($pin[0], ':') ? '[' . $pin[0] . ']' : $pin[0];
        // INFO: "-host:port" drops an entry an earlier request of this handle added
        $hostPort = $host . ':' . nr_url_port($url);
        curl_setopt($ch, CURLOPT_RESOLVE, ['-' . $hostPort, $hostPort . ':' . $addr]);
    }

    if (NR_CA_BUNDLE !== '' && is_file(NR_CA_BUNDLE)) {
        curl_setopt($ch, CURLOPT_CAINFO, NR_CA_BUNDLE);
    } elseif (PHP_OS_FAMILY === 'Windows' && defined('CURLSSLOPT_NATIVE_CA') && !ini_get('curl.cainfo')) {
        curl_setopt($ch, CURLOPT_SSL_OPTIONS, CURLSSLOPT_NATIVE_CA);
    }

    $ok = curl_exec($ch);

    return [
        'status'   => (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE),
        'headers'  => $headers,
        'body'     => $body,
        'error'    => $ok === false && !$tooLarge ? curl_error($ch) : null,
        'tooLarge' => $tooLarge,
    ];
}

// INFO: fallback without ext-curl (HTTPS needs ext-openssl)
function nr_request_stream(string $url, string $accept, int $timeout, array $extraHeaders = []): array
{
    $fail = fn(string $msg) => ['status' => 0, 'headers' => [], 'body' => '', 'error' => $msg, 'tooLarge' => false];

    if (str_starts_with(strtolower($url), 'https:') && !extension_loaded('openssl')) {
        return $fail('Neither ext-curl nor ext-openssl is enabled in PHP.');
    }
    if (!ini_get('allow_url_fopen')) {
        return $fail('ext-curl is not enabled and allow_url_fopen is off.');
    }

    $p = parse_url($url);
    $host = trim((string)($p['host'] ?? ''), '[]');
    $requestUrl = $url;
    $headers = [
        'User-Agent: ' . NR_USER_AGENT,
        'Accept: ' . $accept,
        'Accept-Language: en,de;q=0.8',
        'Accept-Encoding: gzip',
        'Connection: close',
        ...$extraHeaders,
    ];
    // INFO: same IP pinning as with curl – connect to the validated address, keep Host header and TLS name
    $pin = nr_pinned_ips($host);
    if ($pin) {
        $addr = str_contains($pin[0], ':') ? '[' . $pin[0] . ']' : $pin[0];
        $requestUrl = $p['scheme'] . '://' . $addr . (isset($p['port']) ? ':' . $p['port'] : '')
            . ($p['path'] ?? '/') . (isset($p['query']) ? '?' . $p['query'] : '');
        $headers[] = 'Host: ' . $host . (isset($p['port']) ? ':' . $p['port'] : '');
    }

    $context = stream_context_create([
        'http' => [
            'method'           => 'GET',
            'follow_location'  => 0,
            'ignore_errors'    => true,
            'timeout'          => $timeout,
            'protocol_version' => 1.1,
            'header'           => implode("\r\n", $headers),
        ],
        'ssl' => array_filter([
            'verify_peer'      => true,
            'verify_peer_name' => true,
            'peer_name'        => $host,
            'SNI_enabled'      => true,
            'cafile'           => NR_CA_BUNDLE !== '' && is_file(NR_CA_BUNDLE) ? NR_CA_BUNDLE : null,
        ], fn($v) => $v !== null),
    ]);

    $err = null;
    set_error_handler(function (int $no, string $msg) use (&$err): bool { $err = $msg; return true; });
    $fp = fopen($requestUrl, 'rb', false, $context);
    restore_error_handler();

    if ($fp === false) {
        return $fail(preg_replace('/^fopen\([^)]*\):\s*/', '', (string)$err) ?: 'connection failed');
    }

    // INFO: same low-speed abort as with curl: every read waits at most NR_LOW_SPEED_TIME seconds, and the
    //       average rate must reach NR_LOW_SPEED_LIMIT once NR_LOW_SPEED_TIME seconds have passed
    stream_set_timeout($fp, min($timeout, NR_LOW_SPEED_TIME));
    $start = microtime(true);
    $body = '';
    $tooLarge = false;
    while (!feof($fp)) {
        $chunk = fread($fp, 65536);
        if ($chunk === false) break;
        $body .= $chunk;
        if (strlen($body) > NR_MAX_BODY_BYTES) { $tooLarge = true; break; }
        $elapsed = microtime(true) - $start;
        if ($elapsed > $timeout || stream_get_meta_data($fp)['timed_out']) {
            fclose($fp);
            return $fail('timeout');
        }
        if ($elapsed >= NR_LOW_SPEED_TIME && strlen($body) / $elapsed < NR_LOW_SPEED_LIMIT) {
            fclose($fp);
            return $fail('transfer too slow');
        }
    }
    $meta = stream_get_meta_data($fp);
    fclose($fp);

    $status = 0;
    $headers = [];
    foreach ($meta['wrapper_data'] ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) {
            $status = (int)$m[1];
            $headers = [];
            continue;
        }
        $parts = explode(':', $line, 2);
        if (count($parts) === 2) {
            $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
        }
    }

    if (!$tooLarge && str_contains(strtolower($headers['content-encoding'] ?? ''), 'gzip')) {
        $decoded = nr_gunzip($body);
        if ($decoded === null) $tooLarge = true;
        else $body = $decoded;
    }
    return ['status' => $status, 'headers' => $headers, 'body' => $body, 'error' => null, 'tooLarge' => $tooLarge];
}

// INFO: bounded gzip decoding (no decompression bombs); null if invalid or larger than NR_MAX_BODY_BYTES
function nr_gunzip(string $data): ?string
{
    set_error_handler(fn() => true);
    try {
        $out = gzdecode($data, NR_MAX_BODY_BYTES);
    } finally {
        restore_error_handler();
    }
    // INFO: gzdecode()'s length limit works in buffer steps – the exact cap is checked here
    return $out === false || strlen($out) > NR_MAX_BODY_BYTES ? null : $out;
}

// INFO: returns an error array if the URL must not be fetched, null otherwise
function nr_validate_target(string $url): ?array
{
    $p = parse_url($url);
    $scheme = strtolower((string)($p['scheme'] ?? ''));
    $host = (string)($p['host'] ?? '');

    if (!in_array($scheme, ['http', 'https'], true) || $host === '' || isset($p['user']) || isset($p['pass'])) {
        return nr_err('UNSUPPORTED_URL', 'Only absolute HTTP(S) URLs without credentials are supported.');
    }

    if (NR_ALLOW_PRIVATE_HOSTS) {
        return null;
    }

    if (!in_array(nr_url_port($url), NR_ALLOWED_PORTS, true)) {
        return nr_err('FORBIDDEN_HOST', 'Only the ports ' . implode(', ', NR_ALLOWED_PORTS) . ' are allowed.');
    }

    $host = strtolower(trim($host, '[]'));
    // INFO: every hop is checked, but a host is resolved only once per request
    $ips = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : (nr_pinned_ips($host) ?: nr_resolve_host($host));

    if ($ips === []) {
        return nr_err('DNS_FAILED', 'The host could not be resolved.');
    }
    foreach ($ips as $ip) {
        if (!nr_is_public_ip($ip)) {
            return nr_err('FORBIDDEN_HOST', 'Private, loopback or reserved addresses are not allowed.');
        }
    }

    nr_pinned_ips($host, $ips);
    return null;
}

function nr_url_port(string $url): int
{
    $port = parse_url($url, PHP_URL_PORT);
    if (is_int($port)) return $port;
    return str_starts_with(strtolower($url), 'https:') ? 443 : 80;
}

// INFO: public unicast only; unwraps IPv4-mapped, SIIT (::ffff:0:0/96), IPv4-compatible, NAT64 and 6to4 addresses
function nr_is_public_ip(string $ip): bool
{
    $flags = FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE | (defined('FILTER_FLAG_GLOBAL_RANGE') ? FILTER_FLAG_GLOBAL_RANGE : 0);
    if (!filter_var($ip, FILTER_VALIDATE_IP, $flags)) return false;

    $bin = inet_pton($ip);
    if ($bin === false) return false;

    if (strlen($bin) === 4) {
        $a = ord($bin[0]);
        $b = ord($bin[1]);
        return $a !== 0
            && !($a === 100 && $b >= 64 && $b <= 127)   // INFO: 100.64.0.0/10 carrier-grade NAT
            && !($a === 198 && ($b & 0xfe) === 18)      // INFO: 198.18.0.0/15 benchmarking
            && $a < 224;                                // INFO: multicast and reserved
    }

    $prefix = substr($bin, 0, 12);
    $zero8 = str_repeat("\0", 8);
    if ($prefix === $zero8 . "\0\0\xff\xff" || $prefix === $zero8 . "\xff\xff\0\0" || $prefix === $zero8 . "\0\0\0\0" || $prefix === "\x00\x64\xff\x9b" . $zero8) {
        $v4 = inet_ntop(substr($bin, 12));
        return $v4 !== false && nr_is_public_ip($v4);
    }
    if (str_starts_with($bin, "\x20\x02")) {
        $v4 = inet_ntop(substr($bin, 2, 4));
        return $v4 !== false && nr_is_public_ip($v4);
    }
    $first = ord($bin[0]);
    $second = ord($bin[1]);
    return ($first & 0xfe) !== 0xfc                               // INFO: fc00::/7 ULA
        && !($first === 0xfe && ($second & 0x80) === 0x80)         // INFO: fe80::/10 link-local, fec0::/10 site-local
        && $first !== 0xff                                         // INFO: ff00::/8 multicast
        && !str_starts_with($bin, "\x00\x64\xff\x9b\x00\x01")        // INFO: 64:ff9b:1::/48 local-use NAT64
        && !($first === 0x3f && $second === 0xff && (ord($bin[2]) & 0xf0) === 0) // INFO: 3fff::/20 documentation
        && !($first === 0x5f && $second === 0x00);                 // INFO: 5f00::/16 SRv6 SIDs
}

// INFO: validated addresses per host for the current request – set with $ips, read without
function nr_pinned_ips(string $host, ?array $ips = null): array
{
    static $pins = [];
    $host = strtolower(trim($host, '[]'));
    if ($ips !== null) $pins[$host] = array_values($ips);
    return $pins[$host] ?? [];
}

function nr_resolve_host(string $host): array
{
    $ips = [];
    foreach (@dns_get_record($host, DNS_A | DNS_AAAA) ?: [] as $r) {
        if (!empty($r['ip']))   $ips[] = $r['ip'];
        if (!empty($r['ipv6'])) $ips[] = $r['ipv6'];
    }
    if ($ips === []) {
        $v4 = gethostbynamel($host);
        if (is_array($v4)) $ips = $v4;
    }
    return array_values(array_unique($ips));
}

function nr_err(string $code, string $message, array $extra = []): array
{
    return ['ok' => false, 'code' => $code, 'message' => $message] + $extra;
}

function nr_is_http_url(string $url): bool
{
    return strlen($url) <= 2048 && preg_match('#^https?://[^/\s?\#]+#i', $url) === 1;
}

// INFO: $decode = false for URLs that are no HTML (Location headers, robots.txt) – "&amp;" there is literal
function nr_absolute_url(string $href, string $base, bool $decode = true): string
{
    $href = trim($decode ? html_entity_decode($href, ENT_QUOTES | ENT_HTML5) : $href);
    if ($href === '') return $base;
    if (preg_match('#^[a-z][a-z0-9+.-]*:#i', $href)) return $href;

    $b = parse_url($base);
    $scheme = $b['scheme'] ?? 'https';
    $authority = ($b['host'] ?? '') . (isset($b['port']) ? ':' . $b['port'] : '');

    if (str_starts_with($href, '//')) return $scheme . ':' . $href;
    if (str_starts_with($href, '#'))  return preg_replace('/#.*$/', '', $base) . $href;
    if (str_starts_with($href, '?'))  return $scheme . '://' . $authority . ($b['path'] ?? '/') . $href;

    if (str_starts_with($href, '/')) {
        $path = $href;
    } else {
        $basePath = $b['path'] ?? '/';
        $path = substr($basePath, 0, (int)strrpos($basePath, '/') + 1) . $href;
    }

    $query = '';
    if (($qpos = strpos($path, '?')) !== false) {
        $query = substr($path, $qpos);
        $path = substr($path, 0, $qpos);
    }
    $out = [];
    foreach (explode('/', $path) as $seg) {
        if ($seg === '..') { array_pop($out); continue; }
        if ($seg === '.')  continue;
        $out[] = $seg;
    }
    $path = implode('/', $out);
    if (!str_starts_with($path, '/')) $path = '/' . $path;

    return $scheme . '://' . $authority . $path . $query;
}

function nr_origin(string $url): string
{
    $p = parse_url($url);
    return ($p['scheme'] ?? 'https') . '://' . ($p['host'] ?? '') . (isset($p['port']) ? ':' . $p['port'] : '');
}

// INFO: canonical form, used as cache key and for de-duplication
function nr_normalize_url(string $url): string
{
    $p = parse_url($url);
    $scheme = strtolower((string)($p['scheme'] ?? ''));
    $host = strtolower((string)($p['host'] ?? ''));
    $port = isset($p['port']) ? (int)$p['port'] : 0;
    if (($scheme === 'http' && $port === 80) || ($scheme === 'https' && $port === 443)) $port = 0;

    $path = $p['path'] ?? '/';
    if ($path !== '/') $path = rtrim($path, '/');
    $query = isset($p['query']) ? '?' . $p['query'] : '';

    return $scheme . '://' . $host . ($port ? ':' . $port : '') . $path . $query;
}
