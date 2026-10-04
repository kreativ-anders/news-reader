# Source: app/js/app.js, app/js/feeds.js, app/js/sync.js
# Implementation: app/js/app.js
@app @refresh
Feature: New posts are fetched without nagging the sources
  Opening the app looks for new posts on its own; a manual refresh is always possible but paced, because the
  Collector does not refetch a source within 15 minutes anyway.

  Scenario: Opening the app looks for new posts
    Given the last refresh was more than 15 minutes ago
    When I start the app or return to it
    Then all feeds are refreshed without a toast
    And the header shows "Looking for new posts…" under the logo with a progress line
    And then the number of new posts for 4 seconds

  Scenario: Returning within 15 minutes does not refresh
    Given the last refresh was less than 15 minutes ago
    When I return to the app
    Then nothing is fetched
    And the header says when it last checked

  Scenario: Refresh forces every feed
    When I choose Refresh or press "r"
    Then every feed is fetched
    And entries and decisions are kept
    And a toast reports the number of new posts

  Scenario: Refresh buttons pause after use
    Given I just refreshed manually
    Then the refresh buttons pause for 60 seconds (per feed in the feed list)
    And a click on a paused button explains the wait instead of fetching

  Scenario: Retries skip feeds that cannot have changed
    Given a refresh is retried after "BUSY" or "RATE_LIMITED"
    Then feeds whose server copy cannot have changed yet are skipped

  Scenario: Sync runs on its own
    Given this device is paired
    Then sync runs every 5 minutes while the app is visible
    And 20 seconds after a local change
    And immediately when the app is hidden or closed
