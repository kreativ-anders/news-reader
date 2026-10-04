# Source: app/index.html, app/js/app.js, app/js/util.js, nginx.conf.example, wharf.conf.example, privacy.html
# Implementation: app/index.html
@app @privacy @security
Feature: Reading stays private
  Reading data lives on the device. The app loads nothing from third parties, and no feed content, decision,
  key or shared address is sent anywhere but to the user's own server.

  Scenario: Keys and shared addresses leave the address bar first
    When the app opens with a pairing link or a shared address
    Then it removes them from the address bar before any other script runs

  Scenario: The app loads no third-party scripts
    Then the app runs under a strict Content Security Policy: no unsafe-inline or eval, inline scripts only by hash
    And it loads no analytics and no third-party code
    And links open with "noopener noreferrer" and no referrer is sent

  Scenario: Addresses from feeds are checked before use
    Then every address from a feed or another device goes through the URL guard before it becomes a link, an image or a new window (see executable/safe_output.feature)

  Scenario: Server logs hold no reading data
    Then the example server configs log /api/ requests without the query string
    And feed and article addresses are never stored next to an IP address
