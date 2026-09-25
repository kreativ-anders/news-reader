<?php
declare(strict_types=1);

// News Reader – server configuration (Collector + Sync)
const NR_VERSION          = '0.3.0';
const NR_VAR_DIR          = __DIR__ . '/../var';

// ------------------------------------------------------------------ Collector (/api/collect)
const NR_CACHE_DIR        = NR_VAR_DIR . '/cache';
const NR_CACHE_TTL        = 86400;    // 24 h: serve from cache without contacting the source
const NR_STALE_TTL        = 604800;   // 7 d: serve stale cache if the source is down
const NR_ERROR_TTL        = 3600;     // 1 h: cache "no feed found" / upstream errors
const NR_REFRESH_MIN_AGE  = 900;      // ?refresh=1 only honoured if cache is older than 15 min
const NR_MAX_ENTRIES      = 100;
const NR_MAX_BODY_BYTES   = 5_000_000;
const NR_CONNECT_TIMEOUT  = 5;
const NR_REQUEST_TIMEOUT  = 15;
const NR_MAX_REDIRECTS    = 5;
const NR_MAX_CHILD_SITEMAPS = 3;      // sitemap index: only the newest N child sitemaps are fetched
const NR_SUMMARY_LENGTH   = 300;
const NR_USER_AGENT       = 'NewsReader-Collector/' . NR_VERSION . ' (+https://newsreader.app)';

// SSRF protection: block loopback / private / link-local targets.
// Set to true only for local testing against private hosts.
const NR_ALLOW_PRIVATE_HOSTS = false;

// Optional path to a CA bundle (e.g. cacert.pem from https://curl.se/docs/caextract.html).
// Empty = use the OS certificate store on Windows / PHP defaults elsewhere.
const NR_CA_BUNDLE = '';

// ------------------------------------------------------------------ Sync (/api/sync)
// End-to-end encrypted, account-free and database-free: one opaque blob per vault
// in var/sync/. The server never sees the vault key and cannot read the content.
const NR_SYNC_ENABLED        = true;
const NR_SYNC_DIR            = NR_VAR_DIR . '/sync';
const NR_SYNC_MAX_BYTES      = 1_000_000;  // max. size of one encrypted vault (keep <= nginx client_max_body_size)
const NR_SYNC_EXPIRE_DAYS    = 180;        // vaults untouched for this long are deleted
const NR_SYNC_MAX_VAULTS     = 10_000;     // hard cap for the whole server (disk protection)

// Who may sync (REMOTE_ADDR). [] = everyone – safe, because the payload is end-to-end
// encrypted and every client is rate limited. Restrict e.g. to your own network:
// ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']
// Behind a reverse proxy REMOTE_ADDR is the proxy – configure real_ip in nginx.
const NR_SYNC_ALLOWED_NETS = [];

// ------------------------------------------------------------------ Rate limits (per client IP, file based)
// [requests, window in seconds]. Only the IP's salted hash is stored, for one window.
const NR_RATE_DIR            = NR_VAR_DIR . '/rate';
const NR_RATE_COLLECT_MISS   = [60, 600];   // Collector: upstream fetches (cache hits are free)
const NR_RATE_SYNC           = [300, 600];  // Sync: all requests
const NR_RATE_SYNC_CREATE    = [5, 86400];  // Sync: new vaults per IP and day
