"""nav module — "Your bots" (roomless bots) + "Mark all as read".

Every call runs as the visitor (X-PromptQL-Visitor-Token); no other credential is used.
Read pointers (thread_participants.last_seen_event_id) only ever move forward.
"""
from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

PARTS_Q = """query($u: uuid!, $w: thread_participants_bool_exp!) {
  thread_participants(where: {_and: [{promptql_user_id: {_eq: $u}}, {is_removed: {_eq: false}},
                                      {threads_v2: {deleted_at: {_is_null: true}}}, $w]},
                      order_by: {latest_relevant_event_id: desc_nulls_last}, limit: 2000) {
    thread_id last_seen_event_id latest_relevant_event_id
    latest_relevant_thread_event { created_at }
    threads_v2 { title custom_title room_id updated_at agent_version }
  }
}"""

UPDATE_M = """mutation($u: [thread_participants_updates!]!) {
  update_thread_participants_many(updates: $u) { affected_rows } }"""

# Same "chat message" filter the core uses for reply counts.
MSG_W = {"_or": [
    {"event_data": {"_has_key": "UserMessage"}},
    {"event_data": {"_contains": {"AgentMessage": {"update": {"content": {"interaction_update": {"main_agent": {
        "action_completed": {"result": {"agent_loop_action_result_type": "final_response_sent"}}}}}}}}}},
    {"event_data": {"_contains": {"AgentMessage": {"update": {"content": {"interaction_update": {"main_agent": {
        "action_completed": {"result": {"agent_loop_action_result_type": "message_sent"}}}}}}}}}},
]}
MAX_COUNTS = 50


def _int(v):
    try:
        return int(v or 0)
    except Exception:
        return 0


class SeenAllIn(BaseModel):
    dry_run: bool = False          # only count, change nothing
    roomless_only: bool = False    # only the "Your bots" section
    thread_ids: list[str] | None = None  # optional: limit to these bots


def register(app, H):
    def _auth(req):
        tok = H.vtoken(req)
        sub = H.claims(tok).get("sub") if tok else None
        return tok, sub

    async def _parts(tok, sub, roomless=False, only=None):
        w = {}
        if roomless:
            w["threads_v2"] = {"room_id": {"_is_null": True}}
        if only:
            w["thread_id"] = {"_in": only[:500]}
        d = await H.gql(tok, PARTS_Q, {"u": sub, "w": w},
                        desc="DreamQL workspace: your bots and their unread state")
        return d["thread_participants"]

    async def _counts(tok, items):
        """New chat messages since the visitor's read pointer, one aliased aggregate per bot."""
        if not items:
            return {}
        vs, fs, vars_ = [], [], {"w": MSG_W}
        for i, (tid, seen) in enumerate(items):
            vs.append(f"$t{i}: uuid!, $e{i}: bigint!")
            fs.append(f"c{i}: thread_events_aggregate(where: {{_and: [{{thread_id: {{_eq: $t{i}}}}}, "
                      f"{{thread_event_id: {{_gt: $e{i}}}}}, $w]}}) {{ aggregate {{ count }} }}")
            vars_[f"t{i}"], vars_[f"e{i}"] = tid, str(seen)
        q = "query($w: thread_events_bool_exp!, " + ", ".join(vs) + ") { " + " ".join(fs) + " }"
        d = await H.gql(tok, q, vars_, desc="DreamQL workspace: unread message counts")
        return {tid: _int(((d.get(f"c{i}") or {}).get("aggregate") or {}).get("count"))
                for i, (tid, _) in enumerate(items)}

    @app.get("/api/mybots")
    async def mybots(req: Request):
        """Roomless (private) bots the visitor participates in, plus server-side unread totals."""
        tok, sub = _auth(req)
        if not sub:
            return JSONResponse({"error": "anonymous"}, status_code=401)
        try:
            rows = await _parts(tok, sub)
        except Exception as e:
            return H.fail(e)
        bots, unread_all = [], 0
        for p in rows:
            t = p.get("threads_v2") or {}
            unread = H.unread_of(p)
            unread_all += 1 if unread else 0
            if t.get("room_id"):
                continue
            bots.append({
                "thread_id": p["thread_id"],
                "title": t.get("custom_title") or t.get("title") or "(untitled)",
                "unread": unread,
                "unread_count": 0,
                "latest_event_id": _int(p.get("latest_relevant_event_id")),
                "last_seen_event_id": _int(p.get("last_seen_event_id")),
                "latest_at": ((p.get("latest_relevant_thread_event") or {}).get("created_at")) or t.get("updated_at"),
                "hydra": t.get("agent_version") == "hydra",
                "url": H.THREAD_URL + p["thread_id"],
            })
        bots.sort(key=lambda b: b["latest_at"] or "", reverse=True)
        un = [b for b in bots if b["unread"]][:MAX_COUNTS]
        try:
            counts = await _counts(tok, [(b["thread_id"], b["last_seen_event_id"]) for b in un])
        except Exception:
            counts = {}
        for b in un:
            b["unread_count"] = max(counts.get(b["thread_id"], 0), 1)  # hydra chat lives elsewhere: show 1
        return {"bots": bots, "unread": sum(1 for b in bots if b["unread"]), "unread_all": unread_all}

    @app.post("/api/seen/all")
    async def seen_all(body: SeenAllIn, req: Request):
        """Moves the visitor's read pointer to the latest relevant event on every unread bot.
        Forward-only, exactly like /api/seen."""
        tok, sub = _auth(req)
        if not sub:
            return JSONResponse({"error": "anonymous"}, status_code=401)
        try:
            rows = await _parts(tok, sub, body.roomless_only, body.thread_ids)
        except Exception as e:
            return H.fail(e)
        todo = [(p["thread_id"], _int(p["latest_relevant_event_id"])) for p in rows if H.unread_of(p)]
        if body.dry_run or not todo:
            return {"ok": True, "dry_run": body.dry_run, "unread_before": len(todo), "updated": 0,
                    "unread_after": len(todo)}
        updated = 0
        for i in range(0, len(todo), 100):
            ups = [{"where": {"thread_id": {"_eq": tid}, "promptql_user_id": {"_eq": sub},
                              "_or": [{"last_seen_event_id": {"_lt": str(ev)}},
                                      {"last_seen_event_id": {"_is_null": True}}]},
                    "_set": {"last_seen_event_id": str(ev)}} for tid, ev in todo[i:i + 100]]
            try:
                d = await H.gql(tok, UPDATE_M, {"u": ups},
                                desc="DreamQL workspace: mark all your conversations as read")
            except Exception as e:
                return H.fail(e)
            updated += sum(x["affected_rows"] for x in d["update_thread_participants_many"])
        try:
            after = sum(1 for p in await _parts(tok, sub, body.roomless_only, body.thread_ids) if H.unread_of(p))
        except Exception:
            after = None
        return {"ok": True, "unread_before": len(todo), "updated": updated, "unread_after": after,
                "thread_ids": [t for t, _ in todo]}