<?php
declare(strict_types=1);

// INFO: CORS is open on purpose – the API has no cookies; sync is authorised by a bearer token only
function nr_api_headers(string $methods, string $allowHeaders = 'Content-Type'): void
{
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: ' . $methods . ', OPTIONS');
    header('Access-Control-Allow-Headers: ' . $allowHeaders);
    header('Access-Control-Max-Age: 86400');
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
    header('Referrer-Policy: no-referrer');
    header('X-Robots-Tag: noindex');
}

function nr_json(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function nr_error(string $code, string $message, int $status, array $extra = []): never
{
    nr_json(['error' => ['code' => $code, 'message' => $message]] + $extra, $status);
}

function nr_iso(int $ts): string
{
    return gmdate('Y-m-d\TH:i:s\Z', $ts);
}
