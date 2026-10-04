# Source: app/js/app.js, app/js/feeds.js, app/js/db.js
# Implementation: app/js/app.js
@app @sources
Feature: Sources filter a view by feed or folder and show small numbers about them
  The Sources list (sidebar on desktop, drawer on narrow screens) shows the folders and feeds of the current
  view with counts. All numbers come from data the device already has – nothing is tracked.

  Scenario: One feed needs no Sources list
    Given I follow a single feed
    Then no Sources list is shown

  Scenario: Several feeds are listed with counts
    Given I follow several feeds
    Then the Sources list shows folders and feeds of the current view with their counts
    And feeds with nothing in the view fold behind "+ n more"
    And names are sorted with the collation of the app language

  Scenario: Filtering to one feed or one folder
    When I pick a feed or a folder in Sources
    Then the view shows only its posts

  Scenario: Narrow screens open Sources as a drawer
    Given a narrow screen
    When I choose Sources at the start of the bottom bar
    Then a modal drawer opens with "All feeds" and the same tree and counts
    And focus starts on the current filter
    And Esc or a click on the backdrop closes it
    And the Sources button is highlighted while a filter is on

  Scenario: Folders are free text
    When I put a feed into a folder in Feeds
    Then existing folders are suggested
    And the folder travels with the feed in the sync data

  Scenario: Feed icons and names
    Then a feed shows the icon the Collector found, else the site's favicon, else a monogram
    And platform wording is removed from feed titles (see executable/feed_identity.feature)

  Scenario: A feed's context shows its rhythm and read rate
    When Inbox is filtered to one feed
    Then I see its posts per week over the last 28 days
    And its read rate from the decisions of the last 30 days, once there are at least 5
    And I can change its folder, rename it or unfollow it there

  Scenario: A quiet feed shows its last post instead
    Given a feed posts less than once a week and nothing for 30 days
    Then its context shows the date of its last post

  Scenario: A folder's context sums up its feeds
    When a view is filtered to a folder
    Then posts per week and read rate are summed over the folder's feeds

  Scenario: Headers sum up the whole list
    Then the Feeds header shows posts per week over all feeds
    And the Later header shows the reading time of its offline copies at 220 words a minute
