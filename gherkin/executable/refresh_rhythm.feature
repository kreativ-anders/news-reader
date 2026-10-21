# Source: app/js/feeds.js, app/js/app.js
# Implementation: app/js/feeds.js
# Executable: tests/js/refresh-rhythm.bdd.test.mjs
@executable @refresh
Feature: Opening the app checks a feed by how often it posts
  A feed that posts many times a day is checked on almost every start, one that posts once a day or less at most
  every 3 hours. The wait is a quarter of the usual gap between posts of the last 28 days, never less than the
  Collector's 15-minute refresh window. Refresh still checks every feed.

  Scenario Outline: The wait follows the posting rhythm
    Given a feed posts <posts> times a week
    Then opening the app checks it once its last fetch is older than <wait> minutes

    Examples:
      | posts | wait |
      | 560   | 15   |
      | 140   | 18   |
      | 70    | 36   |
      | 21    | 120  |
      | 7     | 180  |
      | 1     | 180  |

  Scenario: A feed without posts in the last 28 days waits the longest
    Given a feed posts 0 times a week
    Then opening the app checks it once its last fetch is older than 180 minutes
