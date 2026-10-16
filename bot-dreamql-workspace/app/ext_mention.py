"""Mention module backend: lists the project's user groups for the @ autocomplete.

Runs only as the visitor (X-PromptQL-Visitor-Token). Never uses the bot's JWT.
"""
from fastapi import Request
from fastapi.responses import JSONResponse

GROUPS_Q = """{ user_groups(order_by: {name: asc}) {
  user_group_id name description
  user_group_members_aggregate { aggregate { count } } } }"""


def register(app, H):
    @app.get("/api/groups")
    async def groups(req: Request):
        tok = H.vtoken(req)
        if not tok:
            return JSONResponse({"error": "Open this app from PromptQL to mention groups."}, status_code=401)
        try:
            d = await H.gql(tok, GROUPS_Q, desc="DreamQL workspace: list user groups for @mentions")
        except Exception as e:
            return H.fail(e)
        out = []
        for g in d.get("user_groups") or []:
            if not g.get("user_group_id") or not g.get("name"):
                continue
            agg = ((g.get("user_group_members_aggregate") or {}).get("aggregate") or {})
            out.append({"id": g["user_group_id"], "name": g["name"],
                        "description": g.get("description"), "count": agg.get("count")})
        return {"groups": out}