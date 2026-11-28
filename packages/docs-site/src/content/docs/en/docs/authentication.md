---
title: Sign-in and workspaces
description: CinaAuth, browser sessions and administrator access.
---

## Sign in

CinaToken uses CinaAuth for identity. Choose sign in, finish authentication in the window, then wait for it to close and return to the original page. Browser sessions provide website access; API requests need a separate Gateway API key.

If your browser blocks the authentication window, allow pop-ups for this site and start again. Do not share authentication URLs or one-time codes.

## Workspaces

Use the workspace selector in your account to switch between available workspaces. After switching, verify which workspace owns your keys and records. Data from different workspaces must not be mixed.

## Administrator access

Accounts with server-authorized administrator access can open the [admin console](/admin). If the link is missing, open that address and complete the administrator verification.

Signing in to an ordinary account does not grant administrator permissions. After a role change, sign out and sign in through the admin entry again. If access is still unavailable, ask an existing administrator to check the role.

## Sign-in did not finish

1. Close old authentication windows and start again from the current CinaToken page.
2. Return to the same browser and page after authentication.
3. Use the page's retry action to refresh the session. Avoid opening several sign-in windows at once.
4. If it still fails, provide the error text, time and page address to an administrator. Do not share cookies or complete callback URLs.
