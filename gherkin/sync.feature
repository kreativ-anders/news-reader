# Source: app/js/sync.js, app/js/db.js, app/js/app.js
# Implementation: app/js/sync.js
@app @sync
Feature: Paired devices share feeds and decisions, end-to-end encrypted
  There are no accounts. Devices that share a sync key are paired; the server stores only sealed sync data it
  cannot read (protocol: executable/sync_protocol.feature).

  Scenario: Pair two devices
    Given device A has feeds and decisions
    When I copy the sync key on device A and paste it on device B
    Then both devices show the same feeds and decisions
    And later changes on either device reach the other one

  Scenario: A custom server travels with the key
    Given device A uses its own sync server
    When I copy the sync key
    Then the copied text is a pairing link that carries the server address

  Scenario: The key can be pasted by hand
    Given the browser denies reading the clipboard
    When I choose Paste
    Then I am asked to paste the key into the field myself

  Scenario: An invalid key is refused
    When I join with a key that is not a sync key
    Then an error explains that this is not a sync key

  Scenario: Joining is always confirmed
    When I paste a sync key or open a pairing link
    Then I am asked to confirm first
    And the dialog says that my data is merged into that group, names a custom server and warns when this device leaves its current group

  Scenario: An unreachable sync server is reported
    Given the sync server cannot be reached
    When the app syncs
    Then a message says so and the app keeps working

  Scenario: Posts I have not sorted yet reach my other devices
    Given device A collected posts over several days that its sources no longer list
    When device B syncs
    Then B's Inbox shows the same unsorted posts of the last 14 days
    And a decision made on any device wins over them (see executable/pruning.feature)

  Scenario: The newest change of a record wins
    Given two devices changed the same post
    When they sync
    Then both keep the decision that was made last

  Scenario: Records from other devices are checked first
    When sync data from another device holds malformed records or timestamps far in the future
    Then those records are dropped (see executable/vault_records.feature)
    And decompressing the sync data stops at 32 MB

  Scenario: Sync data over the size limit shrinks itself
    Given an upload is refused as too large
    Then the oldest finished posts are removed and the upload is retried once

  Scenario: Settings show how full the sync data is
    Given this device is paired and has read or written the sync data
    Then Settings → Sync shows its size next to the server's limit (exact rules: executable/pruning.feature)
    And from 75 % on a hint says that the oldest Done and Not interested posts are forgotten first, Later stays

  Scenario: Without pairing nothing leaves the device
    Given this device is not paired
    Then no changes are queued for upload
    And daily pruning still runs (see retention.feature)
