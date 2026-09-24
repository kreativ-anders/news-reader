<?php
declare(strict_types=1);

/**
 * Fetch a URL with hard limits. Redirects are followed manually so that
 * every hop is validated (scheme + SSRF check).
 *
 * @return array{ok:bool, body?:string, contentType?:string, finalUrl?:string, status?:int, code?:string, message?:string}
 */
function ff_fetch(string $url): array
{
    $current = $url;

    for ($hop = 0; $hop <= FF_MAX_REDIRECTS; $hop++) {
        $check = ff_validate_target($current);
        if ($check !== null) {
            return $check;
        }

        $res = extension_loaded('curl') ? ff_request_curl($current) : ff_request_stream($current);

        if ($res['tooLarge']) {
            return ff_err('UPSTREAM_TOO_LARGE', 'The source response exceeded ' . FF_MAX_BODY_BYTES . ' bytes.');
        }
        if ($res['error'] !== null) {
            return ff_err('UPSTREAM_FETCH_FAILED', 'The source could not be fetched: ' . $res['error']);
        }

        $status = $res['status'];
        $headers = $res['headers'];

        if ($status >= 300 && $status < 400 && isset($headers['location'])) {
            $current = ff_absolute_url($headers['location'], $current);
            continue;
        }

        if ($status >= 400) {
            return ff_err('UPSTREAM_HTTP_ERROR', 'The source returned HTTP ' . $status . '.', ['status' => $status]);
        }

        return [
            'ok'          => true,
            'body'        => $res['body'],
            'contentType' => strtolower($headers['content-type'] ?? ''),
            'finalUrl'    => $current,
            'status'      => $status,
        ];
    }

    return ff_err('TOO_MANY_REDIRECTS', 'More than ' . FF_MAX_REDIRECTS . ' redirects.');
}

const FF_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.1';

/**
 * Single HTTP GET without following redirects.
 * @return array{status:int, headers:array<string,string>, body:string, error:?string, tooLarge:bool}
 */
function ff_request_curl(string $url): array
{
    $body = '';
    $tooLarge = false;
    $headers = [];

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => FF_CONNECT_TIMEOUT,
        CURLOPT_TIMEOUT        => FF_REQUEST_TIMEOUT,
        CURLOPT_USERAGENT      => FF_USER_AGENT,
        CURLOPT_ENCODING       => '',   // accept gzip/deflate/br
        CURLOPT_PROTOCOLS      => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_HTTPHEADER     => ['Accept: ' . FF_ACCEPT, 'Accept-Language: en,de;q=0.8'],
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HEADERFUNCTION => function ($ch, string $line) use (&$headers): int {
            if (preg_match('#^HTTP/\S+\s+\d+#', $line)) {
                $headers = []; // new response block (e.g. after 100 Continue)
            }
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) {
                $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
            }
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION  => function ($ch, string $chunk) use (&$body, &$tooLarge): int {
            if (strlen($body) + strlen($chunk) > FF_MAX_BODY_BYTES) {
                $tooLarge = true;
                return 0; // abort transfer
            }
            $body .= $chunk;
            return strlen($chunk);
        },
    ]);

    // CA certificates: explicit bundle > OS certificate store (Windows) > curl default
    if (FF_CA_BUNDLE !== '' && is_file(FF_CA_BUNDLE)) {
        curl_setopt($ch, CURLOPT_CAINFO, FF_CA_BUNDLE);
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

/** Fallback when ext-curl is not loaded: PHP stream wrapper (needs ext-openssl for HTTPS). */
function ff_request_stream(string $url): array
{
    $fail = fn(string $msg) => ['status' => 0, 'headers' => [], 'body' => '', 'error' => $msg, 'tooLarge' => false];

    if (str_starts_with(strtolower($url), 'https:') && !extension_loaded('openssl')) {
        return $fail('Neither ext-curl nor ext-openssl is enabled in PHP.');
    }
    if (!ini_get('allow_url_fopen')) {
        return $fail('ext-curl is not enabled and allow_url_fopen is off.');
    }

    $context = stream_context_create([
        'http' => [
            'method'          => 'GET',
            'follow_location' => 0,
            'ignore_errors'   => true,   // read body on 4xx/5xx as well
            'timeout'         => FF_REQUEST_TIMEOUT,
            'protocol_version'=> 1.1,
            'header'          => implode("\r\n", [
                'User-Agent: ' . FF_USER_AGENT,
                'Accept: ' . FF_ACCEPT,
                'Accept-Language: en,de;q=0.8',
                'Accept-Encoding: gzip',
                'Connection: close',
            ]),
        ],
        'ssl' => array_filter([
            'verify_peer'      => true,
            'verify_peer_name' => true,
            'cafile'           => FF_CA_BUNDLE !== '' && is_file(FF_CA_BUNDLE) ? FF_CA_BUNDLE : null,
        ], fn($v) => $v !== null),
    ]);

    $err = null;
    set_error_handler(function (int $no, string $msg) use (&$err): bool { $err = $msg; return true; });
    $fp = fopen($url, 'rb', false, $context);
    restore_error_handler();

    if ($fp === false) {
        return $fail(preg_replace('/^fopen\([^)]*\):\s*/', '', (string)$err) ?: 'connection failed');
    }

    $start = microtime(true);
    $body = '';
    $tooLarge = false;
    while (!feof($fp)) {
        $chunk = fread($fp, 65536);
        if ($chunk === false) break;
        $body .= $chunk;
        if (strlen($body) > FF_MAX_BODY_BYTES) { $tooLarge = true; break; }
        if (microtime(true) - $start > FF_REQUEST_TIMEOUT) {
            fclose($fp);
            return $fail('timeout');
        }
    }
    $meta = stream_get_meta_data($fp);
    fclose($fp);

    // Parse headers of the (last) response
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
        $decoded = @gzdecode($body);
        if ($decoded !== false) $body = $decoded;
    }
    return ['status' => $status, 'headers' => $headers, 'body' => $body, 'error' => null, 'tooLarge' => $tooLarge];
}

/** Returns an error array if the URL must not be fetched, null otherwise. */
function ff_validate_target(string $url): ?array
{
    $p = parse_url($url);
    $scheme = strtolower((string)($p['scheme'] ?? ''));
    $host = (string)($p['host'] ?? '');

    if (!in_array($scheme, ['http', 'https'], true) || $host === '') {
        return ff_err('UNSUPPORTED_URL', 'Only absolute HTTP(S) URLs are supported.');
    }

    if (FF_ALLOW_PRIVATE_HOSTS) {
        return null;
    }

    $host = trim($host, '[]');
    $ips = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : ff_resolve_host($host);

    if ($ips === []) {
        return ff_err('DNS_FAILED', 'The host could not be resolved.');
    }

    foreach ($ips as $ip) {
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
            return ff_err('FORBIDDEN_HOST', 'Private, loopback or reserved addresses are not allowed.');
        }
    }

    return null;
}

function ff_resolve_host(string $host): array
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

function ff_err(string $code, string $message, array $extra = []): array
{
    return ['ok' => false, 'code' => $code, 'message' => $message] + $extra;
}

// ---------------------------------------------------------------- URL helpers

function ff_absolute_url(string $href, string $base): string
{
    $href = trim(html_entity_decode($href, ENT_QUOTES | ENT_HTML5));
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
        $dir = substr($basePath, 0, (int)strrpos($basePath, '/') + 1);
        $path = $dir . $href;
    }

    // Resolve ./ and ../ segments
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

function ff_origin(string $url): string
{
    $p = parse_url($url);
    return ($p['scheme'] ?? 'https') . '://' . ($p['host'] ?? '') . (isset($p['port']) ? ':' . $p['port'] : '');
}

/** Canonical form used as cache key. */
function ff_normalize_url(string $url): string
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
