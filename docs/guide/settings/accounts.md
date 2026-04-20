---
title: Accounts
---

# Accounts

The Accounts panel manages API credentials for running multiple Claude or Gemini instances with separate accounts.

![Accounts panel](../../screenshots/accounts.png)

![Account Security Architecture](/account-security.svg)

## What accounts do

Each account is a set of credentials (API key or OAuth session) that can be assigned to a session. This lets you:

- Run different sessions under different API accounts
- Cycle between accounts to distribute load
- Test with different permission levels

## Adding an account

1. Open the Accounts panel
2. Click **Add Account**
3. Choose the account type (API key or OAuth)
4. For API key: paste the key
5. For OAuth: click **Open Browser** to complete the OAuth flow

## Testing an account

Click **Test** next to any account to verify the credentials are valid.

## Account sandboxing

OAuth accounts are sandboxed — each gets a separate `HOME` directory with its own `.claude/` configuration. This prevents accounts from interfering with each other.

## Cycling accounts

Use **Open Next** to automatically cycle to the next available account when the current one hits a rate limit:

```bash
POST /api/accounts/open-next
```

## Rate limit cooldown

The Accounts panel shows a cooldown timer when an account is rate-limited. Commander automatically waits before retrying.

## Assigning to a session

When creating or restarting a session:
1. Open the New Session form (⌘N)
2. Select an account from the dropdown
3. The session starts under that account

Or restart with a specific account:
```bash
POST /api/sessions/:id/restart-with-account
{ "account_id": "..." }
```

## Related

- [Sessions: Creating](../sessions/creating) — assign accounts to sessions
- [API: Accounts](../../api/sessions) — account management endpoints
