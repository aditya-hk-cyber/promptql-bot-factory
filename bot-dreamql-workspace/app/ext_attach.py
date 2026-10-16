"""DreamQL Workspace module "attach" — backend for the composer's + menu.

Endpoints (every call runs as the visitor, from X-PromptQL-Visitor-Token):
  POST /api/upload/{thread_id}   raw file bytes in the body, file name in X-File-Name (URI-encoded).
                                 PUTs a `file` artifact on that bot; returns {artifact_name, artifact_id, version, ...}.
  POST /api/attach/thread        {room_id, title} -> create_empty_thread, so a new channel post has a bot
                                 to upload into before its first message. Returns {thread_id}.
  GET  /api/attach/programs      saved programs the visitor can see (for the Workflow item).
"""
import re
import secrets
import mimetypes
from urllib.parse import quote, unquote

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
CTYPE_RE = re.compile(r"^[\w.+-]{1,60}/[\w.+-]{1,100}$")
MAX_BYTES = 25 * 1024 * 1024


class NewThreadIn(BaseModel):
    room_id: str
    title: str | None = None


def _anon(what):
    return JSONResponse({"error": f"Open this app from PromptQL to {what}."}, status_code=401)


def _safe_name(raw):
    """Returns (display/download file name, identifier stem, extension). ASCII only: they go into headers."""
    try:
        name = unquote(raw or "")
    except Exception:
        name = ""
    name = name.replace("\\", "/").split("/")[-1].strip()[:300]
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, ext = name, ""
    ext = re.sub(r"[^A-Za-z0-9]", "", ext)[:10].lower()
    stem = re.sub(r"[^A-Za-z0-9._ ()-]+", "_", stem).strip(" ._")[:80] or "file"
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")[:40] or "file"
    return stem + (f".{ext}" if ext else ""), slug, ext


def _sniff(b: bytes):
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


def _platform_error(r, default):
    try:
        e = r.json().get("error") or {}
        msg = e.get("message") if isinstance(e, dict) else str(e)
    except Exception:
        msg = None
    if r.status_code == 403:
        return "PromptQL refused the upload. Reload the app and approve its artifact access."
    return (msg or default)[:300]


def register(app, H):
    @app.post("/api/upload/{thread_id}")
    async def attach_upload(thread_id: str, req: Request):
        tok = H.vtoken(req)
        if not tok:
            return _anon("upload files")
        if not UUID_RE.match(thread_id):
            return JSONResponse({"error": "Bad thread id"}, status_code=400)
        data = await req.body()
        if not data:
            return JSONResponse({"error": "The file is empty"}, status_code=400)
        if len(data) > MAX_BYTES:
            return JSONResponse({"error": "Files must be 25 MB or smaller"}, status_code=413)
        fname, slug, ext = _safe_name(req.headers.get("x-file-name"))
        declared = (req.headers.get("content-type") or "").split(";")[0].strip().lower()
        if not CTYPE_RE.match(declared) or declared.startswith("multipart/"):
            declared = ""
        # magic bytes win over what the browser says, so previews never break on a wrong type
        ctype = _sniff(data) or declared or mimetypes.guess_type(fname)[0] or "application/octet-stream"
        ident = f"{slug}-{secrets.token_hex(3)}" + (f".{ext}" if ext else "")
        try:
            r = await H.client().put(
                f"{H.BASE}/v1/artifacts/threads/{thread_id}/{quote(ident, safe='')}",
                headers={"Authorization": f"Bearer {tok}", "X-PromptQL-Artifact-Type": "file",
                         "X-PromptQL-Artifact-File-Name": fname, "X-PromptQL-Artifact-Title": fname,
                         "Content-Type": ctype},
                content=data,
            )
        except Exception as e:
            return H.fail(e)
        if r.status_code not in (200, 201):
            return JSONResponse({"error": _platform_error(r, "Upload failed")},
                                status_code=r.status_code if r.status_code >= 400 else 502)
        j = r.json()
        return {"artifact_name": ident, "artifact_id": j["artifact_id"], "version": j["version"],
                "file_name": fname, "content_type": ctype, "size": len(data), "thread_id": thread_id}

    @app.post("/api/attach/thread")
    async def attach_new_thread(body: NewThreadIn, req: Request):
        tok = H.vtoken(req)
        if not tok:
            return _anon("post")
        if not UUID_RE.match(body.room_id):
            return JSONResponse({"error": "Bad room id"}, status_code=400)
        pid = (H.claims(tok).get("https://promptql.hasura.io") or {}).get("x-hasura-project-id")
        title = re.sub(r"\s+", " ", body.title or "").strip()[:80] or "Shared files"
        try:
            if not pid:
                d = await H.gql(tok, "query($r: uuid!){ rooms_by_pk(room_id:$r){ project_id } }",
                                {"r": body.room_id}, desc="DreamQL workspace: look up this channel's project")
                pid = (d.get("rooms_by_pk") or {}).get("project_id")
            if not pid:
                return JSONResponse({"error": "Couldn't find this channel's project"}, status_code=404)
            d = await H.gql(tok, """mutation($p:String!,$r:String,$t:String){
                create_empty_thread(projectId:$p, roomId:$r, title:$t){ thread_id } }""",
                            {"p": pid, "r": body.room_id, "t": title},
                            desc="DreamQL workspace: start a new thread to hold your attachments")
        except Exception as e:
            return H.fail(e)
        return {"thread_id": d["create_empty_thread"]["thread_id"]}

    @app.get("/api/attach/programs")
    async def attach_programs(req: Request):
        tok = H.vtoken(req)
        if not tok:
            return _anon("see workflows")
        try:
            d = await H.gql(tok, """{ programs(order_by:{updated_at:desc}, limit:200) {
                package_name name visibility updated_at owner_user { display_name } } }""",
                            desc="DreamQL workspace: list saved programs you can see")
        except Exception as e:
            return H.fail(e)
        progs = [{"package_name": p["package_name"], "name": p.get("name") or p["package_name"],
                  "visibility": p.get("visibility"), "updated_at": p.get("updated_at"),
                  "owner": (p.get("owner_user") or {}).get("display_name") or ""} for p in d["programs"]]
        return {"programs": progs, "bot_name": H.BOT_NAME}