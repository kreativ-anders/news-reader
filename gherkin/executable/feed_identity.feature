# Source: app/js/feeds.js
# Implementation: app/js/feeds.js
# Executable: tests/js/feed-identity.bdd.test.mjs
@executable @feeds @sync-format
Feature: A feed address always means the same feed
  The app turns whatever the user types, shares or imports into one normalised address and derives the feed id
  from it. The feed id is part of the sync format: every device, old or new, must compute the same id, or a
  synced feed shows up twice.

  Rule: Addresses are normalised like the Collector does it

    Scenario Outline: Typed addresses are normalised
      When I normalise the address "<input>"
      Then the address is "<address>"

      Examples:
        | input                         | address                       |
        | example.com/blog              | https://example.com/blog      |
        | HTTP://Example.COM/A#frag     | http://example.com/A          |
        | https://example.com           | https://example.com/          |

    Scenario: Spaces around a pasted address are ignored
      When I normalise the address "  example.com/feed "
      Then the address is "https://example.com/feed"

    Scenario Outline: Anything that is not a web address is refused
      When I normalise the address "<input>"
      Then the address is empty

      Examples:
        | input               |
        | ftp://example.com/x |
        | javascript:alert(1) |
        | http://             |
        |                     |

  Rule: A shared text yields its link

    Scenario: The link is taken out of a share-sheet text, without trailing punctuation
      When I extract the link from "Look at this: https://example.com/post?id=1). Nice!"
      Then the link is "https://example.com/post?id=1"

    Scenario: A text without a link yields nothing
      When I extract the link from "no link here"
      Then the link is empty

  Rule: The feed id never changes

    Scenario: The feed id is pinned
      Then the feed id of "https://example.com/feed" is "fkpzfzrvmzd"

    Scenario Outline: Scheme, host case, trailing slash and fragment do not change the feed id
      Then the feed id of "<address>" is "fkpzfzrvmzd"

      Examples:
        | address                      |
        | example.com/feed/            |
        | https://EXAMPLE.com/feed#x   |

    Scenario: Different feeds get different ids
      Then the feed ids of "https://example.com/feed" and "https://example.com/feed2" differ

    Scenario: A feed id is "f" followed by base-36 characters
      Then the feed id of "https://a.test/" looks like a feed id

  Rule: Feed titles drop platform wording

    Scenario Outline: Platform wording around the real name is removed
      When I clean the feed title "<title>"
      Then the title is "<clean>"

      Examples:
        | title                             | clean          |
        | Stories by Vignaraj Ravi on Medium | Vignaraj Ravi |
        | UX Collective on Medium            | UX Collective |
        | heise online – RSS Feed            | heise online  |
        | RSS Feed: tagesschau.de            | tagesschau.de |

    Scenario Outline: Real names stay as they are
      When I clean the feed title "<title>"
      Then the title is "<title>"

      Examples:
        | title        |
        | Caschys Blog |
        | The Feed     |
        | Medium       |
