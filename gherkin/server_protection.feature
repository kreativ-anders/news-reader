# Source: src/http.php, src/ratelimit.php, src/config.php, src/response.php, api/index.php, nginx.conf.example, wharf.conf.example
# Implementation: src/http.php
@api @security
Feature: The server is safe to run on the open internet
  Every input is assumed hostile. Upstream requests go only through src/http.php and every fetch, parse and
  write is bounded in size, time, count and disk.

  Rule: No request reaches the inside

    Scenario: Only public web addresses are fetched
      Then only http(s) without credentials on ports 80, 443, 8080 and 8443 is fetched
      And loopback, private, link-local, CGNAT, reserved, documentation and embedded IPv4 ranges are refused with 400 "FORBIDDEN_HOST"
      And every redirect hop is checked again, at most 5

    Scenario: No DNS rebinding
      Then the connection is pinned to the checked IP addresses
      And proxies from the environment are ignored

  Rule: Every fetch is bounded

    Scenario: Size and time limits
      Then a body is capped at 5 MB, also after decompression
      And slow sources are aborted and one API call has a 60-second budget for all its upstream requests
      And XML is parsed without network access and without entity expansion

    Scenario: Slow sources cannot tie up every worker
      Then at most 8 upstream fetches run at once, 2 per client
      And more get 503 "BUSY" with Retry-After

  Rule: Clients are rate limited

    Scenario: Fetches that reach a source are counted
      Then each client may cause 60 Collector and 30 article fetches per 10 minutes
      And cache hits and "BUSY" answers are free
      And over the limit the answer is 429 "RATE_LIMITED" with Retry-After, or the stale copy if there is one

    Scenario: IPv6 networks count together
      Then IPv6 clients are counted per /64 and additionally per /48

  Rule: Internal files are never served

    Scenario: Blocked paths
      Then /src, /var, /tests, /tools, /gherkin, dotfiles, config and doc files and sync data files are never served

    Scenario: API answers are inert
      Then API answers carry "Content-Security-Policy: default-src 'none'" and "nosniff" and set no cookies
      And errors are JSON with an UPPER_SNAKE code and a message
