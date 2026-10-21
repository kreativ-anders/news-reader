# Source: app/js/sync.js
# Implementation: app/js/sync.js
# Executable: tests/js/idle-devices.bdd.test.mjs
@executable @sync @devices
Feature: Devices not active for a year are pointed out
  A paired device that has not synced for a year may be lost or sold, but it still holds the sync key. The app
  only points it out – removing it stays the user's decision. The rule only reads the device record that is
  already in the sync data, so nothing new is stored or sent.

  Rule: Another device counts as inactive once its last activity is a year old

    Scenario Outline: Last activity
      Given another device last active <days> days ago
      Then it is <verdict>

      Examples:
        | days | verdict    |
        | 364  | active     |
        | 365  | inactive   |
        | 900  | inactive   |
        | -1   | active     |

    Scenario: Without last activity, the pairing date counts
      Given another device paired 400 days ago without last activity
      Then it is inactive

    Scenario: A device without any date is never flagged
      Given another device without any date
      Then it is active

    Scenario: This device is never flagged
      Given this device last active 900 days ago
      Then it is active
