# Source: app/js/feeds.js, app/js/app.js, app/manifest.webmanifest, app/sw.js
# Implementation: app/js/feeds.js
@app @feeds
Feature: Following feeds from any web address
  Any page, section or feed address can be followed; the Collector finds the posts. Feeds can also come in
  through the share sheet, a bookmarklet or an OPML file.

  Scenario: Follow a website by its address
    When I enter a website address in Feeds, with or without "https://"
    Then the feed is found and its posts appear in the Inbox
    And the way it was found is shown in plain words ("feed", "sitemap", "from the page")
    And the technical name is in the tooltip

  Scenario: A page and its feed are the same feed
    Given I follow a website
    When I try to follow its feed address as well
    Then I am told I already follow it

  Scenario: Errors are explained, not thrown
    When a source cannot be followed
    Then a friendly text in the app language says why
    And the raw server message is in the tooltip

  Scenario: A server that is briefly down is not mistaken for the source saying no
    Given the web server answers 502, 503 or 504 without an error code, because PHP is down
    When a source cannot be followed or refreshed
    Then the text says the News server is briefly unavailable and my posts stay
    And the status code is in the tooltip

  Scenario: A source that turns the server away is fetched from the device
    Given a source answers the server with 401 or 403
    Then the app fetches the addresses the server suggests from my browser, without cookies or referrer
    And the server turns the body into posts for me alone
    And the feed says "from your device"
    And the sync data does not change – every device does this on its own

  Scenario: Share target and bookmarklet prefill the address
    When I share a page to the installed app, or use the bookmarklet "?add=<url>"
    Then the follow form is prefilled with that address

  Scenario: OPML export and import keep folders
    When I export my feeds as OPML
    Then feeds with a folder are nested in an outline of that name
    When I import an OPML file
    Then its feeds are added with the folder of their enclosing outline
    And this works even when the server is busy or unreachable – the next refresh fills them

  Scenario: Rename and unfollow
    When I rename a feed
    Then the new name is used everywhere and synced
    When I unfollow a feed and confirm
    Then it disappears from all my devices
    But posts I saved for Later stay in my list

  Scenario: At most two feeds are fetched at once
    When the app refreshes many feeds
    Then it asks the server for at most 2 at the same time

  Scenario: A busy server is asked again later
    Given the server answered a feed with "BUSY" or "RATE_LIMITED"
    Then that feed is fetched again automatically after the given wait, doubling on repeats, at most 15 minutes
    And Refresh skips it until then and says so

  Scenario: A saved copy explains its age
    Given the server serves an older copy of a feed
    Then the feed says whether the source failed or was just not asked, and how old the copy is
