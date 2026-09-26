<?php
declare(strict_types=1);

const NR_VERSION = '0.4.1';
const NR_VAR_DIR = __DIR__ . '/../var';

// INFO: Collector (/api/collect)
const NR_CACHE_DIR          = NR_VAR_DIR . '/cache';
const NR_CACHE_TTL          = 86400;      // INFO: seconds a feed is served from cache without contacting the source
const NR_STALE_TTL          = 604800;     // INFO: seconds a stale feed may be served while the source is down
const NR_ERROR_TTL          = 3600;       // INFO: seconds "no feed found" results are cached
const NR_REFRESH_MIN_AGE    = 900;        // INFO: ?refresh=1 is ignored for younger cache entries
const NR_CACHE_GC_AGE       = 1209600;    // INFO: cache and lock files untouched this long are deleted
const NR_MAX_ENTRIES        = 100;
const NR_MAX_PARSE_ITEMS    = 1000;       // INFO: feed items / listing elements inspected at most (CPU bound)
const NR_MAX_BODY_BYTES     = 5_000_000;  // INFO: also caps the decompressed size
const NR_CONNECT_TIMEOUT    = 5;
const NR_REQUEST_TIMEOUT    = 15;
const NR_TIME_BUDGET        = 60;         // INFO: wall-clock seconds for all upstream requests of one API call
const NR_MAX_REDIRECTS      = 5;
const NR_MAX_CHILD_SITEMAPS = 3;
const NR_SUMMARY_LENGTH     = 300;
const NR_CACHE_SCHEMA       = 3;          // INFO: bump when the entry format changes – older cache files are ignored
const NR_USER_AGENT         = 'NewsReader-Collector/' . NR_VERSION . ' (+https://news-reader.app)';

// INFO: Articles (/api/article) – offline copies for "Later"
const NR_FULLTEXT_MIN_CHARS = 1200;       // INFO: shorter feed content counts as teaser
const NR_ARTICLE_MAX_BYTES  = 400_000;
const NR_ARTICLE_TTL        = 604800;
const NR_ARTICLE_ERROR_TTL  = 3600;

// WARNING: disables the SSRF protection. Only for local testing against private hosts – never in production.
const NR_ALLOW_PRIVATE_HOSTS = false;
// INFO: upstream ports the Collector may connect to (blocks port scans and cross-protocol requests)
const NR_ALLOWED_PORTS = [80, 443, 8080, 8443];

// INFO: optional CA bundle (e.g. cacert.pem from curl.se); '' = OS store on Windows, PHP defaults elsewhere
const NR_CA_BUNDLE = '';

// INFO: Sync (/api/sync) – one end-to-end encrypted blob per vault in var/sync/
const NR_SYNC_ENABLED     = true;
const NR_SYNC_DIR         = NR_VAR_DIR . '/sync';
const NR_SYNC_MAX_BYTES   = 1_000_000;    // WARNING: keep <= nginx client_max_body_size
const NR_SYNC_EXPIRE_DAYS = 180;
const NR_SYNC_MAX_VAULTS  = 10_000;

// INFO: CIDR allow-list for sync clients (REMOTE_ADDR), [] = everyone.
//       Example: ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']
// WARNING: behind a reverse proxy REMOTE_ADDR is the proxy – configure real_ip in nginx.
const NR_SYNC_ALLOWED_NETS = [];

// INFO: rate limits per client as [requests, window seconds]; IPv6 clients are grouped per /64
const NR_RATE_DIR          = NR_VAR_DIR . '/rate';
const NR_RATE_COLLECT_MISS = [60, 600];
const NR_RATE_ARTICLE_MISS = [30, 600];
const NR_RATE_SYNC         = [300, 600];
const NR_RATE_SYNC_CREATE  = [5, 86400];
