# Source: api/index.php, src/sync.php, src/response.php
# Implementation: src/sync.php
# Executable: tests/api/sync-protocol.bdd.test.mjs
@executable @sync @api
Feature: The sync server stores one sealed blob per group of devices
  /api/sync knows no accounts, no schema and no merge logic. A group of paired devices shares one sync key; the
  server only sees a bearer token derived from it and an encrypted blob. ETags keep concurrent devices from
  overwriting each other.

  Background:
    Given a new sync key

  Rule: Create, read, update and delete with ETags

    Scenario: Nothing is stored for a new key
      When the device reads the sync data
      Then the answer is 404 "NOT_FOUND"

    Scenario: The first upload creates the sync data
      When the device creates the sync data
      Then the answer is 201
      And the answer carries a new ETag
      And the answer reports the uploaded size

    Scenario: The stored blob comes back byte for byte and is never cached
      Given the device created the sync data
      When the device reads the sync data
      Then the answer is 200
      And the answer is the uploaded blob, byte for byte
      And the answer is not cached

    Scenario Outline: Unchanged sync data is not sent again
      Given the device created the sync data
      When the device reads the sync data with <etag>
      Then the answer is 304

      Examples:
        | etag                       |
        | its ETag                   |
        | its ETag marked as weak    |

    Scenario: A second create for the same key is a conflict
      Given the device created the sync data
      When the device creates the sync data
      Then the answer is 412 "CONFLICT"

    Scenario: An update with the current ETag replaces the blob
      Given the device created the sync data
      When the device uploads the sync data with its ETag
      Then the answer is 200
      And the answer carries a new ETag

    Scenario: An update with an outdated ETag is refused and names the current one
      Given the device created the sync data
      And the device uploaded the sync data with its ETag
      When the device uploads the sync data with the first ETag
      Then the answer is 412 "CONFLICT"
      And the answer names the current ETag

    Scenario: A delete with an outdated ETag is refused
      Given the device created the sync data
      And the device uploaded the sync data with its ETag
      When the device deletes the sync data with the first ETag
      Then the answer is 412 "CONFLICT"

    Scenario: Deleting removes the sync data
      Given the device created the sync data
      When the device deletes the sync data
      Then the answer is 204
      When the device reads the sync data
      Then the answer is 404 "NOT_FOUND"
      When the device deletes the sync data
      Then the answer is 404 "NOT_FOUND"

  Rule: Only a well-formed bearer token gets in

    Scenario Outline: Wrong credentials
      When a device asks with <credentials>
      Then the answer is 401 "UNAUTHORIZED"

      Examples:
        | credentials                           |
        | no authorization                      |
        | the bearer token "short"              |
        | a token one character too long        |
        | a valid token as Basic authorization  |
        | a file path as bearer token           |

  Rule: Writes need a precondition and a sealed blob

    Scenario: An upload without If-Match or If-None-Match
      When the device uploads the sync data without a precondition
      Then the answer is 428 "PRECONDITION_REQUIRED"

    Scenario Outline: Bodies that are not sync data
      When the device creates the sync data with <body>
      Then the answer is <status> "<code>"

      Examples:
        | body                       | status | code              |
        | a plain JSON body          | 400    | INVALID_BODY      |
        | nothing but the magic      | 400    | INVALID_BODY      |
        | a blob of 1000100 bytes    | 413    | PAYLOAD_TOO_LARGE |

    Scenario: Other methods
      When the device posts to the sync data
      Then the answer is 405 "METHOD_NOT_ALLOWED"

  Rule: After a key change the old location holds a final forward

    Scenario: A forward may replace the sync data, other formats may not
      Given the device created the sync data
      When the device uploads a forward with its ETag
      Then the answer is 200
      And the stored blob starts with "NRF1"
      When the device uploads a blob starting with "NRX1" with its ETag
      Then the answer is 400 "INVALID_BODY"

    Scenario Outline: A removed device can neither replace nor delete the forward
      Given the device created the sync data
      And the device uploaded a forward with its ETag
      When the device <action>
      Then the answer is 410 "FORWARDED"
      And the stored sync data is still the forward

      Examples:
        | action                                  |
        | uploads the sync data with its ETag     |
        | uploads a forward with its ETag         |
        | deletes the sync data                   |
        | deletes the sync data with its ETag     |
