# Source: app/js/sync.js, app/js/app.js, app/js/db.js
# Implementation: app/js/sync.js
@app @sync @devices
Feature: Paired devices can be seen, renamed and removed
  Every device keeps one encrypted device record with a public key. Removing a device changes the sync key,
  so the removed device is locked out for good.

  Scenario: Paired devices are listed
    When I open Settings → Paired devices
    Then I see every device with its name, platform, paired since and last active
    And I can rename each one

  Scenario: Removing a device locks it out
    When I remove a device
    Then the sync key changes and the remaining devices follow automatically
    And the removed device finds no new key and unpairs

  Scenario: Changing the key invalidates old pairing links
    When I choose "Change key"
    Then all paired devices keep syncing with the new key
    And old sync keys and pairing links no longer pair a device

  Scenario: A removed device cannot sneak back
    Given a device was removed
    When it sends its device record with a future timestamp or a swapped public key
    Then it stays removed and gets no new key

  Scenario: Unpairing announces itself
    When I choose "Unpair this device"
    Then the other devices see that it left

  Scenario: A device not active for a year is pointed out
    Given another paired device has not been active for over a year
    Then the sync status shows a red dot and names the inactive device count to screen readers
    When I click the sync status
    Then Settings → Paired devices opens with focus on a hint that explains what it means
    And the device is marked "not active for over a year" and can be removed on its own
    And nothing is removed without my decision

  Scenario: The hint disappears once the device is gone or back
    Given the red dot is shown for an inactive device
    When I remove that device or it syncs again
    Then the dot and the hint disappear and clicking the sync status syncs again
