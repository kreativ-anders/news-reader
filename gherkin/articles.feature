# Source: api/index.php, src/readable.php, src/cache.php
# Implementation: src/readable.php
@api @articles
Feature: Readable offline copies for Later
  GET /api/article?url=… returns the main content of an article as whitelisted HTML for the offline reader.

  Scenario: Full text from the feed is used first
    Given the cached feed carries the full text of the post
    When the app asks with "feed" and "id"
    Then the copy comes from the feed without fetching the page, source "feed"

  Scenario: Otherwise the page is reduced to its main content
    When the article page is fetched
    Then the main content is extracted with JSON-LD, meta data and Readability-style scoring
    And title, byline, site name, language, date, image and word count are returned
    And "partial" is true when less than 400 characters of text were found

  Scenario: Only safe HTML leaves the server
    Then the content keeps text, headings, lists, quotes, code and tables
    And links only with http, https or mailto and images only with absolute http(s) addresses
    And scripts, event handlers and every other element or attribute are dropped
    And the app sanitizes the HTML again

  Scenario: Pages that are no article
    Then the answer is 422 "NOT_AN_ARTICLE" or "NO_CONTENT"

  Scenario: A failed fetch keeps the old copy
    Given an article was saved before
    When fetching it again fails or another request is fetching it
    Then the existing copy is served
