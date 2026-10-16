/* DreamQL Workspace — compose module (core v2 plug-in).
 * Aa: formatting bar (bold, italic, strike, inline code, code block, link, bulleted/numbered list, quote)
 *     that wraps the selection in markdown, plus shortcuts ⌘/Ctrl+B, ⌘/Ctrl+I and ⌘/Ctrl+⇧X.
 * Mic: dictation with the Web Speech API, inserted at the caret, with a recording indicator.
 * /:   slash-command menu (button, or "/" at the start of the message): /dreambot /files /open /remind /markread /shrug.
 * Security: every data-derived string goes through DQ.esc(); no inline handlers; data-* + addEventListener only.
 */
(function () {
  "use strict";
  const DQ = window.DQ;
  if (!DQ || !DQ.on || !DQ.tool) return;

  const BOTNAME = (typeof BOT === "string" && BOT) || "DreamBot";
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const MOD = IS_MAC ? "⌘" : "Ctrl+";
  const SHRUG = "¯\\_(ツ)_/¯";
  const BLOCKED = "Dictation isn't available in this frame";
  const LS_FMT = "dq_compose_fmt";

  const esc = (s) => (DQ.esc ? DQ.esc(s) : String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";"));
  const inputOf = (c) => (c ? c.querySelector("textarea") : null);
  const kindOf = (i) => (i && i.id === "tin" ? "thread" : "room");
  const byKind = (k) => document.getElementById(k === "thread" ? "tin" : "cin");
  const toast = (m, ok) => DQ.toast && DQ.toast(m, ok);

  /* ------------------------------------------------------------------ text editing helpers */
  function fire(input) { input.dispatchEvent(new Event("input", { bubbles: true })); }

  // Replace [start,end) with text, keep native undo where possible, then select [selStart,selEnd).
  function replaceRange(input, start, end, text, selStart, selEnd) {
    input.focus();
    input.setSelectionRange(start, end);
    let ok = false;
    try { ok = text === "" ? (start === end || document.execCommand("delete")) : document.execCommand("insertText", false, text); } catch (e) { ok = false; }
    if (!ok) input.setRangeText(text, start, end, "end");
    const a = selStart ?? start + text.length, b = selEnd ?? a;
    input.setSelectionRange(a, b);
    input._dqcCaret = [a, b];
    fire(input);
  }

  function trimmedSel(input) {
    const v = input.value;
    let s = input.selectionStart, e = input.selectionEnd;
    while (s < e && /\s/.test(v[s])) s++;
    while (e > s && /\s/.test(v[e - 1])) e--;
    return [v, s, e, v.slice(s, e)];
  }

  function wrap(input, pre, post, placeholder) {
    const [v, s, e, sel] = trimmedSel(input);
    // toggle off: markers just outside the selection
    if (sel && s >= pre.length && v.slice(s - pre.length, s) === pre && v.slice(e, e + post.length) === post) {
      replaceRange(input, s - pre.length, e + post.length, sel, s - pre.length, s - pre.length + sel.length);
      return;
    }
    // toggle off: markers inside the selection
    if (sel.length > pre.length + post.length && sel.startsWith(pre) && sel.endsWith(post)) {
      const inner = sel.slice(pre.length, sel.length - post.length);
      replaceRange(input, s, e, inner, s, s + inner.length);
      return;
    }
    const inner = sel || placeholder;
    replaceRange(input, s, e, pre + inner + post, s + pre.length, s + pre.length + inner.length);
  }

  function codeBlock(input) {
    const v = input.value, s = input.selectionStart, e = input.selectionEnd, sel = v.slice(s, e);
    if (/^```[\s\S]*```$/.test(sel) && sel.length >= 6) {
      const inner = sel.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "");
      replaceRange(input, s, e, inner, s, s + inner.length);
      return;
    }
    const before = s > 0 && v[s - 1] !== "\n" ? "\n" : "";
    const after = e < v.length && v[e] !== "\n" ? "\n" : "";
    const inner = sel || "code";
    const at = s + before.length + 4;
    replaceRange(input, s, e, before + "```\n" + inner + "\n```" + after, at, at + inner.length);
  }

  function link(input) {
    const [, s, e, sel] = trimmedSel(input);
    if (/^https?:\/\/\S+$/i.test(sel)) {
      replaceRange(input, s, e, `[${sel}](${sel})`, s + 1, s + 1 + sel.length);
      return;
    }
    const txt = sel || "link text";
    const t = `[${txt}](https://)`;
    if (sel) { const u = s + txt.length + 3; replaceRange(input, s, e, t, u, u + 8); }
    else replaceRange(input, s, e, t, s + 1, s + 1 + txt.length);
  }

  const LINE_RE = { bullet: /^\s*[-*•]\s+/, number: /^\s*\d+[.)]\s+/, quote: /^>\s?/ };
  function lines(input, type) {
    const v = input.value, s = input.selectionStart;
    let e = input.selectionEnd;
    if (e > s && v[e - 1] === "\n") e--;
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    let le = v.indexOf("\n", e);
    if (le < 0) le = v.length;
    const arr = v.slice(ls, le).split("\n");
    const re = LINE_RE[type];
    const nonEmpty = arr.filter((l) => l.trim());
    const all = nonEmpty.length > 0 && nonEmpty.every((l) => re.test(l));
    let n = 0;
    const out = arr.map((l) => {
      if (all) return l.replace(re, "");
      if (!l.trim() && arr.length > 1) return l;
      const base = type === "quote" ? l : l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "");
      n++;
      return (type === "bullet" ? "- " : type === "number" ? n + ". " : "> ") + base;
    });
    const t = out.join("\n");
    if (arr.length === 1) replaceRange(input, ls, le, t, ls + t.length, ls + t.length);
    else replaceRange(input, ls, le, t, ls, ls + t.length);
  }

  const FMT = {
    bold: (i) => wrap(i, "**", "**", "bold text"),
    italic: (i) => wrap(i, "_", "_", "italic text"),
    strike: (i) => wrap(i, "~~", "~~", "strikethrough"),
    code: (i) => wrap(i, "`", "`", "code"),
    block: codeBlock,
    link,
    bullet: (i) => lines(i, "bullet"),
    number: (i) => lines(i, "number"),
    quote: (i) => lines(i, "quote"),
  };

  /* ------------------------------------------------------------------ Aa: formatting bar */
  let fmtOn = false;
  try { fmtOn = localStorage.getItem(LS_FMT) === "1"; } catch (e) {}

  const SVG = (p) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const T = (x, y, s) => `<text x="${x}" y="${y}" font-size="5" font-family="sans-serif" fill="currentColor" stroke="none">${s}</text>`;
  const BTNS = [
    ["bold", "<b>B</b>", "Bold", MOD + "B"],
    ["italic", "<i>I</i>", "Italic", MOD + "I"],
    ["strike", "<s>S</s>", "Strikethrough", MOD + (IS_MAC ? "⇧X" : "Shift+X")],
    "|",
    ["code", SVG('<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/>'), "Code"],
    ["block", SVG('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M6.5 6 5 8l1.5 2M9.5 6 11 8l-1.5 2"/>'), "Code block"],
    ["link", SVG('<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7"/>'), "Link"],
    "|",
    ["bullet", SVG('<circle cx="3" cy="4" r=".9" fill="currentColor"/><circle cx="3" cy="8" r=".9" fill="currentColor"/><circle cx="3" cy="12" r=".9" fill="currentColor"/><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/>'), "Bulleted list"],
    ["number", SVG(T(1, 6, "1") + T(1, 10, "2") + T(1, 14, "3") + '<path d="M6.5 4h7M6.5 8h7M6.5 12h7"/>'), "Numbered list"],
    ["quote", SVG('<path d="M3 3v10M6.5 5h7M6.5 8h7M6.5 11h5"/>'), "Quote"],
  ];
  const BAR_HTML = BTNS.map((b) => b === "|" ? '<span class="dqc-sep" aria-hidden="true"></span>'
    : `<button type="button" class="dqc-fb" data-fmt="${esc(b[0])}" title="${esc(b[2] + (b[3] ? " (" + b[3] + ")" : ""))}" aria-label="${esc(b[2])}">${b[1]}</button>`).join("");

  function applyFmt(c) {
    if (!c) return;
    let bar = c.querySelector(".dqc-fmt");
    if (fmtOn && !bar) {
      bar = document.createElement("div");
      bar.className = "dqc-fmt";
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", "Formatting");
      bar.innerHTML = BAR_HTML;
      bar.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); }); // keep selection
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("[data-fmt]");
        if (!b) return;
        e.preventDefault();
        const i = inputOf(c);
        const f = FMT[b.dataset.fmt];
        if (i && !i.disabled && f) f(i);
      });
      c.insertBefore(bar, c.firstChild);
    } else if (!fmtOn && bar) bar.remove();
    const btn = c.querySelector('[data-tool="format"]');
    if (btn) { btn.classList.toggle("on", fmtOn); btn.setAttribute("aria-pressed", String(fmtOn)); }
  }

  DQ.tool("format", ({ input }) => {
    fmtOn = !fmtOn;
    try { localStorage.setItem(LS_FMT, fmtOn ? "1" : "0"); } catch (e) {}
    document.querySelectorAll(".composer").forEach(applyFmt);
    if (input) input.focus();
  });

  /* ------------------------------------------------------------------ Mic: dictation */
  let rec = null, recKind = null, interim = "";

  function speechCtor() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    try {
      const pp = document.permissionsPolicy || document.featurePolicy;
      if (pp && typeof pp.allowsFeature === "function" && !pp.allowsFeature("microphone")) return null;
    } catch (e) {}
    return SR;
  }

  function recUI() {
    document.querySelectorAll(".composer").forEach((c) => {
      const i = inputOf(c);
      const on = !!rec && !!i && kindOf(i) === recKind;
      const b = c.querySelector('[data-tool="mic"]');
      if (b) {
        b.classList.toggle("dqc-rec", on);
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
        b.title = on ? "Stop dictation" : "Dictate";
      }
      let bar = c.querySelector(".dqc-recbar");
      if (on && !bar) {
        bar = document.createElement("div");
        bar.className = "dqc-recbar";
        bar.setAttribute("role", "status");
        bar.innerHTML = '<span class="dqc-dot"></span><span class="dqc-rl">Recording…</span><span class="dqc-int"></span><button type="button" class="dqc-stop">Stop</button>';
        bar.querySelector(".dqc-stop").addEventListener("click", (e) => { e.preventDefault(); stopRec(); });
        c.insertBefore(bar, c.querySelector(".tb"));
      } else if (!on && bar) bar.remove();
      if (on && bar) bar.querySelector(".dqc-int").textContent = interim; // textContent: never HTML
    });
  }

  function insertDictation(kind, text) {
    const input = byKind(kind);
    text = String(text || "").trim();
    if (!input || input.disabled || !text) return;
    const v = input.value;
    let [s, e] = document.activeElement === input ? [input.selectionStart, input.selectionEnd] : (input._dqcCaret || [v.length, v.length]);
    s = Math.min(s, v.length); e = Math.min(Math.max(e, s), v.length);
    const pre = s > 0 && !/\s/.test(v[s - 1]) ? " " : "";
    const post = e < v.length && !/\s/.test(v[e]) ? " " : "";
    input.setRangeText(pre + text + post, s, e, "end");
    const c = s + pre.length + text.length;
    input.setSelectionRange(c, c);
    input._dqcCaret = [c, c];
    fire(input);
  }

  function stopRec() {
    const r = rec;
    rec = null; recKind = null; interim = "";
    if (r) { try { r.stop(); } catch (e) {} }
    recUI();
  }

  DQ.tool("mic", ({ input, kind }) => {
    if (rec) { const same = recKind === kind; stopRec(); if (same) return; }
    const SR = speechCtor();
    if (!SR) { toast(BLOCKED); return; }
    let r;
    try { r = new SR(); } catch (e) { toast(BLOCKED); return; }
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (ev) => {
      let fin = "", tmp = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) fin += res[0].transcript; else tmp += res[0].transcript;
      }
      if (fin.trim()) insertDictation(kind, fin);
      if (rec === r) { interim = tmp; recUI(); }
    };
    r.onerror = (ev) => {
      const er = ev && ev.error;
      if (["not-allowed", "service-not-allowed", "audio-capture"].includes(er)) toast(BLOCKED);
      else if (er === "no-speech") toast("Didn't hear anything. Try again.");
      else if (er && er !== "aborted") toast("Dictation stopped (" + er + ")");
      if (rec === r) stopRec();
    };
    r.onend = () => { if (rec === r) { rec = null; recKind = null; interim = ""; recUI(); } };
    rec = r; recKind = kind;
    try { r.start(); } catch (e) { rec = null; recKind = null; toast(BLOCKED); recUI(); return; }
    if (input) { input.focus(); input._dqcCaret = [input.selectionStart, input.selectionEnd]; }
    recUI();
  });

  /* ------------------------------------------------------------------ /: slash commands */
  const needsArg = (c) => /^</.test(c.args || "");
  const roomLabel = (r) => (r.kind === "dm" ? DQ.dmLabel(r) : "#" + r.name);

  function findRoom(q) {
    q = String(q || "").trim().replace(/^#/, "").toLowerCase();
    if (!q || !DQ.allRooms) return null;
    const rs = DQ.allRooms().map((r) => ({ r, keys: [String(r.name || "").toLowerCase(), r.kind === "dm" ? DQ.dmLabel(r).toLowerCase() : ""].filter(Boolean) }));
    const hit = rs.find((x) => x.keys.includes(q)) || rs.find((x) => x.keys.some((k) => k.startsWith(q))) || rs.find((x) => x.keys.some((k) => k.includes(q)));
    return hit ? hit.r : null;
  }

  function parseRemind(a) {
    const s = String(a || "").trim();
    const q = s.match(/^"([^"]+)"\s+([\s\S]+)$/);
    if (q) return { when: q[1].trim(), what: q[2].trim() };
    const T12 = "\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?";
    const pats = [
      /^in\s+(?:a|an|\d+(?:\.\d+)?)\s*(?:sec(?:ond)?s?|min(?:ute)?s?|h(?:ou)?rs?|hours?|days?|weeks?|months?)\b/i,
      new RegExp(`^(?:today|tonight|tomorrow|tmrw)(?:\\s+(?:at\\s+)?${T12})?(?=\\s)`, "i"),
      new RegExp(`^(?:every|next|this|on)\\s+[\\w-]+(?:\\s+at\\s+${T12})?(?=\\s)`, "i"),
      new RegExp(`^at\\s+${T12}(?:\\s+(?:today|tomorrow))?(?=\\s)`, "i"),
      /^\d{1,2}(?::\d{2})?\s*(?:am|pm)(?=\s)/i,
      /^\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?=\s)/,
    ];
    for (const p of pats) {
      const m = s.match(p);
      if (m) {
        const what = s.slice(m[0].length).trim().replace(/^(?:to|that|about|:|-|—)\s+/i, "");
        if (what) return { when: m[0].trim(), what };
      }
    }
    return null;
  }
  function remindText(a) {
    const p = parseRemind(a);
    return p ? `@${BOTNAME} set a reminder for me. When: ${p.when}. What: ${p.what}. Remind me here when it's due.`
      : `@${BOTNAME} set a reminder for me: ${a}. Remind me here when it's due.`;
  }

  async function markRead(ctx) {
    const id = DQ.S && DQ.S.room;
    if (!id) { toast("Open a channel first"); return false; }
    ctx.clear();
    const r = DQ.allRooms().find((x) => x.room_id === id);
    const label = r ? roomLabel(r) : "this channel";
    const items = new Map();
    ((r && r.unread_threads) || []).forEach((t) => items.set(t.thread_id, +t.latest || 0));
    try {
      const d = await DQ.api("/api/room/" + encodeURIComponent(id));
      (d.threads || []).forEach((t) => {
        const ev = +t.latest_event_id || 0;
        if (t.unread) items.set(t.thread_id, Math.max(items.get(t.thread_id) || 0, ev));
        if (ev) DQ.markSeen(t.thread_id, ev);
      });
    } catch (e) { /* fall back to what bootstrap knew */ }
    items.forEach((ev, tid) => { if (ev) DQ.markSeen(tid, ev); });
    const list = [...items].filter(([, ev]) => ev > 0).map(([thread_id, event_id]) => ({ thread_id, event_id }));
    if (list.length) await DQ.syncSeen(list);
    if (r) r.unread_threads = [];
    if (DQ.S.room === id) { DQ.S.newFrom = null; if (DQ.S.tab === "messages" && DQ.S.roomData) DQ.renderPane(true); }
    DQ.renderSide();
    toast(`Marked ${label} as read`, true);
  }

  const CMDS = [
    { name: "dreambot", args: "<ask>", desc: `Ask @${BOTNAME}`, text: (a) => `@${BOTNAME} ${a}` },
    { name: "files", args: "", desc: "Open the Files tab", run: (a, ctx) => {
        if (!DQ.S.room) { toast("Open a channel first"); return false; }
        ctx.clear(); DQ.showTab("files"); } },
    { name: "open", args: "<channel>", desc: "Jump to a channel", run: (a, ctx) => {
        const r = findRoom(a);
        if (!r) { toast(`No channel matches "${a}"`); return false; }
        ctx.clear(); DQ.openRoom(r.room_id); } },
    { name: "remind", args: "<when> <what>", desc: `Ask @${BOTNAME} to set a reminder`, text: remindText },
    { name: "markread", args: "", desc: "Mark this channel as read", run: (a, ctx) => markRead(ctx) },
    { name: "shrug", args: "[message]", desc: `Append ${SHRUG}`, text: (a) => (a ? a + " " : "") + SHRUG },
  ];

  function parse(text) {
    const m = String(text || "").match(/^\s*\/([a-z][a-z0-9_-]*)(?:[ \t]+([\s\S]*?))?\s*$/i);
    if (!m) return null;
    const def = CMDS.find((c) => c.name === m[1].toLowerCase());
    return def ? { def, arg: (m[2] || "").trim() } : null;
  }

  function clearInput(input) {
    input.value = "";
    input._dqcCaret = [0, 0];
    if (DQ.grow) DQ.grow(input);
    closeMenu();
  }

  // Client-side commands (and usage errors) are consumed here; text commands fall through to send:before.
  function handleSubmit(input, kind) {
    const c = parse(input.value);
    if (!c) return false;
    if (needsArg(c.def) && !c.arg) { toast(`Usage: /${c.def.name} ${c.def.args}`); return true; }
    if (!c.def.run) return false;
    closeMenu();
    try {
      const res = c.def.run(c.arg, { kind, input, clear: () => clearInput(input) });
      if (res && res.catch) res.catch((e) => toast(`/${c.def.name} failed: ${e.message || e}`));
    } catch (e) { toast(`/${c.def.name} failed: ${e.message || e}`); }
    return true;
  }

  /* menu */
  let menu = null, blurT = null;

  function cmdItems(q) {
    q = (q || "").toLowerCase();
    const a = CMDS.filter((c) => c.name.startsWith(q)), b = CMDS.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
    return a.concat(b).map((c) => ({ type: "cmd", c }));
  }
  function chanItems(q) {
    q = String(q || "").replace(/^#/, "").toLowerCase();
    if (!DQ.allRooms || !DQ.S || !DQ.S.boot) return [];
    const scored = [];
    DQ.allRooms().forEach((r) => {
      const keys = [String(r.name || "").toLowerCase(), r.kind === "dm" ? DQ.dmLabel(r).toLowerCase() : ""].filter(Boolean);
      const rank = !q ? 2 : keys.some((k) => k === q) ? 0 : keys.some((k) => k.startsWith(q)) ? 1 : keys.some((k) => k.includes(q)) ? 2 : -1;
      if (rank >= 0) scored.push({ rank, r });
    });
    scored.sort((x, y) => x.rank - y.rank || (x.r.kind === "dm") - (y.r.kind === "dm") || String(x.r.name).localeCompare(String(y.r.name)));
    return scored.slice(0, 8).map(({ r }) => ({ type: "chan", r }));
  }

  function closeMenu() {
    if (menu && menu.el) menu.el.remove();
    menu = null;
  }

  function openMenu(input, kind, mode, items, picker) {
    clearTimeout(blurT);
    const key = items.map((i) => (i.c ? i.c.name : i.r.room_id)).join(",");
    const keepIdx = menu && menu.input === input && menu.mode === mode && menu.key === key;
    const idx = keepIdx ? menu.idx : 0;
    if (menu && menu.input !== input) closeMenu();
    const c = input.closest(".composer");
    if (!c) return;
    let el = c.querySelector(".dqc-menu");
    if (!el) {
      el = document.createElement("div");
      el.className = "dqc-menu";
      el.setAttribute("role", "listbox");
      el.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the textarea
      el.addEventListener("click", (e) => {
        const it = e.target.closest("[data-i]");
        if (!it || !menu) return;
        menu.idx = +it.dataset.i;
        choose(false);
      });
      el.addEventListener("mousemove", (e) => {
        const it = e.target.closest("[data-i]");
        if (it && menu && menu.idx !== +it.dataset.i) { menu.idx = +it.dataset.i; paint(); }
      });
      c.appendChild(el);
    }
    menu = { input, kind, mode, items, idx, key, el, picker: !!picker };
    paint();
  }

  function paint() {
    if (!menu) return;
    const head = menu.mode === "chan" ? "Jump to a channel" : "Shortcuts";
    menu.el.innerHTML = `<div class="dqc-hd">${esc(head)}</div>` + menu.items.map((it, i) => {
      const cls = "dqc-it" + (i === menu.idx ? " sel" : "");
      if (it.type === "chan") {
        const r = it.r, sub = r.kind === "dm" ? "Direct message" : r.visibility === "private" ? "Private channel" : "Channel";
        return `<div class="${cls}" role="option" aria-selected="${i === menu.idx}" data-i="${i}"><span class="dqc-nm">${esc(roomLabel(r))}</span><span class="dqc-ds">${esc(sub)}</span></div>`;
      }
      return `<div class="${cls}" role="option" aria-selected="${i === menu.idx}" data-i="${i}"><span class="dqc-nm">/${esc(it.c.name)}</span><span class="dqc-ar">${esc(it.c.args)}</span><span class="dqc-ds">${esc(it.c.desc)}</span></div>`;
    }).join("");
    const sel = menu.el.querySelector(".dqc-it.sel");
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
  }

  function updateMenu(input, kind, picker) {
    if (!input || input.disabled || !input.isConnected) { closeMenu(); return; }
    if (picker) { openMenu(input, kind, "cmd", cmdItems(""), true); return; }
    const v = input.value, caret = input.selectionStart ?? v.length, head = v.slice(0, caret);
    if (head.includes("\n")) { closeMenu(); return; }
    let m = head.match(/^\/([a-z0-9_-]*)$/i);
    if (m) { const items = cmdItems(m[1]); if (items.length) openMenu(input, kind, "cmd", items); else closeMenu(); return; }
    m = head.match(/^\/open[ \t]+#?(\S*)$/i);
    if (m) { const items = chanItems(m[1]); if (items.length) openMenu(input, kind, "chan", items); else closeMenu(); return; }
    closeMenu();
  }

  // Returns "submit" when the caller should run the command / send the message.
  function choose(viaEnter) {
    if (!menu) return "done";
    const it = menu.items[menu.idx], input = menu.input, kind = menu.kind;
    if (!it) return "done";
    if (it.type === "chan") {
      closeMenu();
      clearInput(input);
      DQ.openRoom(it.r.room_id);
      return "done";
    }
    const c = it.c, v = input.value, tok = (v.match(/^\/\S*/) || [""])[0];
    if (viaEnter && !menu.picker && tok.toLowerCase() === "/" + c.name && !needsArg(c)) { closeMenu(); return "submit"; }
    let rest = v.startsWith("/") ? v.slice(tok.length) : v;
    rest = rest.replace(/^[ \t]+/, "");
    const head = "/" + c.name + " ";
    closeMenu();
    replaceRange(input, 0, v.length, head + rest, head.length, head.length);
    updateMenu(input, kind); // e.g. "/open " shows channels next
    return "done";
  }

  function bind(input) {
    if (!input || input._dqcBound) return;
    input._dqcBound = 1;
    const track = () => { input._dqcCaret = [input.selectionStart, input.selectionEnd]; };
    input.addEventListener("input", () => { track(); updateMenu(input, kindOf(input)); });
    input.addEventListener("click", () => { track(); if (!(menu && menu.picker)) updateMenu(input, kindOf(input)); });
    input.addEventListener("keyup", (e) => { track(); if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateMenu(input, kindOf(input)); });
    input.addEventListener("select", track);
    input.addEventListener("blur", () => {
      clearTimeout(blurT);
      blurT = setTimeout(() => { if (menu && menu.input === input && document.activeElement !== input) closeMenu(); }, 150);
    });
  }

  DQ.tool("slash", ({ input, kind }) => {
    if (!input || input.disabled) return;
    if (menu && menu.input === input) { closeMenu(); input.focus(); return; }
    input.focus();
    const v = input.value;
    if (!v.trim()) { replaceRange(input, 0, v.length, "/", 1, 1); return; } // input event opens the menu
    const tok = (v.match(/^\/\S*/) || [""])[0];
    if (tok && !/\s/.test(v.slice(tok.length, tok.length + 1) || "x")) { input.setSelectionRange(tok.length, tok.length); updateMenu(input, kind); return; }
    updateMenu(input, kind, true); // picker: choosing a command puts it in front of the existing text
  });

  /* ------------------------------------------------------------------ hooks */
  DQ.on("composer:key", (e, kind) => {
    const input = e.target;
    if (!input || input.tagName !== "TEXTAREA") return false;
    if (menu && menu.input === input && menu.items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = menu.items.length;
        menu.idx = (menu.idx + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        paint();
        return true;
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.isComposing) || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        if (choose(e.key === "Enter") !== "submit") return true;
        return handleSubmit(input, kind); // false → core sends (text commands are rewritten in send:before)
      }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); return true; }
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = (e.code || "").startsWith("Key") ? e.code.slice(3).toLowerCase() : String(e.key || "").toLowerCase();
      const f = k === "b" && !e.shiftKey ? "bold" : k === "i" && !e.shiftKey ? "italic" : k === "x" && e.shiftKey ? "strike" : null;
      if (f) { e.preventDefault(); FMT[f](input); return true; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && handleSubmit(input, kind)) { e.preventDefault(); return true; }
    return false;
  });

  // The send button has an inline handler in core; intercept client-side commands before it runs.
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".composer .snd");
    if (!b) return;
    const input = inputOf(b.closest(".composer"));
    if (input && !input.disabled && handleSubmit(input, kindOf(input))) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  DQ.on("send:before", (p) => {
    if (rec && recKind === p.kind) stopRec();
    const c = parse(p.text);
    if (c && c.def.text && (c.arg || !needsArg(c.def))) p.text = c.def.text(c.arg);
    return p;
  });

  DQ.on("composer:mount", (m) => {
    if (!m || !m.input) return;
    applyFmt(m.composer || m.input.closest(".composer"));
    bind(m.input);
    if (menu && !menu.input.isConnected) menu = null;
    recUI();
    // core restores the draft and focus right after this event
    setTimeout(() => { if (document.activeElement === m.input) updateMenu(m.input, m.kind); }, 0);
  });

  function initExisting() { document.querySelectorAll(".composer").forEach((c) => { applyFmt(c); bind(inputOf(c)); }); recUI(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initExisting); else initExisting();

  // Small public surface so other modules can add commands: DQ.compose.command({name,args,desc,text|run})
  DQ.compose = {
    commands: CMDS,
    command(def) { if (def && /^[a-z][a-z0-9_-]*$/.test(def.name || "") && !CMDS.some((c) => c.name === def.name)) CMDS.push(def); },
    format: (input, kind) => FMT[kind] && FMT[kind](input),
    parseRemind,
    stopDictation: stopRec,
  };
})();