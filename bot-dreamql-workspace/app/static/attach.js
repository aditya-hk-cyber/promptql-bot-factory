/* DreamQL Workspace — module "attach": the composer's + menu.
   Upload from your computer (⌘O / Ctrl+O, drag-drop, paste), Text snippet (⌘⇧Enter),
   File, canvas, or list (an artifact from this channel, attached as a link), Workflow (ask DreamBot to run a saved program).
   Security: every element is built with createElement + textContent. No inline handlers, no HTML built from data. */
(function () {
"use strict";
const DQ = window.DQ;
if (!DQ || !DQ.on) return;

const MAX_FILES = 10, MAX_BYTES = 25 * 1024 * 1024;
const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
const MOD = IS_MAC ? "⌘" : "Ctrl+", MODSH = IS_MAC ? "⌘⇧" : "Ctrl+Shift+";
const LANGS = [["", "Plain text"], ["bash", "Bash"], ["css", "CSS"], ["diff", "Diff"], ["go", "Go"], ["html", "HTML"],
  ["java", "Java"], ["javascript", "JavaScript"], ["json", "JSON"], ["kotlin", "Kotlin"], ["markdown", "Markdown"],
  ["python", "Python"], ["ruby", "Ruby"], ["rust", "Rust"], ["scala", "Scala"], ["sql", "SQL"], ["swift", "Swift"],
  ["typescript", "TypeScript"], ["yaml", "YAML"]];
const st = { files: { room: [], thread: [] }, ctx: { room: null, thread: null }, created: {}, wf: false,
  menu: null, modal: null, seq: 0, abortMsg: null, botName: "DreamBot" };

/* ---------- tiny safe DOM builder ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const inputFor = k => document.getElementById(k === "thread" ? "tin" : "cin");
const ctxKey = k => (k === "thread" ? DQ.S.thread : DQ.S.room) || null;
function fmtSize(n) { if (!n) return ""; if (n < 1024) return n + " B"; if (n < 1048576) return Math.round(n / 1024) + " KB"; return (n / 1048576).toFixed(1) + " MB"; }
function extOf(name) { const m = String(name || "").match(/\.([a-z0-9]{1,5})$/i); return m ? m[1].toUpperCase() : "FILE"; }
function ago(iso) { try { return DQ.ago ? DQ.ago(iso) : ""; } catch (e) { return ""; } }
function syncGo(kind) {
  const i = inputFor(kind); if (!i) return;
  const c = i.closest(".composer"), b = c && c.querySelector(".snd");
  if (b) b.classList.toggle("go", !!i.value.trim() || st.files[kind].length > 0);
}
function insertText(kind, text, inline) {
  const el = inputFor(kind); if (!el) return;
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
  const before = el.value.slice(0, s), after = el.value.slice(e), sep = inline ? " " : "\n";
  const pre = before && !/\s$/.test(before) ? sep : "", post = after && !/^\s/.test(after) ? sep : (inline ? " " : "");
  el.value = before + pre + text + post + after;
  const pos = (before + pre + text + post).length;
  el.focus(); try { el.setSelectionRange(pos, pos); } catch (x) {}
  if (DQ.grow) DQ.grow(el); syncGo(kind);
}

/* ---------- pending files (chips) ---------- */
function addFiles(kind, list) {
  const arr = st.files[kind]; let over = 0;
  for (const f of list) {
    if (arr.length >= MAX_FILES) { over++; continue; }
    if (f.size > MAX_BYTES) { DQ.toast(`“${f.name}” is over 25 MB`); continue; }
    if (!f.size) { DQ.toast(`“${f.name}” is empty`); continue; }
    arr.push({ id: ++st.seq, file: f, status: "ready", ref: null, tid: null, error: "",
      thumb: /^image\/(png|jpe?g|gif|webp)$/.test(f.type) ? URL.createObjectURL(f) : null });
  }
  if (over) DQ.toast(`Up to ${MAX_FILES} files per message`);
  renderChips(kind);
  const i = inputFor(kind); if (i) i.focus();
}
function removeFile(kind, id) {
  const arr = st.files[kind], i = arr.findIndex(x => x.id === id);
  if (i >= 0) { if (arr[i].thumb) URL.revokeObjectURL(arr[i].thumb); arr.splice(i, 1); }
  renderChips(kind);
}
function clearFiles(kind) {
  st.files[kind].forEach(x => x.thumb && URL.revokeObjectURL(x.thumb));
  st.files[kind] = [];
}
function chip(kind, it) {
  const icon = it.thumb ? h("img", { class: "dqa-thumb", src: it.thumb, alt: "" }) : h("span", { class: "dqa-ext", text: extOf(it.file.name) });
  const sub = it.status === "uploading" ? "Uploading…" : it.status === "error" ? ("Failed: " + (it.error || "upload error")) : fmtSize(it.file.size);
  return h("div", { class: "dqa-chip" + (it.status === "error" ? " err" : "") + (it.status === "uploading" ? " busy" : ""), title: it.file.name, "data-chip": String(it.id) },
    icon,
    h("div", { class: "dqa-meta" }, h("div", { class: "dqa-name", text: it.file.name }), h("div", { class: "dqa-size", text: sub })),
    it.status === "uploading" ? h("span", { class: "dqa-spin" }) : null,
    h("button", { type: "button", class: "dqa-x", title: "Remove", "aria-label": "Remove " + it.file.name,
      onclick: e => { e.preventDefault(); e.stopPropagation(); removeFile(kind, it.id); } }, "×"));
}
function renderChips(kind) {
  const input = inputFor(kind); if (!input) return;
  const comp = input.closest(".composer"); if (!comp) return;
  let box = comp.querySelector(".dqa-chips");
  if (!box) { box = h("div", { class: "dqa-chips" }); comp.insertBefore(box, comp.querySelector(".tb")); }
  const arr = st.files[kind];
  box.replaceChildren(...arr.map(it => chip(kind, it)));
  box.hidden = !arr.length;
  if (arr.length) input.dataset.attach = "1"; else delete input.dataset.attach;
  syncGo(kind);
}
function pickFiles(kind) {
  const inp = h("input", { type: "file", multiple: true, class: "dqa-hidden-input", tabindex: "-1", "aria-hidden": "true" });
  const done = () => setTimeout(() => inp.remove(), 0);
  inp.addEventListener("change", () => { if (inp.files && inp.files.length) addFiles(kind, Array.from(inp.files)); done(); });
  inp.addEventListener("cancel", done);
  document.body.append(inp);
  inp.click();
}

/* ---------- sending: upload as the visitor, then fill p.uploads ---------- */
async function newThread(room, title) {
  const j = await DQ.postJSON("/api/attach/thread", { room_id: room, title });
  if (!j.thread_id) throw new Error("no thread id");
  return j.thread_id;
}
async function uploadOne(tid, it) {
  const r = await fetch(`/api/upload/${encodeURIComponent(tid)}`, { method: "POST", body: it.file,
    headers: { "Content-Type": it.file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(it.file.name) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}
function threadTitle(text, list) {
  const t = String(text || "").replace(/@dreambot\b/ig, "").replace(/\s+/g, " ").trim();
  return (t || list.map(x => x.file.name).join(", ")).slice(0, 80);
}
function watchToast() {
  const t = document.getElementById("toast"); if (!t) return;
  const ob = new MutationObserver(() => {
    if (st.abortMsg && /^Couldn't send/.test(t.textContent) && t.textContent !== st.abortMsg) {
      const m = st.abortMsg; st.abortMsg = null; ob.disconnect(); t.textContent = m;
    }
  });
  ob.observe(t, { childList: true, characterData: true, subtree: true });
  setTimeout(() => { ob.disconnect(); st.abortMsg = null; }, 20000);
}
function abortSend(p, msg) {
  // send:before cannot cancel a send, so make the core's POST fail on an empty body; the draft and chips stay.
  st.abortMsg = "Couldn't send: " + msg; watchToast();
  p.text = ""; p.uploads = []; if (p.kind === "room") p.thread_id = null;
  return p;
}
DQ.on("send:before", async p => {
  if (st.wf) return p;
  const kind = p.kind, list = st.files[kind];
  if (!list.length) return p;
  try {
    let tid = kind === "thread" ? (p.thread || DQ.S.thread) : p.thread_id;
    if (!tid) {
      tid = st.created[p.room] || await newThread(p.room, threadTitle(p.text, list));
      st.created[p.room] = tid;
    }
    const todo = list.filter(it => !(it.ref && it.tid === tid));
    todo.forEach(it => { it.status = "uploading"; it.error = ""; });
    renderChips(kind);
    await Promise.all(todo.map(async it => {
      try { it.ref = await uploadOne(tid, it); it.tid = tid; it.status = "done"; }
      catch (e) { it.status = "error"; it.error = e.message; it.ref = null; }
    }));
    renderChips(kind);
    const bad = list.filter(it => it.status === "error");
    if (bad.length) return abortSend(p, `${bad.length} file${bad.length > 1 ? "s" : ""} didn't upload (${bad[0].error}). Remove or retry.`);
    p.uploads = (p.uploads || []).concat(list.map(it => ({ artifact_name: it.ref.artifact_name,
      artifact_reference: { artifact_id: it.ref.artifact_id, version: it.ref.version } })));
    if (kind === "room") p.thread_id = tid;
    if (p.input) p.input.dataset.attach = "1";
    return p;
  } catch (e) {
    list.forEach(it => { if (it.status === "uploading") it.status = "ready"; });
    renderChips(kind);
    return abortSend(p, e.message);
  }
});
DQ.on("send:after", ({ kind }) => {
  if (st.wf) return;
  if (kind === "room") delete st.created[DQ.S.room];
  clearFiles(kind); renderChips(kind);
});

/* ---------- composer wiring ---------- */
function hasFiles(e) { return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")); }
DQ.on("composer:mount", ({ kind, input, composer }) => {
  const key = ctxKey(kind);
  if (st.ctx[kind] !== key) { clearFiles(kind); st.ctx[kind] = key; }
  if (composer && !composer.dataset.dqa) {
    composer.dataset.dqa = "1";
    composer.addEventListener("dragover", e => { if (hasFiles(e)) { e.preventDefault(); composer.classList.add("dqa-drop"); } });
    composer.addEventListener("dragleave", e => { if (!composer.contains(e.relatedTarget)) composer.classList.remove("dqa-drop"); });
    composer.addEventListener("drop", e => {
      composer.classList.remove("dqa-drop");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); addFiles(kind, Array.from(e.dataTransfer.files)); }
    });
    if (input) {
      input.addEventListener("paste", e => {
        const fs = Array.from((e.clipboardData && e.clipboardData.files) || []);
        if (fs.length) { e.preventDefault(); addFiles(kind, fs); }
      });
      input.addEventListener("input", () => syncGo(kind));
    }
  }
  renderChips(kind);
});

/* ---------- the + menu ---------- */
function closeMenu() {
  if (!st.menu) return;
  st.menu.el.remove(); st.menu.btn.classList.remove("on"); st.menu.btn.setAttribute("aria-expanded", "false");
  st.menu = null;
}
function setActive(i) {
  if (!st.menu) return;
  const btns = st.menu.el.querySelectorAll(".dqa-mi"), n = btns.length;
  st.menu.active = ((i % n) + n) % n;
  btns.forEach((b, j) => b.classList.toggle("on", j === st.menu.active));
  btns[st.menu.active].focus();
}
function openMenu({ button, composer, input, kind }) {
  if (st.menu) { const same = st.menu.btn === button; closeMenu(); if (same) return; }
  if (!composer) return;
  const items = [
    { k: "upload", ic: "⤒", label: "Upload from your computer", hint: MOD + "O", run: () => pickFiles(kind) },
    { k: "snippet", ic: "{ }", label: "Text snippet", hint: MODSH + "Enter", run: () => snippetModal(kind) },
    { k: "artifact", ic: "▤", label: "File, canvas, or list", hint: "From this channel", run: () => artifactModal(kind) },
    { k: "workflow", ic: "⚡", label: "Workflow", hint: "Run a saved program", run: () => workflowModal(kind) },
  ];
  const menu = h("div", { class: "dqa-menu", role: "menu", "aria-label": "Attach" },
    h("div", { class: "dqa-mt", text: "Add to your message" }),
    items.map((it, i) => h("button", { type: "button", role: "menuitem", class: "dqa-mi", "data-k": it.k,
      onmouseenter: () => setActive(i),
      onclick: e => { e.preventDefault(); e.stopPropagation(); closeMenu(); it.run(); } },
      h("span", { class: "dqa-mic", text: it.ic }), h("span", { class: "dqa-ml", text: it.label }), h("span", { class: "dqa-mh", text: it.hint }))));
  menu.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(st.menu.active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(st.menu.active - 1); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(-1); }
    else if (e.key === "Tab") { closeMenu(); }
  });
  menu.style.left = Math.max(4, button.offsetLeft - 4) + "px";
  composer.append(menu);
  button.classList.add("on"); button.setAttribute("aria-expanded", "true");
  st.menu = { el: menu, btn: button, kind, input, active: 0 };
  setActive(0);
}
DQ.tool("plus", openMenu);
document.addEventListener("click", e => {
  if (st.menu && !st.menu.el.contains(e.target) && !st.menu.btn.contains(e.target)) closeMenu();
});
DQ.on("composer:key", (e, kind) => {
  if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeMenu(); snippetModal(kind); return true; }
  if (st.menu && st.menu.kind === kind) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive(st.menu.active + (e.key === "ArrowDown" ? 1 : -1)); return true; }
    if (e.key === "Enter") { e.preventDefault(); const b = st.menu.el.querySelectorAll(".dqa-mi")[st.menu.active]; if (b) b.click(); return true; }
  }
  return false;
});
function activeKind() {
  if (st.modal) return null;
  const a = document.activeElement;
  if (a && a.id === "tin") return "thread";
  if (a && a.id === "cin") return "room";
  if (inputFor("thread")) return "thread";
  if (inputFor("room")) return "room";
  return null;
}
// capture phase: runs before the core's Escape handler (which would close the thread pane)
window.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (st.modal) { e.preventDefault(); e.stopPropagation(); closeModal(); return; }
    if (st.menu) { e.preventDefault(); e.stopPropagation(); const k = st.menu.kind; closeMenu(); const i = inputFor(k); if (i) i.focus(); return; }
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "o" || e.key === "O")) {
    const kind = activeKind(); if (!kind) return;
    e.preventDefault(); e.stopPropagation(); closeMenu(); pickFiles(kind);
  }
}, true);

/* ---------- modals ---------- */
function closeModal() {
  if (!st.modal) return;
  const k = st.modal.kind; st.modal.el.remove(); st.modal = null;
  const i = inputFor(k); if (i) i.focus();
}
function openModal(title, body, actions, kind) {
  closeModal(); closeMenu();
  const box = h("div", { class: "dqa-box", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "dqa-bh" }, h("span", { text: title }),
      h("button", { type: "button", class: "dqa-close", "aria-label": "Close", onclick: () => closeModal() }, "×")),
    h("div", { class: "dqa-bb" }, body),
    actions ? h("div", { class: "dqa-bf" }, actions) : null);
  const ov = h("div", { class: "dqa-ov" }, box);
  ov.addEventListener("mousedown", e => { if (e.target === ov) closeModal(); });
  document.body.append(ov);
  const token = {}; st.modal = { el: ov, kind, token };
  return token;
}
const isOpen = token => st.modal && st.modal.token === token;

/* Text snippet */
function snippetModal(kind) {
  const el = inputFor(kind);
  const sel = el && el.selectionEnd > el.selectionStart ? el.value.slice(el.selectionStart, el.selectionEnd) : "";
  const title = h("input", { class: "dqa-in", placeholder: "Title (optional)", maxlength: "120", "aria-label": "Snippet title" });
  const lang = h("select", { class: "dqa-in", "aria-label": "Language" }, LANGS.map(([v, l]) => h("option", { value: v, text: l })));
  const code = h("textarea", { class: "dqa-in dqa-code", rows: "12", placeholder: "Paste or type code…", spellcheck: "false", "aria-label": "Code" });
  code.value = sel;
  const insert = () => {
    const c = code.value.replace(/\s+$/, "");
    if (!c.trim()) { code.focus(); return; }
    const t = title.value.replace(/[\r\n*]+/g, " ").replace(/\s+/g, " ").trim();
    const safe = c.replace(/```/g, "``\u200b`"); // keep the fence intact
    const block = (t ? `**${t}**\n` : "") + "```" + lang.value + "\n" + safe + "\n```";
    closeModal(); insertText(kind, block, false);
  };
  code.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); insert(); }
    else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault(); const s = code.selectionStart, en = code.selectionEnd;
      code.value = code.value.slice(0, s) + "  " + code.value.slice(en); code.setSelectionRange(s + 2, s + 2);
    }
  });
  openModal("Create a text snippet",
    [h("div", { class: "dqa-row" }, title, lang), code, h("div", { class: "dqa-hint", text: `${MOD}Enter to insert · Esc to cancel` })],
    [h("button", { type: "button", class: "dqa-btn", onclick: () => closeModal() }, "Cancel"),
     h("button", { type: "button", class: "dqa-btn dqa-primary", "data-act": "insert", onclick: insert }, "Insert")], kind);
  (sel ? title : code).focus();
}

/* File, canvas, or list — an artifact from this channel, attached as a link */
function artifactLink(f) {
  const title = String(f.title || f.identifier || "artifact").replace(/[\[\]<>\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "artifact";
  const id = /^[^\s<>()\[\]]+$/.test(f.identifier) ? f.identifier : encodeURIComponent(f.identifier);
  return `[${title}](<artifact://thread/${f.thread_id}/${id}>)`;
}
const TYPE_LABEL = { html: "Page", app: "App", table: "List", text: "Canvas", file: "File", visualization: "Chart" };
async function artifactModal(kind) {
  const room = DQ.S.room;
  if (!room) { DQ.toast("Open a channel first"); return; }
  const q = h("input", { class: "dqa-in", type: "search", placeholder: "Search files, canvases and lists in this channel", "aria-label": "Search" });
  const mine = h("input", { type: "checkbox", checked: true });
  const list = h("div", { class: "dqa-list", role: "listbox" }, h("div", { class: "dqa-empty" }, h("span", { class: "dqa-spin" })));
  const token = openModal("Attach a file, canvas, or list",
    [q, h("label", { class: "dqa-chk" }, mine, h("span", { text: "Only from my threads" })), list], null, kind);
  q.focus();
  let data = DQ.S.roomData;
  try { if (!data || !Array.isArray(data.files) || !data.threads) data = await DQ.api("/api/room/" + encodeURIComponent(room)); }
  catch (e) { if (isOpen(token)) list.replaceChildren(h("div", { class: "dqa-empty", text: "Couldn't load this channel's files (" + e.message + ")." })); return; }
  if (!isOpen(token)) return;
  const me = DQ.S.boot && DQ.S.boot.me && DQ.S.boot.me.id, author = {};
  (data.threads || []).forEach(t => { author[t.thread_id] = t.author_id; });
  const pick = f => { closeModal(); insertText(kind, artifactLink(f), true); };
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const rows = (data.files || []).filter(f => (!mine.checked || author[f.thread_id] === me) &&
      (!s || String(f.title || "").toLowerCase().includes(s) || String(f.thread_title || "").toLowerCase().includes(s)));
    if (!rows.length) {
      list.replaceChildren(h("div", { class: "dqa-empty", text: mine.checked ? "No artifacts in your threads here. Untick “Only from my threads” to see everything in this channel." : "No files shared in this channel yet." }));
      return;
    }
    list.replaceChildren(...rows.slice(0, 150).map(f => h("button", { type: "button", class: "dqa-li", role: "option", onclick: () => pick(f) },
      h("span", { class: "dqa-ext t-" + String(f.type || "file").replace(/[^a-z]/g, ""), text: TYPE_LABEL[f.type] || "File" }),
      h("span", { class: "dqa-lt" }, h("span", { class: "dqa-ln", text: f.title || f.identifier }),
        h("span", { class: "dqa-ls", text: `in “${f.thread_title || "a thread"}” · ${ago(f.created_at)}` })))));
  };
  q.addEventListener("input", draw); mine.addEventListener("change", draw);
  q.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); const b = list.querySelector(".dqa-li"); if (b) b.click(); } });
  draw();
}

/* Workflow — ask DreamBot to run a saved program */
async function runWorkflow(kind, prog, notes) {
  const el = inputFor(kind); if (!el) return;
  const draft = el.value, bot = st.botName;
  const label = prog.name && prog.name !== prog.package_name ? ` (${String(prog.name).replace(/[`\r\n]+/g, " ")})` : "";
  el.value = `@${bot} please run the saved program \`${prog.package_name}\`${label}.` + (notes ? "\n" + notes : "");
  st.wf = true;
  try { await DQ.send(kind); }
  finally {
    st.wf = false;
    const e2 = inputFor(kind);
    if (e2) { e2.value = draft; if (DQ.grow) DQ.grow(e2); renderChips(kind); }
  }
}
async function workflowModal(kind) {
  const q = h("input", { class: "dqa-in", type: "search", placeholder: "Search saved programs", "aria-label": "Search" });
  const list = h("div", { class: "dqa-list", role: "listbox" }, h("div", { class: "dqa-empty" }, h("span", { class: "dqa-spin" })));
  const notes = h("textarea", { class: "dqa-in", rows: "2", placeholder: "Anything to add? (inputs, time range…) — optional", "aria-label": "Notes" });
  const go = h("button", { type: "button", class: "dqa-btn dqa-primary", disabled: true }, "Ask DreamBot to run it");
  const where = kind === "thread" ? "in this thread" : "as a new thread in this channel";
  const token = openModal("Run a workflow",
    [h("div", { class: "dqa-hint", text: `Pick a saved program. This posts a message ${where} asking the bot to run it.` }), q, list, notes],
    [h("button", { type: "button", class: "dqa-btn", onclick: () => closeModal() }, "Cancel"), go], kind);
  q.focus();
  let progs = [], sel = null;
  try { const j = await DQ.api("/api/attach/programs"); progs = j.programs || []; if (j.bot_name) st.botName = j.bot_name; }
  catch (e) { if (isOpen(token)) list.replaceChildren(h("div", { class: "dqa-empty", text: "Couldn't load saved programs (" + e.message + ")." })); return; }
  if (!isOpen(token)) return;
  go.textContent = `Ask ${st.botName} to run it`;
  const run = () => { if (!sel) return; const n = notes.value.trim(); closeModal(); runWorkflow(kind, sel, n); };
  go.addEventListener("click", run);
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const rows = progs.filter(p => !s || p.package_name.toLowerCase().includes(s) || String(p.name || "").toLowerCase().includes(s) || String(p.owner || "").toLowerCase().includes(s));
    if (!rows.length) { list.replaceChildren(h("div", { class: "dqa-empty", text: progs.length ? "No match." : "You can't see any saved programs yet." })); return; }
    list.replaceChildren(...rows.map(p => {
      const b = h("button", { type: "button", class: "dqa-li" + (sel === p ? " on" : ""), role: "option", "aria-selected": sel === p ? "true" : "false",
        onclick: () => { sel = p; go.disabled = false; draw(); }, ondblclick: () => { sel = p; run(); } },
        h("span", { class: "dqa-ext t-wf", text: "⚡" }),
        h("span", { class: "dqa-lt" }, h("span", { class: "dqa-ln", text: p.name || p.package_name }),
          h("span", { class: "dqa-ls" }, h("code", { text: p.package_name }), ` · ${p.owner || "unknown owner"} · updated ${ago(p.updated_at)}`)));
      return b;
    }));
  };
  q.addEventListener("input", draw);
  draw();
}

/* ---------- render artifact links in messages as chips ---------- */
const ALINK = /\[([^\]\n]{1,200})\]\(<artifact:\/\/thread\/([0-9a-fA-F-]{36})\/([^>\s]{1,300})>\)/g;
function alink(title, tid, ident) {
  let id = ident; try { id = decodeURIComponent(ident); } catch (e) {}
  return h("a", { class: "dqa-alink", href: `/api/artifact/${encodeURIComponent(tid)}/${encodeURIComponent(id)}`,
    target: "_blank", rel: "noopener", title: "Open " + title }, h("span", { class: "dqa-ai", text: "📎" }), title);
}
function decorate(root) {
  if (!root || !root.ownerDocument) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n =>
    n.nodeValue.indexOf("artifact://thread/") >= 0 && !(n.parentElement && n.parentElement.closest("textarea,input,script,style,.dqa-alink"))
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  const nodes = []; while (w.nextNode()) nodes.push(w.currentNode);
  for (const n of nodes) {
    const s = n.nodeValue, frag = document.createDocumentFragment(); let m, last = 0, hit = false;
    ALINK.lastIndex = 0;
    while ((m = ALINK.exec(s))) { hit = true; frag.append(s.slice(last, m.index), alink(m[1], m[2], m[3])); last = m.index + m[0].length; }
    if (hit) { frag.append(s.slice(last)); n.replaceWith(frag); }
  }
}
new MutationObserver(ms => {
  for (const m of ms) for (const n of m.addedNodes) {
    if (n.nodeType === 1) decorate(n); else if (n.nodeType === 3 && n.parentElement) decorate(n.parentElement);
  }
}).observe(document.body, { childList: true, subtree: true });
decorate(document.body);

DQ.attach = { addFiles, pickFiles, snippetModal, artifactModal, workflowModal, state: st };
})();