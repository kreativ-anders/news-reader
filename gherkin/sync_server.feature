# Source: api/index.php, src/sync.php, src/gc.php, src/config.php
# Implementation: src/sync.php
@api @sync
Feature: The sync server keeps sealed sync data safe and bounded
  Requests, ETags and forwards are executable in executable/sync_protocol.feature. This feature covers
  storage, limits and operation.

  Scenario: The token never touches the disk
    When sync data is stored
    Then the file is named by the SHA-256 of the bearer token
    And the token itself appears nowhere on disk

  Scenario: Concurrent creates
    When several devices create sync data for the same key at once
    Then exactly one wins and the others get 412 "CONFLICT"

  Scenario: Browsers may call the API from anywhere
    Then the CORS preflight allows Authorization, If-Match and If-None-Match
    And answers expose the ETag

  Scenario: Sync data expires when no device reads it
    Then sync data that was not read for 180 days is removed
    And reading refreshes the expiry at most once a day

  Scenario: The server has limits
    Then at most 10 000 sync data files are stored, more gets 507 "SERVER_FULL"
    And creating is rate limited per client and for all clients together
    And an operator can switch sync off ("SYNC_DISABLED") or allow only some networks ("FORBIDDEN_NETWORK")
