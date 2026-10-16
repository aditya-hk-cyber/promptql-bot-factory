/* DreamQL Workspace module: nav — back/forward history, "Your bots", server-backed read sync.
   Attaches only through window.DQ. Every data string is escaped; no inline handlers. */
(function () {
  "use strict";
  const DQ = window.DQ;
  if (!DQ || !DQ.S) return;
  const S = DQ.S, esc = DQ.esc, $ = id => document.getElementById(id);
  const LS_RECENT = "dq_nav_recent", LS_COL = "dq_nav_bots_col";
  const svg = (w, body) => `<svg class="i" viewBox="0 0 20 20" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const BOT_IC = w => svg(w || 14, '<rect x="4" y="7" width="12" height="9" rx="2"/><path d="M10 3.5V7M7.5 11h.01M12.5 11h.01"/>');
  const LEFT = svg(16, '<path d="M16 10H4M9 5l-5 5 5 5"/>'), RIGHT = svg(16, '<path d="M4 10h12M11 5l5 5-5 5"/>');
  const CHECK = svg(15, '<path d="M2.5 10.5l3 3 6-7M9 13.5l1 1 7-8"/>');

  /* ---------------- state ---------------- */
  const M = { bots: [], unreadAll: null, loaded: false, showAll: false, col: lsGet(LS_COL) === "1" };
  const H = { stack: [], idx: -1, busy: 0, recent: loadRecent() };
  function lsGet(k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  function lsSet(k, v) { try { localStorage.setItem(k, v) } catch (e) { } }
  function loadRecent() { try { const r = JSON.parse(lsGet(LS_RECENT) || "[]"); return Array.isArray(r) ? r.slice(0, 20) : [] } catch (e) { return [] } }

  /* ---------------- labels ---------------- */
  function roomOf(id) { try { return id ? DQ.allRooms().find(r => r.room_id === id) : null } catch (e) { return null } }
  function roomLabel(r) { return r.kind === "dm" ? DQ.dmLabel(r) : (r.visibility === "public" ? "# " : "") + r.name }
  function botOf(id) { return M.bots.find(b => b.thread_id === id) }
  function threadTitle(id) {
    const t = S.roomData && S.roomData.threads && S.roomData.threads.find(x => x.thread_id === id);
    if (t) return t.title; const b = botOf(id); return b ? b.title : null;
  }
  function labelOf(e) {
    if (e.type === "room") { const r = roomOf(e.id); return r ? roomLabel(r) : (e.label || "Conversation") }
    return threadTitle(e.id) || e.label || "Thread";
  }
  function subOf(e) {
    if (e.type === "room") { const r = roomOf(e.id); return r ? (r.kind === "dm" ? "Direct message" : "Channel") : "" }
    if (!e.room) return "Your bots";
    const r = roomOf(e.room); return r ? "Thread in " + roomLabel(r) : "Thread";
  }
  function iconOf(e) {
    if (e.type === "room") { const r = roomOf(e.id); return r && r.visibility !== "public" ? DQ.ic("lock", 14) : "#" }
    return e.room ? DQ.ic("dms", 14) : BOT_IC(14);
  }

  /* ---------------- history ---------------- */
  function same(a, b) { return a && b && a.type === b.type && a.id === b.id }
  function addRecent(e) {
    const it = { type: e.type, id: e.id, room: e.room || null, label: labelOf(e), at: Date.now() };
    H.recent = [it].concat(H.recent.filter(x => !same(x, it))).slice(0, 20);
    lsSet(LS_RECENT, JSON.stringify(H.recent));
  }
  function push(e) {
    const cur = H.stack[H.idx];
    if (same(cur, e)) return;
    // re-opening the room behind an open thread (e.g. after posting) does not change the view
    if (e.type === "room" && cur && cur.type === "thread" && cur.room === e.id && S.thread === cur.id) return;
    H.stack = H.stack.slice(0, H.idx + 1); H.stack.push(e);
    if (H.stack.length > 100) H.stack.shift();
    H.idx = H.stack.length - 1;
    addRecent(e); paintNav();
  }
  DQ.on("nav:open", p => {
    if (!p || !p.id) return;
    if (p.type === "room") syncRoom(p.id);          // every open + every refresh of a channel
    if (p.refresh || H.busy) return;                // back/forward/refresh never push
    push({ type: p.type, id: p.id, room: p.type === "thread" ? (p.room || null) : null });
  });
  function quiet(fn) { H.busy++; try { return fn() } finally { H.busy-- } }  // nav:open is emitted synchronously
  async function show(e) {
    if (e.type === "room") {
      if (!roomOf(e.id)) { DQ.toast("That conversation isn't available any more"); return false }
      if (S.room !== e.id) await quiet(() => DQ.openRoom(e.id));
      if (S.room === e.id && S.thread) DQ.closeThread();
    } else if (e.room) {
      if (!roomOf(e.room)) { DQ.toast("That conversation isn't available any more"); return false }
      if (S.room !== e.room) await quiet(() => DQ.openRoom(e.room));
      if (S.room !== e.room) return false;            // the user went elsewhere meanwhile
      if (S.thread !== e.id) await quiet(() => DQ.openThread(e.id));
    } else if (!(S.thread === e.id && !S.room)) {
      await quiet(() => openBot(e.id));
    }
    return true;
  }
  async function go(d) {
    const j = H.idx + d;
    if (j < 0 || j >= H.stack.length) return;
    H.idx = j; paintNav(); closeMenu();
    try { await show(H.stack[j]) } finally { paintNav(); DQ.renderSide() }
  }
  async function openEntry(e) {
    closeMenu();
    const target = { type: e.type, id: e.id, room: e.room || null };
    if (await show(target)) push(target);
  }

  /* ---------------- top bar: ← → and the clock menu ---------------- */
  function mountNav() {
    const nav = document.querySelector(".topbar .nav");
    if (!nav || nav.dataset.navMod) return;
    nav.dataset.navMod = "1"; nav.classList.add("nav-mod");
    nav.innerHTML = `<button type="button" class="nav-b" id="nav-back" title="Back (Alt+←)" aria-label="Back">${LEFT}</button>` +
      `<button type="button" class="nav-b" id="nav-fwd" title="Forward (Alt+→)" aria-label="Forward">${RIGHT}</button>` +
      `<button type="button" class="nav-b" id="nav-hist" title="History" aria-label="History" aria-haspopup="true">${DQ.ic("clock", 16)}</button>` +
      `<div class="nav-menu" id="nav-menu" role="menu" hidden></div>`;
    $("nav-back").addEventListener("click", () => go(-1));
    $("nav-fwd").addEventListener("click", () => go(1));
    $("nav-hist").addEventListener("click", e => { e.stopPropagation(); $("nav-menu").hidden ? openMenu() : closeMenu() });
    $("nav-menu").addEventListener("click", e => {
      e.stopPropagation();
      const b = e.target.closest("[data-i]"); if (!b) return;
      const it = H.recent[+b.dataset.i]; if (it) openEntry(it);
    });
    document.addEventListener("click", closeMenu);
    paintNav();
  }
  function paintNav() {
    const b = $("nav-back"), f = $("nav-fwd"); if (!b) return;
    b.disabled = H.idx <= 0; f.disabled = H.idx >= H.stack.length - 1;
  }
  function openMenu() {
    const m = $("nav-menu"), cur = H.stack[H.idx];
    const items = H.recent.slice(0, 15);
    m.innerHTML = `<div class="nav-mh">Recent</div>` + (items.length ? items.map((e, i) =>
      `<button type="button" role="menuitem" class="nav-mi${same(cur, e) ? " on" : ""}" data-i="${i}">` +
      `<span class="nav-mi-ic">${iconOf(e)}</span><span class="nav-mi-tx"><span class="nav-mi-t">${esc(labelOf(e))}</span>` +
      `<span class="nav-mi-s">${esc(subOf(e))}${e.at ? " · " + esc(DQ.ago(new Date(e.at).toISOString())) : ""}</span></span></button>`).join("")
      : `<div class="nav-me">Conversations you open show up here.</div>`);
    m.hidden = false; $("nav-hist").classList.add("on");
  }
  function closeMenu() { const m = $("nav-menu"); if (m && !m.hidden) { m.hidden = true; $("nav-hist").classList.remove("on") } }

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeMenu(); return }
    const alt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight");
    const cmd = e.metaKey && !e.altKey && !e.ctrlKey && (e.key === "[" || e.key === "]");
    if (!alt && !cmd) return;
    const t = e.target, editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""));
    if (editable && t.value) return;                   // keep word-jumps while typing
    e.preventDefault(); e.stopPropagation();
    go(e.key === "ArrowLeft" || e.key === "[" ? -1 : 1);
  }, true);
  document.addEventListener("mouseup", e => { if (e.button === 3 || e.button === 4) { e.preventDefault(); go(e.button === 3 ? -1 : 1) } });

  /* ---------------- "Your bots" (roomless bots) ---------------- */
  function botUnread(b) { return !!b.unread && DQ.isUnread(b.thread_id, b.latest_event_id) }  // local map can only hide
  let mineP = null;
  function loadMine() {
    if (mineP) return mineP;
    mineP = (async () => {
      try {
        const d = await DQ.api("/api/mybots");
        M.bots = d.bots || []; M.unreadAll = d.unread_all; M.loaded = true;
        reconcile(M.bots.filter(b => b.unread).map(b => ({ thread_id: b.thread_id, event_id: b.latest_event_id })));
        DQ.renderSide();
      } catch (e) { console.warn("nav: /api/mybots", e) } finally { mineP = null }
    })();
    return mineP;
  }
  async function openBot(id) {
    if (!M.loaded) await loadMine();
    const b = botOf(id), url = b ? b.url : "#";
    DQ.closeThread();
    S.room = null; S.roomData = null; S.tab = "messages"; S.newFrom = null;
    $("pane").innerHTML = `<div class="nav-bp"><div class="nav-bp-ic">${BOT_IC(40)}</div>` +
      `<div class="nav-bp-t">${esc(b ? b.title : "Private bot")}</div>` +
      `<div class="nav-bp-s">A private bot that isn't in any room. Its conversation is open on the right.</div>` +
      `<a class="nav-bp-a" target="_blank" rel="noopener" href="${esc(url)}">Open in PromptQL ↗</a></div>`;
    DQ.renderSide();
    const p = DQ.openThread(id);                     // emits nav:open {type:"thread", room:null}
    const tp = $("tp"), a = tp && tp.querySelector(".tph a"), s = tp && tp.querySelector(".tph .s");
    if (a) a.setAttribute("href", url);
    if (s) s.textContent = "Your bots";
    await p;
  }
  function botsSection(list) {
    const q = (($("find") && $("find").value) || "").trim().toLowerCase();
    let bots = M.bots.filter(b => !q || (b.title || "").toLowerCase().includes(q));
    if (S.filter === "unread") bots = bots.filter(botUnread);
    if (S.filter === "unread" && !bots.length) return;
    const nUn = M.bots.filter(botUnread).length;
    let shown = bots, more = 0;
    if (!M.showAll && !q && S.filter !== "unread") {
      let room = Math.max(0, 8 - bots.filter(botUnread).length);
      shown = bots.filter(b => botUnread(b) || room-- > 0); more = bots.length - shown.length;
    }
    const item = b => {
      const u = botUnread(b), on = S.thread === b.thread_id && !S.room;
      return `<div class="it nav-bot${u ? " unread" : ""}${on ? " on" : ""}" data-bot="${esc(b.thread_id)}" title="${esc(b.title)}">` +
        `<span class="ic">${BOT_IC(14)}</span><span class="nm">${esc(b.title)}</span>${u ? `<span class="cnt">${esc(b.unread_count || 1)}</span>` : ""}</div>`;
    };
    const body = !M.loaded ? `<div class="empty-s">Loading…</div>` : shown.length ? shown.map(item).join("") +
      (more ? `<div class="it nav-more" data-nav-more="1"><span class="ic">…</span><span class="nm">Show ${more} more</span></div>` : "") +
      (M.showAll && !q && bots.length > 8 && S.filter !== "unread" ? `<div class="it nav-more" data-nav-more="0"><span class="ic">…</span><span class="nm">Show less</span></div>` : "")
      : `<div class="empty-s">${q ? "No matching bots" : "No private bots"}</div>`;
    list.insertAdjacentHTML("beforeend", `<div class="sec nav-sec${M.col ? " col" : ""}" id="s-bots"><div class="sec-h" data-nav-sec="1">` +
      `<span class="chev">▼</span>Your bots${nUn ? `<span class="nav-hcnt">${nUn}</span>` : ""}</div><div class="items">${body}</div></div>`);
  }
  DQ.on("side:render", ({ list }) => {
    if (!list || !S.boot) return;
    if (S.filter !== "dms") botsSection(list);
    if (S.filter === "unread" && total() > 0) list.insertAdjacentHTML("afterbegin",
      `<div class="nav-markbar"><button type="button" class="nav-markall" data-nav-markall="1">${CHECK}<span>Mark all as read</span></button></div>`);
    list.querySelectorAll("[data-bot]").forEach(el => el.addEventListener("click", () => openBot(el.dataset.bot)));
    list.querySelectorAll("[data-nav-more]").forEach(el => el.addEventListener("click", () => { M.showAll = el.dataset.navMore === "1"; DQ.renderSide() }));
    const h = list.querySelector("[data-nav-sec]");
    if (h) h.addEventListener("click", () => { M.col = !M.col; lsSet(LS_COL, M.col ? "1" : "0"); h.parentNode.classList.toggle("col", M.col) });
    queueMicrotask(paintBadge);                       // core paints its rooms-only badge right after this event
  });

  /* ---------------- server-backed unread counts ---------------- */
  function roomsUnread() {
    try { return DQ.allRooms().reduce((a, r) => a + r.unread_threads.filter(t => DQ.isUnread(t.thread_id, t.latest)).length, 0) } catch (e) { return 0 }
  }
  function total() { return roomsUnread() + M.bots.filter(botUnread).length }
  function paintBadge() {
    if (!S.boot) return;
    const tot = total(), rb = $("rb-act");
    if (rb) { rb.style.display = tot ? "block" : "none"; rb.textContent = tot }
    document.title = (tot ? `(${tot}) ` : "") + "DreamQL";
  }

  /* ---------------- read sync ---------------- */
  // Applies a confirmed server move locally (server state), so badges drop without waiting for a refresh.
  function applySeen(items) {
    const ev = {}; items.forEach(i => { ev[i.thread_id] = Math.max(ev[i.thread_id] || 0, i.event_id) });
    if (S.boot) DQ.allRooms().forEach(r => { r.unread_threads = r.unread_threads.filter(t => !(ev[t.thread_id] >= t.latest)) });
    M.bots.forEach(b => { if (ev[b.thread_id] >= b.latest_event_id) { b.unread = false; b.unread_count = 0 } });
    if (S.roomData && S.roomData.threads) S.roomData.threads.forEach(t => { if (ev[t.thread_id] >= t.latest_event_id) t.unread = false });
  }
  // A failed sync must not leave the local map hiding something the server still calls unread.
  function unhide(items) {
    const m = DQ.seenMap(); let ch = false;
    items.forEach(i => { if (i.thread_id in m) { delete m[i.thread_id]; ch = true } });
    if (ch) lsSet("dq_seen", JSON.stringify(m));
  }
  let failNote = 0;
  const inflight = {};                                 // thread_id -> event_id being sent right now
  async function syncSeen(items) {
    items = (items || []).filter(i => i && i.thread_id && +i.event_id > 0).map(i => ({ thread_id: i.thread_id, event_id: +i.event_id }))
      .filter(i => !(inflight[i.thread_id] >= i.event_id));
    items.forEach(i => { inflight[i.thread_id] = i.event_id });
    try { return await syncChunks(items) } finally { items.forEach(i => { if (inflight[i.thread_id] === i.event_id) delete inflight[i.thread_id] }) }
  }
  async function syncChunks(items) {
    let updated = 0;
    for (let i = 0; i < items.length; i += 100) {
      const chunk = items.slice(i, i + 100);
      try { const j = await DQ.postJSON("/api/seen", { items: chunk }); updated += j.updated || 0; applySeen(chunk) }
      catch (e) {
        console.warn("nav: read sync failed", e); unhide(chunk);
        if (Date.now() > failNote) { failNote = Date.now() + 60000; DQ.toast("Couldn't sync read state to PromptQL: " + e.message) }
      }
    }
    if (items.length) DQ.renderSide();
    return { updated };
  }
  window.syncSeen = syncSeen; DQ.syncSeen = syncSeen;   // core calls the global; route it through the module

  // Opening a channel marks every unread bot in it read — all of them, not just the 80 the feed loads.
  function syncRoom(id) {
    const r = roomOf(id); if (!r) return;
    const items = r.unread_threads.map(t => ({ thread_id: t.thread_id, event_id: t.latest }));
    if (!items.length) return;
    items.forEach(i => DQ.markSeen(i.thread_id, i.event_id));
    syncSeen(items);
  }
  // Anything the local map hides but the server still calls unread was read here and never synced: push it.
  function reconcile(items) {
    const m = DQ.seenMap();
    const stale = items.filter(i => (m[i.thread_id] || 0) >= i.event_id);
    if (stale.length) syncSeen(stale);
  }
  DQ.on("boot:loaded", b => {
    reconcile(b.channels.concat(b.dms).flatMap(r => r.unread_threads.map(t => ({ thread_id: t.thread_id, event_id: t.latest }))));
    loadMine();
  });

  /* ---------------- Mark all as read ---------------- */
  let armed = 0, armT = null;
  function disarm() {
    armed = 0; clearTimeout(armT);
    document.querySelectorAll("[data-nav-markall]").forEach(b => { b.classList.remove("arm"); const s = b.querySelector("span"); if (s) s.textContent = "Mark all as read" });
  }
  async function markAll(btn) {
    const n = total();
    if (!n) { DQ.toast("You're all caught up", true); return }
    if (Date.now() > armed) {
      armed = Date.now() + 4000; clearTimeout(armT); armT = setTimeout(disarm, 4000);
      btn.classList.add("arm"); const s = btn.querySelector("span");
      if (s) s.textContent = `Mark ${n} as read?`; else DQ.toast(`Click again to mark all ${n} unread as read (also in PromptQL)`, true);
      return;
    }
    disarm(); btn.disabled = true;
    try {
      const j = await DQ.postJSON("/api/seen/all", {});
      DQ.toast(`Marked ${j.updated} conversation${j.updated === 1 ? "" : "s"} as read`, true);
      await DQ.loadBoot(); await loadMine();
      if (S.room) DQ.openRoom(S.room, true);
    } catch (e) { DQ.toast("Couldn't mark all as read: " + e.message) }
    finally { btn.disabled = false }
  }
  document.addEventListener("click", e => { const b = e.target.closest && e.target.closest("[data-nav-markall]"); if (b) { e.preventDefault(); markAll(b) } });
  function mountHeader() {
    const tools = document.querySelector(".ws .tools");
    if (!tools || tools.querySelector("[data-nav-markall]")) return;
    tools.insertAdjacentHTML("afterbegin", `<button type="button" class="nav-tool" data-nav-markall="1" title="Mark all as read" aria-label="Mark all as read">${CHECK}</button>`);
  }

  mountNav(); mountHeader();
  DQ.nav = { go, openBot, loadMine, history: H, bots: M, total };   // for other modules and tests
})();