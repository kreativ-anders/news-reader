# Source: app/js/util.js
# Implementation: app/js/util.js
# Executable: tests/js/safe-output.bdd.test.mjs
@executable @security
Feature: Feed and sync data never reach the page unchecked
  Titles, teasers and addresses come from feeds and from other devices – both may be hostile. Every value goes
  through esc() before it reaches HTML, every address through httpUrl() before href, src or window.open.

  Rule: Only web addresses pass the URL guard

    Scenario Outline: Other schemes and non-addresses are blocked
      When the app checks the address <address>
      Then the address is blocked

      Examples:
        | address                |
        | "javascript:alert(1)"  |
        | " JavaScript:alert(1)" |
        | "java\nscript:alert(1)" |
        | "data:text/html,x"     |
        | "vbscript:x"           |
        | "file:///etc/passwd"   |
        | "//evil.example"       |
        | "/relative"            |
        | ""                     |
        | null                   |
        | 42                     |

    Scenario: Nothing at all is blocked
      When the app checks no address
      Then the address is blocked

    Scenario Outline: Web addresses pass, normalised
      When the app checks the address "<address>"
      Then the address "<result>" is used

      Examples:
        | address                      | result                       |
        | https://example.org/a?b=1#c  | https://example.org/a?b=1#c  |
        | HTTP://Example.org           | http://example.org/          |

  Rule: Text is escaped for HTML

    Scenario: Every HTML-significant character is escaped
      When the app escapes the text "<a href=\"x\" onclick='y'>&</a>"
      Then the HTML is "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;"

    Scenario: Missing text becomes empty
      When the app escapes nothing
      Then the HTML is ""

  Rule: The host name shown next to a post drops "www."

    Scenario: A host name
      Then the host of "https://www.example.org/x" is "example.org"

    Scenario: Not an address
      Then the host of "not a url" is ""
