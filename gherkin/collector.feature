# Source: api/index.php, src/resolver.php, src/parsers.php, src/rules.php, src/feed-rules.php, src/response.php
# Implementation: src/resolver.php
@api @collector
Feature: The Collector turns any web address into a list of posts
  GET /api/collect?url=… resolves a page, a section or a feed to normalised JSON entries. It tries the
  strategies in a fixed order and stops at the first that yields posts.

  Scenario: The service describes itself
    When the Collector is called without a URL
    Then it answers 400 with its name, version, whether sync is on, usage and an example

  Rule: Strategies in a fixed order

    Scenario: A platform rule maps a known page to its native feed without fetching the page
      Given the address matches a platform rule (Medium, Substack, YouTube, Reddit, Mastodon, …)
      Then the native feed is used with strategy "rule"
      And a failed rule falls through to the next strategies

    Scenario: Platforms without feeds are named
      Given the address belongs to X, Meta, LinkedIn, TikTok or Spotify
      Then the answer is 422 "PLATFORM_NO_FEED" with the rule's name

    Scenario: A feed address is read directly
      Given the address is an RSS 2.0, RSS 1.0 (RDF) or Atom feed
      Then the strategy is "direct"

    Scenario: A page announces its feed
      Given the page links its feed with rel="alternate" or a visible feed link
      Then the strategy is "discovered"

    Scenario: Common feed paths are probed
      Given the page announces no feed
      Then up to 12 common paths like /feed and /rss.xml are probed, strategy "guessed"

    Scenario: The sitemap is used when there is no feed
      Given there is no feed
      Then robots.txt and sitemaps, filtered to the page's path, are tried, strategy "sitemap"
      And they count only with at least 3 entries of which at least half are dated
      And slug titles are replaced by link titles from the page

    Scenario: Posts are taken from the page itself
      Given there is no feed and no usable sitemap
      Then JSON-LD, article elements or links below the listing path are used (at least 3 hits)
      And a listing that is a file (/articles.html) takes sibling files of the same type
      And missing dates are filled from the sitemap

    Scenario: Nothing found
      Given no strategy yields posts
      Then the answer is 422 "NO_FEED_DETECTED" with the tried addresses

  Rule: A source that turns the server away is fetched by the app

    Scenario: 401 or 403 from the source offers addresses for the app to try
      Given the source answers the server with 401 or 403
      Then the error carries "clientTry": the rule feeds, the address itself and, for a site root, the WordPress API

    Scenario: The app posts the body it fetched
      When the app posts a body with "from" set to one of "clientTry" of the same URL
      Then the server parses it without fetching anything and answers this caller alone
      And nothing is cached or shared
      But a "from" outside "clientTry" is refused and a body over the size limit gets 413 "PAYLOAD_TOO_LARGE"

  Rule: Entries have one documented shape

    Scenario: Entries are normalised
      Then every entry has id, url, title, publishedAt, updatedAt, summary, image and author
      And the id is the SHA-256 of the GUID, else of the normalised URL
      And feeds and sitemaps are newest first, HTML keeps page order
      And only http(s) links and images leave the Collector

    Scenario: Summaries are plain and short
      Then summaries are plain text of at most 300 characters
      And feed furniture like "The post … appeared first on …", "Continue reading" and "[…]" is removed
      And titles with markup are cleaned and capped at 500 characters

    Scenario: Source details
      Then the source names its site address, its icon and its title when known, else null
