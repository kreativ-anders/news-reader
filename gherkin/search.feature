# Source: app/js/app.js
# Implementation: app/js/app.js
@app @search
Feature: Search and go to
  One palette for views, folders, feeds and every known post.

  Scenario: Open the palette
    When I press "/" or Ctrl/⌘ K or choose the search button
    Then the palette opens with views, folders and feeds

  Scenario: Search posts
    When I type a query
    Then posts whose title matches come first, then the newest
    And the number of results is announced

  Scenario: Jump to a result
    When I pick a post
    Then its view opens and the post is selected
    When I pick a feed, a folder or a view
    Then the app goes there
