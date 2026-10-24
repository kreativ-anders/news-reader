# Source: app/js/sync.js
# Implementation: app/js/sync.js
# Executable: tests/js/pruning.bdd.test.mjs
@executable @sync @retention
Feature: Old records are pruned the same way on every device
  Pruning runs once a day, also without sync. It only looks at the record and the time, so every device drops
  the same records and an old device cannot bring a pruned one back. Before upload, records are slimmed down to
  what the other devices still need – plus the unsorted posts of the last 14 days, because a source only lists
  its newest posts and a device that checked it later would never see the older ones. Pruning and slimming keep
  the sync data of a heavy reader well below the server limit; the app shows how full it is.

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

    Scenario: An unsorted post that travels along is not slimmed
      Given an unsorted post that travels with the sync data
      When it is slimmed for the sync data
      Then it is unchanged

  Rule: Unsorted posts of the last 14 days travel with the sync data

    Scenario: A recent post I have not sorted yet
      Given an unsorted post of a followed feed "f1" published 3 days ago
      Then it travels with the sync data
      And its sync data is {"s":"new","c":1,"f":"f1","u":"https://x","p":"<published>","t":"Title","i":"https://img"}
      And its sync record is dated when the post was published, so any decision made after seeing it wins

    Scenario Outline: Posts that stay on this device
      Given an unsorted post of a followed feed "f1" published 3 days ago
      But the post <case>
      Then it does not travel with the sync data

      Examples:
        | case                               |
        | already has a decision             |
        | belongs to a feed I do not follow  |
        | was published 14 days ago          |
        | has no date                        |
        | is dated in the future             |
        | is dated after this device saw it  |

    Scenario: At most the newest 1000 posts travel along
      Given 1005 unsorted posts of a followed feed published within the last days
      Then the newest 1000 travel with the sync data

  Rule: The sync data of a heavy reader fits the server limit

    Scenario Outline: Months of reading in 66 feeds, plus 1000 unsorted posts that travel along
      Given <decisions> decisions within the pruning periods: 60 % Not interested, 25 % Done, 10 % untouched, 5 % Later
      Then the sealed sync data stays below <bytes> bytes

      Examples:
        | decisions | bytes  |
        | 5000      | 500000 |
        | 10000     | 800000 |

  Rule: The app shows how full the sync data is and warns from 75 %

    Scenario Outline: Fill level
      Given the sync data has <bytes> bytes and the server allows <max>
      Then it is shown as <percent> % full
      And it <warns> as nearly full

      Examples:
        | bytes   | max                 | percent | warns         |
        | 380000  | 1000000             | 38      | is not shown  |
        | 749999  | 1000000             | 74      | is not shown  |
        | 750000  | 1000000             | 75      | is shown      |
        | 380000  | 500000              | 76      | is shown      |
        | 380000  | nothing (old server)| 38      | is not shown  |
        | 1200000 | 1000000             | 100     | is shown      |

    Scenario: Before the first sync nothing is shown
      Given this device has not read or written sync data yet
      Then no fill level is shown
