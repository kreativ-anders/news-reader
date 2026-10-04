# Source: index.html, site.js, track.js, tools/build-i18n.php, i18n/en.json, app/js/i18n.js, thanks.html
# Implementation: site.js
@site
Feature: The project site explains News in five languages
  A static site with one URL per language, generated from i18n/*.json. It counts visits and a few named events
  with fixed values only.

  Scenario: Every language has its own pages
    Then English is at "/" and German, French, Italian and Spanish under /de/, /fr/, /it/ and /es/
    And every page has hreflang, canonical and its own share image
    And every local link and asset resolves

  Scenario: Switching the language keeps the page
    When I pick another language in the switcher
    Then the same page opens in that language
    And legal links stay in the page language

  Scenario: The thanks page follows the visitor's language
    When I arrive at /thanks.html after a payment
    Then a saved language choice wins, else the browser language
    And "?lang=en" keeps English

  Scenario: Theme is shared with the app
    When I toggle the theme on the site
    Then it cycles light, dark and auto, says the current mode and sets the browser bar colour
    And the app uses the same choice

  Scenario: Installing the app
    Given Chromium offers installation
    When I choose "Install app"
    Then the browser's own install dialog opens
    Given an iPhone
    Then the install steps open in a dialog that takes and returns focus
    Given Firefox on a computer
    Then there is no install button and "Open News" stays

  Scenario: Site events carry fixed values only
    Then only named events with fixed, language-neutral values are counted, never visitor input
    And the app loads no analytics

  Scenario: The preview mirrors the app
    Then the hero preview shows a day group, teasers and five tabs like the app
    And the sync time is formatted the way the app does it
