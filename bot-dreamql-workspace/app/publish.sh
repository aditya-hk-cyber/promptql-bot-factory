#!/bin/sh
# Publish (or update) the DreamQL Workspace app artifact for this bot.
set -e
ID="${1:-dreamql-workspace}"
PORT="${PORT:-8080}"
TITLE="${TITLE:-DreamQL - Workspace (Slack-style)}"
BODY=$(cat <<JSON
{"version":2,"host":"vm","sandbox_id":"$PROMPTQL_SANDBOX_ID","kind":"web","port":$PORT,"protocol":"http",
 "readiness":{"path":"/readyz"},
 "required_permissions":{"promptql_graphql":"read_write","artifacts":true}}
JSON
)
curl -sS -w "\nHTTP %{http_code}\n" -X PUT "$PROMPTQL_PLATFORM_API_URL/v1/artifacts/threads/$PROMPTQL_THREAD_ID/$ID" \
  -H "Authorization: Bearer $PROMPTQL_USER_JWT" \
  -H "X-PromptQL-Artifact-Type: app" \
  -H "X-PromptQL-Artifact-Title: $TITLE" \
  -H "Content-Type: application/json" \
  --data "$BODY"
