# Personal accounts — setup (Google and Microsoft)

Connects your own Google and Microsoft (Outlook / Microsoft 365) accounts so an
allowlisted bot can read your calendars and mail and, with your approval,
create calendar events. Plan: `docs/plans/personal-organizer-plan.md` (P1a).
Code: `src/personal-accounts/`, tools in `src/tools/personal/`.

You do this once per provider. After that, each account is connected from the
dashboard with a click.

## What you end up with

| Where | What |
| --- | --- |
| `.env` (next to `docker-compose.yml`) | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` |
| `config/config.json` (the live one is in the config volume) | `integrations.personalAccounts.bots: ["<bot id>"]`, optionally `redirectBaseUrl` |
| Data volume, `<paths.data>/personal-accounts/accounts.json` | One entry per connected account, with its refresh token (written by the app) |

Only one provider is needed; the other's buttons stay disabled.

## Redirect URI

The provider sends the browser back to the dashboard after consent:

```
http://127.0.0.1:3000/api/personal-accounts/callback/google
http://127.0.0.1:3000/api/personal-accounts/callback/microsoft
```

If you open the dashboard at another address (a domain, a LAN IP), set
`integrations.personalAccounts.redirectBaseUrl` to that base (for example
`https://dash.example.com`) and register those URIs too. The URI must match
exactly, including scheme and port. Google accepts `http://127.0.0.1` for local
use; any other host must be `https`.

The callback is the one route under `/api/personal-accounts` that needs no
login: the provider's redirect cannot carry the dashboard's token. It only
accepts a signed, single-use request id issued by your own click on
"Connect …", valid for 10 minutes; anything else gets a 400 and the provider is
never called.

## Google (Calendar + Gmail)

1. Open <https://console.cloud.google.com/>, create a project (e.g. `aibot-personal`).
2. **APIs & Services → Library**: enable **Google Calendar API** and **Gmail API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):
   - User type **External** (a personal Gmail account cannot pick Internal).
   - App name, your email as support and developer contact.
   - **Data access → Add scopes**:
     - `https://www.googleapis.com/auth/calendar.readonly`
     - `https://www.googleapis.com/auth/calendar.events`
     - `https://www.googleapis.com/auth/gmail.readonly`
     - plus `openid` and `email` (non-sensitive).
   - **Audience → Test users**: add every Google account you will connect (up to 100).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorized redirect URIs**: `http://127.0.0.1:3000/api/personal-accounts/callback/google`
     (and the `redirectBaseUrl` one, if any).
   - Copy the **Client ID** and **Client secret**.
5. **Publish the app** (Audience → **Publish app**, status "In production").
   While the app is in *Testing*, Google expires refresh tokens after **7 days**
   and every account would need reconnecting weekly (it shows as "Needs
   reconnecting"). Publishing without verification is enough for your own
   accounts: on consent Google shows "Google hasn't verified this app" —
   choose **Advanced → Go to <app> (unsafe)**. `gmail.readonly` is a
   restricted scope, so verification would require a security assessment; for
   personal use you do not need it.

## Microsoft (Outlook.com and work/school accounts)

1. Open <https://entra.microsoft.com/> (or Azure portal → **Microsoft Entra ID**) → **App registrations → New registration**.
   - Name: e.g. `aibot-personal`.
   - **Supported account types**: *Accounts in any organizational directory and personal Microsoft accounts* (multitenant + personal). The app uses the `common` endpoint, so both kinds can sign in.
   - **Redirect URI**: platform **Web**, `http://127.0.0.1:3000/api/personal-accounts/callback/microsoft`.
2. **Overview**: copy the **Application (client) ID**.
3. **Certificates & secrets → New client secret**: copy the **Value** (not the Secret ID) right away; it is shown once. Note its expiry date: when it expires, every Microsoft account stops refreshing until you put a new secret in `.env`.
4. **API permissions → Add a permission → Microsoft Graph → Delegated**:
   `offline_access`, `openid`, `email`, `profile`, `User.Read`, `Calendars.ReadWrite`, `Mail.Read`.
   No admin consent is needed for a personal account; a work account whose
   organization blocks user consent needs its admin to approve the app.

Microsoft refresh tokens rotate on every use (the app stores the new one) and
do not have Google's 7-day testing limit.

## Environment

Put the four values in `.env` next to `docker-compose.yml` (it is loaded with
`env_file`; never commit it):

```
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
MICROSOFT_OAUTH_CLIENT_ID=
MICROSOFT_OAUTH_CLIENT_SECRET=
```

For a host-native run (`bun run src/index.ts`) export them in the shell or the
same `.env`.

## Config

In the live config (the config volume, not the stale host copy), allow the bots
that may use the tools:

```json
"integrations": {
  "personalAccounts": {
    "bots": ["default"],
    "redirectBaseUrl": "http://127.0.0.1:3000"
  }
}
```

`bots` is empty by default: no bot sees personal data until it is listed.

## Apply and connect

1. Rebuild/restart the container (`docker compose up -d --build`) so it picks up
   the new env vars and the code — this restarts the fleet, so confirm first and
   note it in `docs/runbook.md`.
2. Dashboard → **Settings → Integrations → Personal accounts**: type a name
   (e.g. *Personal*, *Work*), click **Connect Google** or **Connect Microsoft**,
   consent in the new tab, come back. The account shows *Connected*.
3. Repeat for every account. Connecting the same mailbox again refreshes it in
   place (same name).

## How the bot uses it

Tools (only for the allowlisted bots): `calendar_agenda`, `calendar_free_slots`,
`calendar_create_event` (needs your approval: `confirm` in the permission
matrix), `mail_search`, `mail_read`. Every row is labeled with its account.

They answer **only you**: in a conversation, a speaker that is not the operator
gets "Not available for this user" before any call to Google or Microsoft. The
agent loop, cron and collaboration act for the bot and are allowed — the bot
allowlist is what limits them.

Mail bodies are passed to the model as untrusted external content.

## Troubleshooting

- **Buttons disabled** — the client id/secret for that provider is missing in the container environment.
- **`redirect_uri_mismatch` (Google) / `AADSTS50011` (Microsoft)** — the registered URI differs from the one the app sends; compare with `redirectBaseUrl`.
- **"Needs reconnecting"** — the provider refused the refresh (`invalid_grant`): Google app still in Testing (7 days), password change, access revoked, or the Microsoft secret expired. Click **Reconnect**.
- **"no refresh token"** — Google only returns one on a fresh consent: remove the app at <https://myaccount.google.com/permissions> and connect again.
- **Remove** in the dashboard forgets the token; revoke the app's access in the account's security settings too if you no longer want it authorized.
