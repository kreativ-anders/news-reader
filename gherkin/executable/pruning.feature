# Source: app/js/sync.js
# Implementation: app/js/sync.js
# Executable: tests/js/pruning.bdd.test.mjs
@executable @sync @retention
Feature: Old records are pruned the same way on every device
  Pruning runs once a day, also without sync. It only looks at the record and the time, so every device drops
  the same records and an old device cannot bring a pruned one back. Before upload, records are slimmed down to
  what the other devices still need.

  Rule: How long a record is kept depends on its kind and state

    Scenario Outline: Items
      Given an item in state "<state>" last changed <days> days ago
      Then it is <verdict>

      Examples:
        | state     | days | verdict |
        | dismissed | 29   | kept    |
        | dismissed | 30   | pruned  |
        | new       | 31   | pruned  |
        | done      | 100  | kept    |
        | done      | 181  | pruned  |
        | later     | 999  | kept    |
        | reading   | 999  | kept    |

    Scenario: An item changed in the future (clock skew) is kept
      Given an item in state "dismissed" last changed -1 days ago
      Then it is kept

    Scenario Outline: Feeds and devices
      Given a <record> last changed <days> days ago
      Then it is <verdict>

      Examples:
        | record          | days | verdict |
        | unfollowed feed | 181  | pruned  |
        | followed feed   | 999  | kept    |
        | device          | 181  | pruned  |

  Rule: The sync data carries only what other devices need

    Scenario: A dismissed item keeps state, feed, title and address – enough for read rate and search
      Given an item in state "dismissed" with feed, title, address, date and image
      When it is slimmed for the sync data
      Then its data is {"s":"dismissed","f":"f1","t":"Title","u":"https://x"}

    Scenario: An untouched item keeps only its state
      Given an item in state "new" with feed, title, address, date and image
      When it is slimmed for the sync data
      Then its data is {"s":"new"}

    Scenario: A done item keeps everything
      Given an item in state "done" with feed, title, address, date and image
      When it is slimmed for the sync data
      Then its data is {"s":"done","f":"f1","t":"Title","u":"https://x","p":"2026-01-01","i":"https://img"}

    Scenario: The local record is not changed by slimming
      Given an item in state "dismissed" with feed, title, address, date and image
      When it is slimmed for the sync data
      Then the local item still has its image

    Scenario: Feeds are not slimmed
      Given a followed feed last changed 0 days ago
      When it is slimmed for the sync data
      Then it is unchanged
