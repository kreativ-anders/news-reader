# Source: app/js/app.js, app/js/db.js, app/js/sync.js
# Implementation: app/js/app.js
@app @retention
Feature: Old posts go away on their own, Later never does
  The device keeps what is useful and drops the rest on a fixed schedule – the same on every device
  (exact periods: executable/pruning.feature).

  Scenario: A new feed starts with recent posts
    When I follow a new feed
    Then the Inbox shows its posts of the last 14 days, at least its 3 newest

  Scenario: Long-followed feeds do not flood the Inbox
    Given I follow a feed for more than 30 days
    Then its posts reach the Inbox from at most 30 days back

  Scenario: Posts I never sorted disappear
    Given a post left its feed and is older than 30 days
    And I never made a decision on it
    Then it is removed

  Scenario: Pruning runs once a day, also without sync
    Then Not interested and untouched posts are removed after 30 days
    And Done posts, unfollowed feeds and device records after 180 days
    And posts in Later are never removed
