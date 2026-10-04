# Source: app/js/app.js, app/index.html, app/app.css
# Implementation: app/js/app.js
@app @a11y
Feature: Everything works with keyboard and screen reader
  WCAG 2.2 AA is the floor: focus is managed after every redraw, no function depends on hover or swipe, and
  single-key shortcuts can be switched off.

  Scenario: Views have keys, headings, titles and history
    When I switch views with the navigation or the keys "1" to "4"
    Then focus goes to the view heading
    And the page title changes
    And browser Back returns to the previous view
    And "#later", "#feeds" and "#settings" open their view directly

  Scenario: j and k move the real focus
    When I press "j" or "k"
    Then focus moves to the next or previous card
    And after an action focus goes to the card that takes its place

  Scenario: Shortcuts act on the selected card
    Given a card is selected
    Then "o" or Enter opens it, "l" moves it to Later, "x" to Not interested, "d" to Done
    And "u" undoes, "r" refreshes, "/" searches and "?" lists all shortcuts

  Scenario: Single-key shortcuts can be switched off
    When I switch off keyboard shortcuts in Settings
    Then single keys do nothing
    But Ctrl/⌘ K still opens search

  Scenario: Cards are named for screen readers
    Then a card is named by its title and described by its meta line
    And its actions carry their shortcuts in aria-keyshortcuts
    And the DOM order is title, meta, teaser, actions

  Scenario: Redraws never steal focus or input
    Given I am typing in Feeds or Settings
    When a background refresh redraws the app
    Then my input and focus stay where they are

  Scenario: Every text field has a visible label
    Then every text field in the app has a visible label
    And errors are tied to their field
