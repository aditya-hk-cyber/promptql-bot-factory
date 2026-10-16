/* DreamQL Workspace module: @ Mention someone (mention).
   - "@" toolbar button or typing "@" opens an autocomplete (members, user groups, @DreamBot).
   - Picked names become chip-like tokens; on send:before each picked token is rewritten to
     <user_mention id="..." /> or <user_group_mention id="..." />. @DreamBot stays text
     (the server turns it into the bot mention). Security: every data string goes through
     DQ.esc(), no inline handlers, ids are validated as UUIDs before they reach a tag. */
(() => {
  const DQ = window.DQ;
  if (!DQ) return;
  const BOT = "DreamBot";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const WORD = "\\p{L}\\p{N}_";
  const toks = { room: new Map(), thread: new Map() }; // "Display Name" -> {id,type}
  const mounted = new Set();
  let groups = null, groupsP = null, pop = null, lastRoom = null;

  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const kindOf = input => (input && input.id === "tin" ? "thread" : "room");

  function loadGroups() {
    if (groupsP) return groupsP;
    groupsP = DQ.api("/api/groups")
      .then(j => { groups = (j.groups || []).filter(g => g && UUID.test(g.id) && g.name); })
      .catch(e => { groups = []; console.warn("mention: groups", e); })
      .then(() => { if (pop) update(pop.input); });
    return groupsP;
  }

  /* ---------- candidates ---------- */
  function candidates(q) {
    q = (q || "").toLowerCase();
    const boot = (DQ.S && DQ.S.boot) || {};
    const me = boot.me || {};
    const bot = [{ type: "bot", name: BOT, sub: "bring the bot in" }];
    const users = (boot.members || []).filter(m => m && m.name && UUID.test(m.id))
      .map(m => ({ type: "user", id: m.id, name: m.name, sub: m.id === me.id ? "you" : "" }));
    const grps = (groups || []).map(g => ({ type: "group", id: g.id, name: g.name,
      sub: (g.count != null ? g.count + " members · " : "") + "group" }));
    if (!q) return bot.concat(users.slice(0, 5), grps.slice(0, 3));
    const score = n => {
      n = n.toLowerCase();
      if (n.startsWith(q)) return 3;
      if (n.split(/[\s._()-]+/).some(w => w && w.startsWith(q))) return 2;
      return n.includes(q) ? 1 : 0;
    };
    return bot.concat(users, grps).map(c => [score(c.name), c]).filter(x => x[0] > 0)
      .sort((a, b) => b[0] - a[0]).slice(0, 8).map(x => x[1]);
  }

  /* ---------- trigger detection ---------- */
  function trigger(input) {
    const pos = input.selectionStart;
    if (pos == null || pos !== input.selectionEnd) return null;
    const before = input.value.slice(0, pos);
    const at = before.lastIndexOf("@");
    if (at < 0 || (at > 0 && !/[\s(]/.test(before[at - 1]))) return null;
    const q = before.slice(at + 1);
    if (/[\n@]/.test(q) || q.length > 40 || /^\s/.test(q) || /\s\s/.test(q)) return null;
    // caret sits right after a finished token: it's a chip, not a query
    if (q === BOT || toks[kindOf(input)].has(q)) return null;
    return { start: at, q };
  }

  /* ---------- popup ---------- */
  function close() {
    if (pop && pop.el) { pop.el.classList.remove("open"); pop.el.innerHTML = ""; }
    pop = null;
  }
  function popupEl(composer) {
    let el = composer.querySelector(".dqm-pop");
    if (!el) {
      el = document.createElement("div");
      el.className = "dqm-pop";
      el.setAttribute("role", "listbox");
      el.addEventListener("mousedown", e => {
        e.preventDefault();
        const it = e.target.closest(".dqm-it");
        if (it && pop) pick(pop.items[+it.dataset.i]);
      });
      el.addEventListener("mousemove", e => {
        const it = e.target.closest(".dqm-it");
        if (it && pop && +it.dataset.i !== pop.sel) { pop.sel = +it.dataset.i; render(); }
      });
      composer.appendChild(el);
    }
    return el;
  }
  function render() {
    if (!pop) return;
    const rows = pop.items.map((c, i) =>
      `<div class="dqm-it${i === pop.sel ? " on" : ""}" role="option" data-i="${i}">` +
      (c.type === "group" ? `<span class="dqm-g">@</span>` : DQ.face(c.name, "face dqm-f")) +
      `<span class="dqm-n">${DQ.esc(c.name)}</span><span class="dqm-s">${DQ.esc(c.sub || "")}</span></div>`).join("");
    pop.el.innerHTML = `<div class="dqm-h">People, groups and ${DQ.esc(BOT)}</div>` + rows;
    pop.el.classList.add("open");
    const on = pop.el.querySelector(".dqm-it.on");
    if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
  }
  function update(input) {
    if (!input || input.disabled || document.activeElement !== input) { if (pop && pop.input === input) close(); return; }
    const t = trigger(input);
    const items = t ? candidates(t.q) : [];
    if (!t || !items.length) { if (pop && pop.input === input) close(); return; }
    const composer = input.closest(".composer");
    if (pop && pop.input !== input) close();
    const prevSel = pop && pop.q === t.q ? pop.sel : 0;
    pop = { input, kind: kindOf(input), start: t.start, q: t.q, items, sel: Math.min(prevSel, items.length - 1), el: popupEl(composer) };
    render();
  }
  function pick(c) {
    if (!pop || !c) return;
    const { input, kind, start } = pop;
    const pos = input.selectionStart, v = input.value, ins = "@" + c.name + " ";
    input.value = v.slice(0, start) + ins + v.slice(pos).replace(/^ /, "");
    const caret = start + ins.length;
    input.setSelectionRange(caret, caret);
    if (c.type !== "bot") toks[kind].set(c.name, { id: c.id, type: c.type });
    close();
    DQ.grow(input);
    paint(input);
    input.focus();
  }

  /* ---------- chip-like tokens (backdrop overlay behind the transparent textarea) ---------- */
  function tokenRe(names, flags) {
    return new RegExp(`(^|[^${WORD}@])(@(?:${names.map(reEsc).join("|")}))(?![${WORD}])`, flags);
  }
  function paint(input) {
    const ov = input._dqmOv;
    if (!ov) return;
    input._dqmLast = input.value;
    const names = [...toks[kindOf(input)].keys()].concat(BOT).sort((a, b) => b.length - a.length);
    let html = DQ.esc(input.value);
    html = html.replace(tokenRe(names.map(DQ.esc), "gu"), (_, pre, tok) =>
      `${pre}<mark class="dqm-chip${tok === "@" + BOT ? " bot" : ""}">${tok}</mark>`);
    ov.innerHTML = html + "\n";
    ov.scrollTop = input.scrollTop;
  }
  function attachOverlay(input) {
    if (input._dqmOv) return;
    const wrap = document.createElement("div");
    wrap.className = "dqm-wrap";
    const ov = document.createElement("div");
    ov.className = "dqm-ov";
    ov.setAttribute("aria-hidden", "true");
    const cs = getComputedStyle(input);
    ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight",
      "paddingBottom", "paddingLeft", "tabSize"].forEach(k => { ov.style[k] = cs[k]; });
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(ov);
    wrap.appendChild(input);
    input._dqmOv = ov;
  }

  /* ---------- token-aware Backspace ---------- */
  function deleteToken(input) {
    const pos = input.selectionStart;
    if (pos == null || pos !== input.selectionEnd) return false;
    const before = input.value.slice(0, pos);
    const names = [...toks[kindOf(input)].keys()].concat(BOT).sort((a, b) => b.length - a.length);
    for (const n of names) {
      const t = "@" + n, s = pos - t.length;
      if (s >= 0 && before.endsWith(t) && (s === 0 || /[^\p{L}\p{N}_@]/u.test(before[s - 1]))) {
        input.value = before.slice(0, s) + input.value.slice(pos);
        input.setSelectionRange(s, s);
        DQ.grow(input); paint(input);
        return true;
      }
    }
    return false;
  }

  /* ---------- rewrite on send ---------- */
  function rewrite(text, map) {
    const names = [...map.keys()].sort((a, b) => b.length - a.length);
    for (const n of names) {
      const t = map.get(n);
      if (!t || !UUID.test(t.id)) continue;
      const tag = t.type === "group" ? `<user_group_mention id="${t.id}" />` : `<user_mention id="${t.id}" />`;
      text = text.replace(tokenRe([n], "gu"), (_, pre) => pre + tag);
    }
    return text;
  }

  /* ---------- bus wiring ---------- */
  DQ.on("composer:mount", ({ input }) => {
    if (!input) return;
    attachOverlay(input);
    mounted.add(input);
    if (!input.dataset.dqm) {
      input.dataset.dqm = "1";
      input.addEventListener("input", () => { paint(input); update(input); });
      input.addEventListener("click", () => update(input));
      input.addEventListener("scroll", () => { if (input._dqmOv) input._dqmOv.scrollTop = input.scrollTop; });
      input.addEventListener("blur", () => setTimeout(() => { if (pop && pop.input === input && document.activeElement !== input) close(); }, 120));
    }
    requestAnimationFrame(() => paint(input)); // core restores drafts after mount
    loadGroups();
  });

  DQ.on("composer:key", (e, kind) => {
    const input = e.target;
    if (e.isComposing) return false;
    if (e.key === "Backspace" && !e.altKey && !e.ctrlKey && !e.metaKey && deleteToken(input)) {
      e.preventDefault(); update(input); return true;
    }
    if (pop && pop.input === input) {
      const n = pop.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        pop.sel = (pop.sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n; render();
      } else if (e.key === "Enter" || e.key === "Tab") {
        pick(pop.items[pop.sel]);
      } else if (e.key === "Escape") {
        close(); e.stopPropagation(); // don't let the core close the thread panel
      } else return false;
      e.preventDefault();
      return true;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") setTimeout(() => update(input), 0);
    return false;
  });

  DQ.tool("mention", ({ input }) => {
    if (!input || input.disabled) return;
    input.focus();
    const v = input.value;
    const s = input.selectionStart ?? v.length, e = input.selectionEnd ?? s;
    const pre = s > 0 && !/[\s(]/.test(v[s - 1]) ? " " : "";
    input.value = v.slice(0, s) + pre + "@" + v.slice(e);
    const c = s + pre.length + 1;
    input.setSelectionRange(c, c);
    DQ.grow(input); paint(input); update(input);
  });

  DQ.on("send:before", async p => {
    const map = toks[p.kind];
    if (p.text && map && map.size) p.text = rewrite(p.text, map);
    return p;
  });
  DQ.on("send:after", ({ kind }) => {
    close();
    if (toks[kind]) toks[kind].clear();
    mounted.forEach(i => { if (i.isConnected && kindOf(i) === kind) paint(i); });
  });
  DQ.on("nav:open", ({ type, id, refresh }) => {
    if (type === "thread") { toks.thread.clear(); close(); }
    else if (type === "room" && id !== lastRoom && !refresh) { toks.room.clear(); close(); lastRoom = id; }
    else if (type === "room") lastRoom = id;
  });
  DQ.on("boot:loaded", () => loadGroups());

  // Other modules (emoji, format, slash) may change the text without an input event; keep chips in sync.
  setInterval(() => {
    mounted.forEach(i => {
      if (!i.isConnected) { mounted.delete(i); return; }
      if (i.value !== i._dqmLast) paint(i);
    });
  }, 300);

  DQ.mention = { rewrite: (text, kind) => rewrite(text, toks[kind || "room"]), tokens: toks, candidates };
})();