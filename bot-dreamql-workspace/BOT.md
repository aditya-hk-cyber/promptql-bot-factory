# DreamQL Workspace (Slack-style)

You are setting up **DreamQL Workspace**: a Slack-style front end over PromptQL that runs on this bot's VM. Each visitor sees their own PromptQL: rooms as channels and DMs, bots as threads, unread state, inline artifacts, and a composer to reply or tag the bot.

## Input

None.

## What you build

The reference implementation is in `app/` of this directory. Deploy it as-is; do not rewrite or edit `app.py` or `index.html`.

Never put the VM's `$PROMPTQL_USER_JWT` into the app or the unit: it expires and acts as the wrong person. The app only uses the `X-PromptQL-Visitor-Token` from the request it is handling.

## Step 1 — Deploy on the VM

```sh
mkdir -p /workspace/slackapp && cd /workspace/slackapp
# copy app.py, index.html, slackui.service and publish.sh from this directory's app/
sed "s|__PROMPTQL_PLATFORM_API_URL__|$PROMPTQL_PLATFORM_API_URL|" slackui.service | sudo tee /etc/systemd/system/slackui.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now slackui.service
```

`uv` installs the dependencies from the PEP-723 header on first start, so the first readiness check can take a few seconds.

## Step 2 — Verify

1. `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/readyz` → `204`.
2. `curl -s http://127.0.0.1:8080/api/bootstrap` → empty data (anonymous gets nothing, never an error).
3. `grep -c PROMPTQL_USER_JWT /etc/systemd/system/slackui.service` → `0`.

## Step 3 — Publish

```sh
cd /workspace/slackapp && sh publish.sh dreamql-workspace
```

This writes a version-2 `web` app artifact on port 8080 with `readiness: /readyz` and `required_permissions: {"promptql_graphql": "read_write", "artifacts": true}`. Each visitor is asked once to allow it. Do not widen the permissions. Do not set it as a room's focus artifact unless asked.

## Step 4 — Hand over

Reply with the app card (`<artifact type="app" identifier="dreamql-workspace" />`), then in two lines: rooms are channels and DMs, bots are threads; everyone sees only what their own access allows; replies and tags sent from the app go to the real bot.

## Afterwards

- If the app shows nothing for a visitor, they have not approved the permission prompt yet, or they have no rooms.
- If the service fails to start, check `journalctl -u slackui -n 50`; a missing `PROMPTQL_PLATFORM_API_URL` means the sed in Step 1 was skipped.
