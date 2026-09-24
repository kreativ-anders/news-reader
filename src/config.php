<?php
declare(strict_types=1);

// FeedForge configuration
const FF_VERSION          = '0.2.0';
const FF_CACHE_DIR        = __DIR__ . '/../var/cache';
const FF_CACHE_TTL        = 86400;    // 24 h: serve from cache without contacting the source
const FF_STALE_TTL        = 604800;   // 7 d: serve stale cache if the source is down
const FF_ERROR_TTL        = 3600;     // 1 h: cache "no feed found" / upstream errors
const FF_REFRESH_MIN_AGE  = 900;      // ?refresh=1 only honoured if cache is older than 15 min
const FF_MAX_ENTRIES      = 100;
const FF_MAX_BODY_BYTES   = 5_000_000;
const FF_CONNECT_TIMEOUT  = 5;
const FF_REQUEST_TIMEOUT  = 15;
const FF_MAX_REDIRECTS    = 5;
const FF_MAX_CHILD_SITEMAPS = 3;      // sitemap index: only the newest N child sitemaps are fetched
const FF_SUMMARY_LENGTH   = 300;
const FF_USER_AGENT       = 'FeedForge/' . FF_VERSION . ' (+local feed resolver)';

// SSRF protection: block loopback / private / link-local targets.
// Set to true only for local testing against private hosts.
const FF_ALLOW_PRIVATE_HOSTS = false;

// Optional path to a CA bundle (e.g. cacert.pem from https://curl.se/docs/caextract.html).
// Empty = use the OS certificate store on Windows / PHP defaults elsewhere.
const FF_CA_BUNDLE = '';

// ------------------------------------------------------------------ Flint sync (/api/sync)
// Optional, account-free state store for the Flint reader (see README → "Flint sync").
const FF_SYNC_ENABLED          = true;
const FF_SYNC_DB               = __DIR__ . '/../var/sync/flint.sqlite';
const FF_SYNC_MAX_BATCH        = 1000;       // records per request
const FF_SYNC_MAX_BODY_BYTES   = 1_000_000;  // keep <= nginx client_max_body_size
const FF_SYNC_MAX_RECORD_BYTES = 16_384;     // JSON size of one record's data
const FF_SYNC_MAX_CLOCK_SKEW   = 300_000;    // ms: client timestamps are clamped to server time + 5 min

// Who may sync (REMOTE_ADDR). Default: loopback + private networks only ("own network").
// Use [] to allow every client (then protect the endpoint otherwise, e.g. VPN / reverse proxy).
const FF_SYNC_ALLOWED_NETS = [
    '127.0.0.0/8', '::1/128',
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
    'fc00::/7', 'fe80::/10',
];
