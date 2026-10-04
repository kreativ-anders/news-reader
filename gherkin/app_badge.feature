# Source: app/sw.js, app/js/app.js
# Implementation: app/sw.js
@app @badge
Feature: The app icon shows the Inbox count
  The installed app puts the number of posts in the Inbox on its icon. News never sends notifications.

  Scenario: The icon shows the Inbox count
    Given the app is installed
    Then its icon shows the number of posts in the Inbox

  Scenario: The number can be switched off
    When I switch off Settings → App icon
    Then the icon shows no number

  Scenario: Safari and iOS need notification permission for the number
    Given the browser shows icon numbers only with notification permission
    Then Settings show a hint with an "Allow" button that asks only on click
    And when notifications are blocked the hint explains where to allow them, without a button

  Scenario: A background check updates the number
    Given the browser supports periodic background sync
    When the background check runs (at most every 12 hours, not within 30 minutes of a refresh)
    Then it asks the Collector for one feed at a time, only feeds whose copy may have changed
    And stops at the first refusal or network error
    And adds posts this device has not seen to the number, storing nothing
