# PromptQL Bot Factory

Bot recipes for PromptQL. Each folder holds one recipe: `BOT.md` (the instructions the bot follows), `PROMPT.md` (the seed prompt) and `README.md`. Recipes with an app also ship an `app/` folder that the bot deploys as-is.

## Bots

| Bot | What it does | Prompt |
| --- | --- | --- |
| [DreamQL Workspace (Slack-style)](bot-dreamql-workspace/) | A Slack-style front end over PromptQL on its VM: rooms as channels and DMs, bots as threads, unread state, inline artifacts, and reply or tag the bot from inside. Runs only as the visitor. | [Prompt](bot-dreamql-workspace/PROMPT.md) |
