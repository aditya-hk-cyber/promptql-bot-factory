# /// script
# dependencies = ["fastapi", "uvicorn", "httpx"]
# ///
"""DreamQL Workspace — a Slack-style front end over PromptQL.

Every data call runs as the *visitor* (X-PromptQL-Visitor-Token), never as the
bot's user, so each person sees exactly what their own PromptQL access allows.
"""
import os, re, json, asyncio, base64, time
from pathlib import Path
from urllib.parse import quote
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

BASE = os.environ["PROMPTQL_PLATFORM_API_URL"].rstrip("/")
HERE = Path(__file__).parent
THREAD_URL = "https://prompt.ql.app/project/p-558d2a46-4621/promptql-playground/thread/"
BOT_NAME = "DreamBot"
DM_MAX_MEMBERS = 3  # private rooms with <= this many members render as DMs

app = FastAPI()
_client = None


def client():
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=90)
    return _client


def vtoken(req: Request):
    return req.headers.get("x-promptql-visitor-token")


def claims(tok):
    try:
        p = tok.split(".")[1]
        p += "=" * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p))
    except Exception:
        return {}


async def gql(tok, query, variables=None, desc="DreamQL workspace: read"):
    r = await client().post(
        f"{BASE}/v1/graphql",
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
                 "X-PromptQL-Description": desc},
        json={"query": query, "variables": variables or {}},
    )
    r.raise_for_status()
    d = r.json()
    if "errors" in d:
        raise RuntimeError(json.dumps(d["errors"])[:600])
    return d["data"]


# ---------------- users (cached per visitor for 5 min) ----------------
_users_cache = {}


async def users_for(tok, sub):
    hit = _users_cache.get(sub)
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    d = await gql(tok, "{ promptql_users { promptql_user_id display_name email is_active } }",
                  desc="DreamQL workspace: list members")
    users = {u["promptql_user_id"]: u for u in d["promptql_users"]}
    _users_cache[sub] = (time.time(), users)
    return users


def uname(users, uid):
    return (users.get(uid) or {}).get("display_name") or "Unknown"


# ---------------- message text: PromptQL tags -> Slack-ish text ----------------
ATTR = re.compile(r'(\w+)="([^"]*)"')
TAG = re.compile(r"<(\w+)\b([^>]*?)/>")
CTA = re.compile(r"<cta\b[^>]*>(.*?)</cta>", re.S | re.I)
LEFTOVER = re.compile(r"</?(action|post_in_chat|cta)\b[^>]*>", re.I)


def convert(text, users):
    """Returns (markdown_text, [artifact refs])."""
    arts = []
    if not text:
        return "", arts
    text = CTA.sub(lambda m: f"\n➜ {m.group(1).strip()}\n", text)

    def rep(m):
        name, attrs = m.group(1).lower(), dict(ATTR.findall(m.group(2)))
        if name == "artifact":
            arts.append({"identifier": attrs.get("identifier"), "type": attrs.get("type")})
            return ""
        if name == "user_mention":
            return f"@{uname(users, attrs.get('id'))}"
        if name == "user_group_mention":
            return "@group"
        if name == "broadcast_mention":
            return "@channel" if attrs.get("type") == "room" else "@here"
        if name == "agent_mention":
            return ""
        if name == "room_reference":
            return f"#{attrs.get('name', 'channel')}"
        if name == "wiki_page_reference":
            return f"“{attrs.get('title', '')}”"
        if name == "thread_reference":
            return "(linked conversation)"
        if name == "file_reference":
            return f"`{attrs.get('path', '')}`"
        if name in ("connect_integration", "connect_data_source"):
            return "[connect card]"
        return ""

    text = TAG.sub(rep, text)
    text = LEFTOVER.sub("", text)
    return text.strip(), arts


def upload_refs(uploads):
    out = []
    for u in uploads or []:
        if isinstance(u, dict):
            ident = u.get("identifier") or u.get("artifact_identifier") or u.get("name") or u.get("artifact_name")
            if not ident:
                for v in u.values():
                    if isinstance(v, dict):
                        ident = v.get("identifier") or v.get("artifact_identifier") or v.get("name")
                        if ident:
                            break
            if ident:
                out.append({"identifier": ident, "type": None})
    return out


def art_meta(row):
    lv = ((row.get("artifact") or {}).get("latest_version_object")) or {}
    md = lv.get("artifact_metadata") or {}
    f = ((md.get("type_specific_metadata") or {}).get("file")) or {}
    return {
        "identifier": row.get("identifier"),
        "thread_id": row.get("thread_id"),
        "title": lv.get("title") or row.get("identifier"),
        "type": lv.get("artifact_type"),
        "size": int(lv.get("size") or 0),
        "file_name": f.get("file_name"),
        "content_type": f.get("content_type"),
        "created_at": lv.get("created_at"),
        "hidden": row.get("hidden", False),
    }


ART_FIELDS = "identifier thread_id hidden artifact { latest_version_object { title artifact_type size artifact_metadata created_at } }"


def enrich(refs, meta_by_ident, thread_id):
    out = []
    for r in refs:
        m = meta_by_ident.get(r["identifier"])
        if m:
            out.append(m)
        else:
            out.append({"identifier": r["identifier"], "thread_id": thread_id, "title": r["identifier"],
                        "type": r.get("type") or "file", "size": 0, "file_name": None, "content_type": None})
    return out


def unread_of(part):
    if not part:
        return False
    try:
        return int(part.get("latest_relevant_event_id") or 0) > int(part.get("last_seen_event_id") or 0)
    except Exception:
        return False


# ---------------- endpoints ----------------
@app.get("/readyz")
async def readyz():
    return Response(status_code=204)


@app.get("/api/bootstrap")
async def bootstrap(req: Request):
    tok = vtoken(req)
    if not tok:
        return JSONResponse({"anonymous": True, "channels": [], "dms": [], "members": []})
    sub = claims(tok).get("sub")
    rooms_d, users = await asyncio.gather(
        gql(tok, """query($u: uuid!) {
              rooms { room_id name description visibility updated_at
                rooms_participants(where:{is_removed:{_eq:false}}) { promptql_user_id }
                threads { thread_id updated_at
                  thread_participants(where:{promptql_user_id:{_eq:$u}, is_removed:{_eq:false}}) {
                    last_seen_event_id latest_relevant_event_id latest_relevant_thread_event { created_at } }
                } } }""", {"u": sub}, desc="DreamQL workspace: channels, DMs and unread state"),
        users_for(tok, sub),
    )
    channels, dms, unread_total = [], [], 0
    for r in rooms_d["rooms"]:
        unread_threads, latest = [], r["updated_at"]
        for t in r["threads"]:
            p = (t.get("thread_participants") or [None])[0]
            ts = ((p or {}).get("latest_relevant_thread_event") or {}).get("created_at") or t["updated_at"]
            if ts and ts > (latest or ""):
                latest = ts
            if unread_of(p):
                unread_threads.append({"thread_id": t["thread_id"], "latest": int(p["latest_relevant_event_id"])})
        members = [{"id": m["promptql_user_id"], "name": uname(users, m["promptql_user_id"])}
                   for m in r.get("rooms_participants") or []]
        entry = {
            "room_id": r["room_id"], "name": r["name"], "description": r.get("description"),
            "visibility": r["visibility"], "latest_at": latest, "thread_count": len(r["threads"]),
            "members": members, "unread_threads": unread_threads,
        }
        unread_total += len(unread_threads)
        if r["visibility"] == "private" and 0 < len(members) <= DM_MAX_MEMBERS:
            entry["kind"] = "dm"
            dms.append(entry)
        else:
            entry["kind"] = "channel"
            channels.append(entry)
    channels.sort(key=lambda x: x["name"].lower())
    dms.sort(key=lambda x: x["latest_at"] or "", reverse=True)  # latest message first
    me = users.get(sub) or {}
    members = sorted([{"id": u["promptql_user_id"], "name": u["display_name"]} for u in users.values()
                      if u.get("is_active")], key=lambda x: (x["name"] or "").lower())
    return JSONResponse({"anonymous": False, "me": {"id": sub, "name": me.get("display_name")},
                         "channels": channels, "dms": dms, "members": members, "unread_total": unread_total})


@app.get("/api/room/{room_id}")
async def room(room_id: str, req: Request):
    tok = vtoken(req)
    if not tok:
        return JSONResponse({"anonymous": True, "threads": [], "files": []})
    sub = claims(tok).get("sub")
    d, users = await asyncio.gather(
        gql(tok, """query($r: uuid!, $w: thread_events_bool_exp!) {
          threads_v2(where:{room_id:{_eq:$r}}, order_by:{updated_at:desc}, limit:80) {
            thread_id title custom_title created_at updated_at agent_version
            msgs: thread_events_aggregate(where:$w) { aggregate { count } }
            user { promptql_user_id display_name }
            first: thread_events(where:{event_data:{_has_key:"UserMessage"}}, order_by:{thread_event_id:asc}, limit:1) {
              thread_event_id event_data }
            thread_participants(where:{is_removed:{_eq:false}}) {
              promptql_user_id last_seen_event_id latest_relevant_event_id latest_relevant_thread_event { created_at } }
          }
          thread_artifacts(where:{thread:{room_id:{_eq:$r}}, hidden:{_eq:false}}) { %s }
        }""" % ART_FIELDS, {"r": room_id, "w": MSG_FILTER}, desc="DreamQL workspace: channel messages"),
        users_for(tok, sub),
    )
    metas = [art_meta(a) for a in d["thread_artifacts"]]
    by_thread = {}
    for m in metas:
        by_thread.setdefault(m["thread_id"], {})[m["identifier"]] = m
    threads = []
    for t in d["threads_v2"]:
        parts = t.get("thread_participants") or []
        mine = next((p for p in parts if p["promptql_user_id"] == sub), None)
        text, refs, author_id, ts = "", [], (t.get("user") or {}).get("promptql_user_id"), t["created_at"]
        if t.get("first"):
            um = t["first"][0]["event_data"]["UserMessage"]
            body = um.get("message") or {}
            text, refs = convert(body.get("message", ""), users)
            refs += upload_refs(body.get("uploads"))
            author_id = um.get("user_id") or author_id
            ts = body.get("timestamp") or ts
        last = max([((p.get("latest_relevant_thread_event") or {}).get("created_at") or "") for p in parts] + [t["updated_at"]])
        threads.append({
            "thread_id": t["thread_id"],
            "title": t.get("custom_title") or t.get("title") or "(untitled)",
            "author": uname(users, author_id), "author_id": author_id, "ts": ts,
            "text": text or (t.get("custom_title") or t.get("title") or ""),
            "artifacts": enrich(refs, by_thread.get(t["thread_id"], {}), t["thread_id"]),
            "reply_count": max(int((((t.get("msgs") or {}).get("aggregate") or {}).get("count")) or 0) - 1, 0),
            "last_reply_at": last,
            "participants": [uname(users, p["promptql_user_id"]) for p in parts][:5],
            "unread": unread_of(mine),
            "latest_event_id": int((mine or {}).get("latest_relevant_event_id") or 0),
            "hydra": t.get("agent_version") == "hydra",
            "url": THREAD_URL + t["thread_id"],
        })
    threads.sort(key=lambda x: x["ts"] or "")
    titles = {t["thread_id"]: t["title"] for t in threads}
    files = sorted([{**m, "thread_title": titles.get(m["thread_id"], "")} for m in metas],
                   key=lambda x: x.get("created_at") or "", reverse=True)
    return JSONResponse({"anonymous": False, "threads": threads, "files": files})


MSG_FILTER = {"_or": [
    {"event_data": {"_has_key": "UserMessage"}},
    {"event_data": {"_contains": {"AgentMessage": {"update": {"content": {"interaction_update": {"main_agent": {
        "action_completed": {"result": {"agent_loop_action_result_type": "final_response_sent"}}}}}}}}}},
    {"event_data": {"_contains": {"AgentMessage": {"update": {"content": {"interaction_update": {"main_agent": {
        "action_completed": {"result": {"agent_loop_action_result_type": "message_sent"}}}}}}}}}},
]}


@app.get("/api/thread/{thread_id}")
async def thread(thread_id: str, req: Request):
    tok = vtoken(req)
    if not tok:
        return JSONResponse({"anonymous": True, "messages": []})
    sub = claims(tok).get("sub")
    d, users = await asyncio.gather(
        gql(tok, """query($t: uuid!, $u: uuid!, $w: thread_events_bool_exp!) {
          thread_events(where:{_and:[{thread_id:{_eq:$t}}, $w]}, order_by:{thread_event_id:desc}, limit:300) {
            thread_event_id created_at user_id event_data }
          thread_artifacts(where:{thread_id:{_eq:$t}}) { %s }
          thread_participants(where:{thread_id:{_eq:$t}, promptql_user_id:{_eq:$u}}) { last_seen_event_id latest_relevant_event_id }
        }""" % ART_FIELDS, {"t": thread_id, "u": sub, "w": MSG_FILTER}, desc="DreamQL workspace: thread replies"),
        users_for(tok, sub),
    )
    meta = {a["identifier"]: art_meta(a) for a in d["thread_artifacts"]}
    msgs, seen = [], set()
    for e in reversed(d["thread_events"]):
        ed = e["event_data"]
        if "UserMessage" in ed:
            um = ed["UserMessage"]
            body = um.get("message") or {}
            text, refs = convert(body.get("message", ""), users)
            refs += upload_refs(body.get("uploads"))
            if not text and not refs:
                continue
            uid = um.get("user_id")
            msgs.append({"id": int(e["thread_event_id"]), "author": uname(users, uid), "author_id": uid,
                         "ts": body.get("timestamp") or e["created_at"], "text": text,
                         "artifacts": enrich(refs, meta, thread_id)})
        elif "AgentMessage" in ed:
            am = ed["AgentMessage"]
            upd = am.get("update") or {}
            try:
                res = upd["content"]["interaction_update"]["main_agent"]["action_completed"]["result"]
            except Exception:
                continue
            text, refs = convert(res.get("message", ""), users)
            key = (am.get("message_id"), text)
            if (not text and not refs) or key in seen:
                continue
            seen.add(key)
            msgs.append({"id": int(e["thread_event_id"]), "author": BOT_NAME, "author_id": None,
                         "ts": upd.get("timestamp") or e["created_at"], "text": text,
                         "artifacts": enrich(refs, meta, thread_id)})
    mine = (d["thread_participants"] or [{}])[0]
    return JSONResponse({
        "anonymous": False, "messages": msgs,
        "last_seen_event_id": int(mine.get("last_seen_event_id") or 0),
        "latest_event_id": int(mine.get("latest_relevant_event_id") or 0),
        "url": THREAD_URL + thread_id,
        "files": sorted([m for m in meta.values() if not m["hidden"]], key=lambda x: x.get("created_at") or ""),
    })


def sniff(b: bytes):
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    if b[:5] == b"%PDF-":
        return "application/pdf"
    return None


@app.get("/api/artifact/{thread_id}/{identifier:path}")
async def artifact(thread_id: str, identifier: str, req: Request):
    tok = vtoken(req)
    if not tok:
        return Response(status_code=401)
    r = await client().get(f"{BASE}/v1/artifacts/threads/{thread_id}/{quote(identifier, safe='')}",
                           headers={"Authorization": f"Bearer {tok}"})
    if r.status_code != 200:
        return Response(status_code=r.status_code, content=r.content[:500])
    kind = r.headers.get("x-promptql-artifact-type", "file")
    ctype = r.headers.get("content-type", "application/octet-stream")
    if ctype.startswith("application/octet-stream"):
        ctype = sniff(r.content) or ctype
    # Artifacts are authored by anyone in a room, so nothing served from here may run on
    # this app's origin: every response is sandboxed (opaque origin) and never sniffed.
    headers = {"X-Artifact-Kind": kind, "Cache-Control": "private, max-age=300",
               "Content-Security-Policy": "sandbox allow-scripts allow-popups",
               "X-Content-Type-Options": "nosniff"}
    return Response(content=r.content, media_type=ctype, headers=headers)


# ---------------- writes (run as the visitor) ----------------
class ArtifactRefIn(BaseModel):
    artifact_id: str
    version: int


class UploadIn(BaseModel):
    artifact_name: str
    artifact_reference: ArtifactRefIn


class PostIn(BaseModel):
    text: str = ""
    timezone: str | None = None
    uploads: list[UploadIn] | None = None


def ups(body):
    return [u.model_dump() for u in body.uploads] if body.uploads else None


class SeenItem(BaseModel):
    thread_id: str
    event_id: int


class SeenIn(BaseModel):
    items: list[SeenItem]


MENTION = re.compile(r"(?<![\w@])@dreambot\b", re.I)


def outgoing(text):
    """A message wakes the bot only when it tags @DreamBot, like in PromptQL."""
    text = text.strip()
    if MENTION.search(text):
        return "<agent_mention /> " + MENTION.sub("", text).strip(), "force_respond"
    return text, "force_skip"


def fail(e):
    code = getattr(getattr(e, "response", None), "status_code", None) or 502
    msg = str(e)
    if code == 403 or "permission" in msg.lower():
        msg = "PromptQL refused this. Reload the app and approve its read & write access."
    return JSONResponse({"error": msg[:400]}, status_code=code if code >= 400 else 502)


@app.post("/api/thread/{thread_id}/reply")
async def reply(thread_id: str, body: PostIn, req: Request):
    tok = vtoken(req)
    if not tok:
        return JSONResponse({"error": "Open this app from PromptQL to reply."}, status_code=401)
    if not body.text.strip() and not body.uploads:
        return JSONResponse({"error": "Empty message"}, status_code=400)
    msg, cfg = outgoing(body.text)
    try:
        d = await gql(tok, """mutation($t:String!,$m:String!,$tz:String!,$c:String,$up:[UserUploadInput!]){
            send_thread_message(threadId:$t, message:$m, timezone:$tz, agentResponseConfig:$c, uploads:$up){ message_id thread_event_id } }""",
                      {"t": thread_id, "m": msg, "tz": body.timezone or "Asia/Calcutta", "c": cfg, "up": ups(body)},
                      desc="DreamQL workspace: post your reply" + (" and ask DreamBot to respond" if cfg == "force_respond" else ""))
    except Exception as e:
        return fail(e)
    return {"ok": True, "bot_triggered": cfg == "force_respond", **d["send_thread_message"]}


@app.post("/api/room/{room_id}/post")
async def post(room_id: str, body: PostIn, req: Request):
    tok = vtoken(req)
    if not tok:
        return JSONResponse({"error": "Open this app from PromptQL to post."}, status_code=401)
    if not body.text.strip() and not body.uploads:
        return JSONResponse({"error": "Empty message"}, status_code=400)
    msg, cfg = outgoing(body.text)
    try:
        d = await gql(tok, """mutation($r:String!,$m:String!,$tz:String!,$c:String,$up:[UserUploadInput!]){
            start_thread(roomId:$r, message:$m, timezone:$tz, agentResponseConfig:$c, uploads:$up){ thread_id message_id } }""",
                      {"r": room_id, "m": msg, "tz": body.timezone or "Asia/Calcutta", "c": cfg, "up": ups(body)},
                      desc="DreamQL workspace: post a new message in this channel" + (" and ask DreamBot to respond" if cfg == "force_respond" else ""))
    except Exception as e:
        return fail(e)
    return {"ok": True, "bot_triggered": cfg == "force_respond", **d["start_thread"]}


@app.post("/api/seen")
async def seen(body: SeenIn, req: Request):
    """Moves the visitor's own read pointer forward. Never moves it back."""
    tok = vtoken(req)
    sub = claims(tok).get("sub") if tok else None
    if not sub:
        return JSONResponse({"error": "anonymous"}, status_code=401)
    ups = [{"where": {"thread_id": {"_eq": i.thread_id}, "promptql_user_id": {"_eq": sub},
                      "_or": [{"last_seen_event_id": {"_lt": str(i.event_id)}}, {"last_seen_event_id": {"_is_null": True}}]},
            "_set": {"last_seen_event_id": str(i.event_id)}} for i in body.items[:100] if i.event_id > 0]
    if not ups:
        return {"ok": True, "updated": 0}
    try:
        d = await gql(tok, """mutation($u:[thread_participants_updates!]!){
            update_thread_participants_many(updates:$u){ affected_rows } }""", {"u": ups},
                      desc="DreamQL workspace: mark conversations you opened as read")
    except Exception as e:
        return fail(e)
    return {"ok": True, "updated": sum(x["affected_rows"] for x in d["update_thread_participants_many"])}


# ---------------- core v2: static modules + backend extensions ----------------
import importlib.util
from types import SimpleNamespace

STATIC = HERE / "static"
_SAFE_STATIC = re.compile(r"^[a-z0-9_-]+\.(js|css)$")


@app.get("/static/{name}")
async def static_file(name: str):
    p = STATIC / name
    if not _SAFE_STATIC.match(name) or not p.is_file():
        return Response(status_code=404)
    ct = "text/javascript; charset=utf-8" if name.endswith(".js") else "text/css; charset=utf-8"
    return Response(p.read_bytes(), media_type=ct,
                    headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache"})


def module_tags():
    if not STATIC.is_dir():
        return ""
    files = sorted(p.name for p in STATIC.iterdir() if _SAFE_STATIC.match(p.name))
    css = [f'<link rel="stylesheet" href="/static/{n}">' for n in files if n.endswith(".css")]
    js = [f'<script src="/static/{n}"></script>' for n in files if n.endswith(".js")]
    return "\n".join(css + js)


H = SimpleNamespace(**{k: globals()[k] for k in [
    "gql", "vtoken", "claims", "fail", "users_for", "client", "BASE", "THREAD_URL", "BOT_NAME",
    "unread_of", "convert", "uname", "outgoing", "HERE"] if k in globals()})

for _p in sorted(HERE.glob("ext_*.py")):
    _spec = importlib.util.spec_from_file_location(_p.stem, _p)
    _m = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_m)
    _m.register(app, H)


@app.get("/")
async def index():
    return HTMLResponse((HERE / "index.html").read_text().replace("<!--DQ_MODULES-->", module_tags()))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")