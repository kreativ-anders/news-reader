# Source: app/js/offline.js, app/sw.js, app/js/app.js, app/js/db.js
# Implementation: app/js/offline.js
@app @offline
Feature: The app and the Later list work without a connection
  The service worker caches the app; posts moved to Later are saved as readable copies once.

  Scenario: The app opens offline
    Given the app was opened once
    When I open it without a connection
    Then it starts from the cached app files

  Scenario: Changes made offline are kept
    Given I am offline
    When I make decisions on posts
    Then the app stays usable
    And the changes are synced once the server is reachable again

  Scenario: Later posts are saved for offline reading
    When I move a post to Later
    Then a readable copy is fetched once from /api/article and stored on the device

  Scenario: A saved copy opens in the reader
    Given a post in Later has an offline copy
    When I open it
    Then it opens in a full-screen reader and the page behind it is inert
    And scrolling to the end offers to file the post under Done

  Scenario: Copies of finished posts are dropped
    Given a post with an offline copy is Done or Not interested
    Then its copy is removed after one day

  Scenario: A new version offers a reload
    Given a new version of the app was published
    When I start the app or return to it
    Then the new version takes over at once
    And the app offers "Reload" in a toast and in Settings
