# Source: app/js/db.js
# Implementation: app/js/db.js
# Executable: tests/js/vault-records.bdd.test.mjs
@executable @sync @sync-format
Feature: Records from the sync data are checked before they are used
  Other devices – possibly older or newer versions, possibly forged – write the records in the sync data. A
  device only takes a record whose shape it understands; invalid records are dropped, unknown extra fields kept,
  so a newer device can add optional fields without breaking older ones.

  Background:
    Given it is now 1800000000000

  Rule: Valid records of every kind pass

    Scenario: A feed with title, folder and dates
      When a "feed" record arrives with data {"url":"https://example.org/feed","title":"X","g":"News","since":1,"added":2}
      Then the record is accepted

    Scenario: An unfollowed feed without title
      When a "feed" record arrives with data {"url":"https://example.org/feed","d":1}
      Then the record is accepted

    Scenario Outline: An item in every state
      When an "item" record arrives with data {"s":"<state>","f":"f1","t":"T","u":"https://x","i":"https://y","p":"2026-01-01T00:00:00Z"}
      Then the record is accepted

      Examples:
        | state     |
        | new       |
        | reading   |
        | later     |
        | done      |
        | dismissed |

    Scenario: An item that only carries its state
      When an "item" record arrives with data {"s":"new"}
      Then the record is accepted

    Scenario: A device
      When a "device" record arrives with data {"name":"Phone","platform":"iPhone","since":1,"seen":2,"pub":"abc","r":1}
      Then the record is accepted

    Scenario: Unknown extra fields from a newer version are kept
      When an "item" record arrives with data {"s":"done","extra":{"future":true}}
      Then the record is accepted

  Rule: Malformed records are dropped

    Scenario Outline: Data that does not fit its kind
      When a "<kind>" record arrives with data <data>
      Then the record is dropped

      Examples:
        | kind   | data                    |
        | item   | null                    |
        | item   | []                      |
        | item   | {"s":"bogus"}           |
        | item   | {"s":"done","t":5}      |
        | item   | {"s":"done","u":{}}     |
        | item   | {"s":"done","f":["f"]}  |
        | feed   | {}                      |
        | feed   | {"url":5}               |
        | feed   | {"url":"u","since":"x"} |
        | feed   | {"url":"u","d":"yes"}   |
        | feed   | {"url":"u","title":{}}  |
        | device | {"pub":5}               |
        | device | {"name":[]}             |
        | device | {"r":2}                 |
        | other  | {}                      |
        | __proto__ | {}                   |

    Scenario Outline: Numbers that are not finite
      When a "<kind>" record arrives with data <data> and "<field>" set to <value>
      Then the record is dropped

      Examples:
        | kind   | data       | field | value    |
        | feed   | {"url":"u"} | added | Infinity |
        | device | {}         | seen  | NaN      |

    Scenario Outline: Ids that are not a short string
      When an "item" record with id <id> arrives
      Then the record is dropped

      Examples:
        | id               |
        | 7                |
        | ""               |
        | of 201 characters |

    Scenario Outline: Things that are not a record at all
      When the value <value> arrives as a record
      Then the record is dropped

      Examples:
        | value |
        | null  |
        | 42    |
        | "x"   |
        | []    |
        | {}    |

  Rule: Timestamps are finite, not negative and at most one day ahead

    Scenario Outline: Impossible timestamps
      When an item is changed at <time>
      Then the record is dropped

      Examples:
        | time                     |
        | NaN                      |
        | Infinity                 |
        | -1                       |
        | 9000000000000000         |
        | "1"                      |
        | null                     |
        | one day and 1 ms from now |

    Scenario: One day ahead is still fine
      When an item is changed at one day from now
      Then the record is accepted

    Scenario: The very first moment is fine
      When an item is changed at 0
      Then the record is accepted
