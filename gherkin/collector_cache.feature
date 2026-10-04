# Source: src/cache.php, src/gc.php, src/resolver.php, src/config.php
# Implementation: src/cache.php
@api @cache
Feature: Sources are fetched once and shared by everyone who follows them
  The Collector keeps one copy per source on disk, no database. Copies are bounded in age and size and cleaned
  up without cron.

  Scenario: One copy per source, not per requested address
    Given "blog.com", "blog.com/?utm_source=x" and "blog.com/feed" resolve to the same feed
    Then they share one cached copy, one lifetime and one refresh window
    And only addresses the server fetched itself become cache keys

  Scenario: A page cannot change what another feed's readers see
    Given a page points at someone else's feed
    Then title, icon and site link of that page stay in the record of the requested address only

  Scenario: Copies live 24 hours and a refresh needs 15 minutes
    Then a cached copy is served for 24 hours
    And "refresh=1" bypasses the cache only for copies older than 15 minutes

  Scenario: A stale copy is served while the source is down
    Given a refresh fails
    Then the copy of the last 7 days is served with "stale" and the error in "lastError"
    And a stale copy without "lastError" means the source was not asked this time

  Scenario: Errors are cached per requested address
    Then "NO_FEED_DETECTED", "PLATFORM_NO_FEED" and 401/403 answers are cached for 1 hour
    And temporary upstream failures for 2 minutes

  Scenario: Only one request fetches a source at a time
    Given another request is fetching the same source
    Then the next request waits at most 20 seconds
    And then gets the stale copy or 503 "BUSY" with Retry-After

  Scenario: Unchanged answers are not sent again
    Then cached answers carry a weak ETag and "If-None-Match" gets 304
    And a refresh asks the source conditionally and reports "REVALIDATED" when it answered 304

  Scenario: The cache stays within its budget
    Then the cache never grows beyond 1 GB and stores nothing when less than 256 MB disk is free
    And once an hour one request deletes expired files and the oldest beyond the budget after its response
