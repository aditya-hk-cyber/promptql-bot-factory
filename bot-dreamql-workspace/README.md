# DreamQL Workspace (Slack-style)

A Slack-style front end over PromptQL that runs on the bot's VM. Each visitor sees their own PromptQL: rooms appear as channels and DMs, and bots appear as threads. Unread state and artifacts show inline, and visitors can reply or tag the bot without leaving the app. Built by Aditya Kumaraswamy for the DreamQL Bot Battle.

**Try it:** [Prompt](PROMPT.md)

## What you get

- **Channels and DMs.** Public and private rooms are listed as channels; private rooms with three or fewer members are shown as DMs.
- **Bots as threads.** Each bot in a room is a thread, with its messages, mentions and unread state.
- **Inline artifacts.** Artifacts the bot produced open inside the thread.
- **Reply and tag.** Visitors post replies, or tag the bot to trigger it, from inside the app.
- **Slack-style composer.** @mentions of people, groups and DreamBot; an emoji picker; the + menu (file uploads, text snippets, existing artifacts, saved-program workflows); Aa formatting; dictation; `/` commands; ←/→ history; a "Your bots" section for bots outside rooms; and "Mark all as read".
- **Visitor-only access.** Everything runs as the person viewing it, so nobody sees more than their own PromptQL access allows.

## How it runs

The bot copies `app/` to `/workspace/slackapp` on its VM, installs it as the `slackui` systemd unit on port 8080, and publishes it as a version-2 app artifact declaring `required_permissions: {promptql_graphql: read_write, artifacts: true}`. Each visitor approves that once. Identity comes from the `X-PromptQL-Visitor-Token` header; the VM's `$PROMPTQL_USER_JWT` is never used by the app.

- `app/app.py`: FastAPI service (uv, PEP-723 inline dependencies). Calls the Platform API's GraphQL and artifact routes with the visitor token.
- `app/index.html`: the UI, with a plug-in bus (`window.DQ`) for composer modules.
- `app/ext_*.py`: backend plug-ins for the composer (`ext_mention`, `ext_attach`, `ext_nav`). Each route runs as the visitor and refuses anonymous callers.
- `app/static/`: the composer modules' JS and CSS (attach, compose, emoji, mention, nav).
- `app/slackui.service`: systemd unit template.
- `app/publish.sh`: publishes the app artifact.

## Limits

- `app.py` builds bot links from a fixed DreamQL project URL (`THREAD_URL`) and names the bot `DreamBot`. In another project, change those two constants.
- Anonymous requests (readiness probes, card thumbnails) get empty data.
- Dictation needs the host frame to allow the microphone. Inside the PromptQL embed it shows "Dictation isn't available".
