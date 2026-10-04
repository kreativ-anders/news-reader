# Source: app/js/app.js, app/js/db.js, app/index.html
# Implementation: app/js/app.js
@app @flow
Feature: Every new post gets one decision
  Posts arrive in the Inbox, newest first, and move only by the user's decision: Read now, Later or Not
  interested. There is no ranking and no algorithm.

  Background:
    Given I follow at least one feed with new posts

  Scenario: First run explains the three decisions
    Given I follow no feed yet
    When I open the app
    Then the empty Inbox explains Read now, Later and Not interested
    And it offers "Add your first feed", which focuses the address field, OPML import and pairing
    And on touch screens a one-time tip explains swiping

  Scenario: Read now opens the original and files the post under Done
    When I choose Read now on a post
    Then the original opens in a new tab
    And the post moves to Done
    And a toast offers to undo

  Scenario: Later keeps the post for reading
    When I choose Later on a post
    Then the post moves to Later
    And an offline copy is saved (see offline.feature)

  Scenario: Not interested removes the post from the Inbox
    When I choose Not interested on a post
    Then the post leaves the Inbox
    And it is listed under Not interested, reachable from Done

  Scenario: Undo takes back the last decision
    Given I just made a decision on a post
    When I choose Undo in the toast or press "u" before the next action
    Then the post is back where it was

  Scenario: The undo toast never hides the list's last buttons
    Given the undo toast is shown at the end of a list
    Then it sits below "Clear all" and "Show more" instead of covering them
    And it stays 10 seconds, paused while hovered or focused

  Scenario: Clear all dismisses everything shown in the Inbox
    When I choose "Clear all" below the Inbox list
    Then every post shown moves to Not interested

  Scenario: The end of a filtered Inbox shows which source comes next
    Given the Inbox is filtered to a folder or a feed
    And another source still has new posts
    When I reach the end of the list
    Then "Up next" names the next source with new posts and its count, in the order of the Sources list
    And the clear button names the filter, like "Clear Tech"

  Scenario: Clearing a folder leads on to the next one instead of claiming Inbox zero
    Given the Inbox is filtered to a folder
    And other folders or feeds still have new posts
    When I clear the folder
    Then the Inbox says nothing new is left in that folder and how many posts still wait in the whole Inbox
    And it offers "Next" with the next source and its count, and "Show whole Inbox"
    And focus is on "Next", so Enter moves on – the app never switches by itself
    And after the last source "Inbox zero" shows

  Scenario: Mark all done in Later respects the feed filter
    Given Later is filtered to one feed
    When I choose "Mark all done"
    Then only the posts of that feed move to Done

  Scenario: Read again keeps a post done
    Given a post is in Done
    When I choose Read again
    Then the original opens again and the post stays in Done

  Scenario: Clearing Done hides posts but keeps them counted as read
    When I choose "Clear list" in Done
    Then the posts disappear from Done
    And they still count as read for the feed's read rate

  Scenario: A post can come back from Not interested
    Given a post is listed under Not interested
    When I move it back
    Then it is in the Inbox again

  Scenario: Posts in the old "reading" state show up in Later
    Given an older device synced a post in the state "reading"
    Then the post is listed under Later
    And the address "#reading" opens Later

  Scenario: Swiping decides on touch screens
    Given I use a touch screen
    When I swipe a post right
    Then it moves to Later
    When I swipe a post left
    Then it moves to Not interested
    And the swipe directions can be changed in Settings, and every swipe has a button and a key as well

  Scenario: Decisions survive a reload
    Given I made decisions on several posts
    When I reload the app
    Then every post is still where I put it
