# Source: app/js/app.js, app/app.css, app/index.html
# Implementation: app/js/app.js
@app @list
Feature: The reading list is calm and easy to scan
  Every view (Inbox, Later, Done) shows its posts as a list grouped by day, newest first.

  Scenario: Posts are grouped by day, newest first
    Given the Inbox holds posts from several days
    Then they are grouped under a sticky day header with a count
    And the Inbox sorts by publication date, the other views by the time of the last decision
    And each post shows its author when the feed names one

  Scenario: Long lists are paged
    Given a view holds more than 150 posts
    Then 150 are shown with "Show more" below them

  Scenario: Long teasers can be opened
    Given a teaser is cut off after two lines
    When I click its chevron or the teaser text
    Then the full teaser is shown
    But a teaser that fits has no chevron

  Scenario: Repeated images are hidden
    Given a feed uses the same image on several posts
    Then that image is not shown on those posts

  Scenario: Saved offline copies show the reading time
    Given a post in Later has an offline copy
    Then the card shows how long it takes to read

  Scenario: Card actions are always reachable
    Then the card actions appear on hover, on focus and on keyboard selection
    And the main action always keeps its visible label
    And all actions are always visible on touch screens, in forced colours, with "more contrast" and with Settings → Card actions → Always

  Scenario: Compact layout shows headlines only
    When I switch the layout to compact in Settings or press "v"
    Then the list shows headlines only
    And the choice is kept on this device
