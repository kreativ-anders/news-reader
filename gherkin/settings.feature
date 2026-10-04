# Source: app/js/app.js, app/js/i18n.js, app/i18n/en.json, app/theme.css
# Implementation: app/js/app.js
@app @settings
Feature: Settings adapt the app to the person and the device
  Settings are ordered from most to least relevant. Appearance and layout are per device; feeds and decisions
  are synced.

  Scenario: Language
    Given I have not chosen a language
    Then the app uses my saved choice, else my browser languages, else English
    When I pick another language in Settings
    Then the whole app is redrawn in it at once
    And every static label is translated in English, German, French, Italian and Spanish

  Scenario: Theme follows the system unless I choose
    When I choose light, dark or auto
    Then the app uses it and remembers it, shared with the site

  Scenario: Server test
    When I choose Settings → Advanced: server → Test
    Then the app says whether it reaches the Collector

  Scenario: Every view and Settings render without errors
    Given an empty app
    Then every view and Settings render on desktop and mobile without a script error
