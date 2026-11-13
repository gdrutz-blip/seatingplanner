(function () {
  'use strict';
  const { hasSeat, endCell, isHoriz, seatId, listSeats, solve, shuffle } = window.SeatSolver;

  const KEY = 'seatingplanner.v1';
  const ROOM_W = 32, ROOM_H = 20, SW = 3, SH = 2;
  const $ = id => document.getElementById(id);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clone = o => JSON.parse(JSON.stringify(o));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  function fill(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false)); }

  /* ---------------- state ---------------- */
  function defaultLayout() { return { tables: [] }; }
  function newClass(name) {
    return { id: uid(), name, students: [], layout: defaultLayout(), assignment: {}, rules: [], across: false, versions: [] };
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.classes) && s.classes.length) return s;
    } catch (e) { /* fall through */ }
    const c = newClass('My class');
    return { classes: [c], current: c.id };
  }
  let state = loadState();
  const ui = { tab: 'seating', flip: false, sel: null, selTable: null, closing: false, printIds: null, printFlip: false };
  const BKEY = 'seatingplanner.lastBackup', PKEY = 'seatingplanner.prefs';
  const prefs = Object.assign({ style: 'random', speed: 'normal' }, (() => { try { return JSON.parse(localStorage.getItem(PKEY)) || {}; } catch (e) { return {}; } })());

  // Every save() that changes something becomes one undo step.
  let savedJson = JSON.stringify(state);
  const undoStack = [], redoStack = [];
  function persist() {
    try { localStorage.setItem(KEY, savedJson); }
    catch (e) { alert('Could not save to this browser\'s storage. Use Backup to keep your work.'); }
  }
  function save() {
    const j = JSON.stringify(state);
    if (j !== savedJson) {
      undoStack.push(savedJson); if (undoStack.length > 80) undoStack.shift();
      redoStack.length = 0; savedJson = j;
    }
    persist();
  }
  function timeTravel(from, to) {
    if (!from.length) return;
    to.push(savedJson); savedJson = from.pop();
    state = JSON.parse(savedJson);
    ui.sel = ui.selTable = null;
    persist(); render();
  }
  const undo = () => timeTravel(undoStack, redoStack), redo = () => timeTravel(redoStack, undoStack);
  const cur = () => state.classes.find(c => c.id === state.current) || state.classes[0];
  const studentName = (cls, id) => (cls.students.find(s => s.id === id) || {}).name || '';
  const seatOf = (cls, sid) => Object.keys(cls.assignment).find(k => cls.assignment[k] === sid);
  const tableById = (cls, id) => cls.layout.tables.find(t => t.id === id);
  const itemsOf = cls => cls.layout.items || (cls.layout.items = []);
  const closedOf = cls => cls.layout.closed || (cls.layout.closed = []);
  const openSeats = cls => listSeats(cls.layout).filter(s => !closedOf(cls).includes(s.id));
  const dims = o => o.cols ? { w: o.cols * SW, h: o.rows * SH } : { w: o.w, h: o.h };
  const tableName = t => 'Table ' + t.num;

  /* Drop seat assignments and rules that point at things that no longer exist. */
  function prune(cls) {
    const all = new Set(listSeats(cls.layout).map(s => s.id));
    cls.layout.closed = closedOf(cls).filter(id => all.has(id));
    const seats = new Set(openSeats(cls).map(s => s.id));
    const studs = new Set(cls.students.map(s => s.id));
    const tabs = new Set(cls.layout.tables.map(t => t.id));
    const seen = new Set();
    for (const [seat, sid] of Object.entries(cls.assignment)) {
      if (!seats.has(seat) || !studs.has(sid) || seen.has(sid)) delete cls.assignment[seat];
      else seen.add(sid);
    }
    cls.rules = cls.rules.filter(r => {
      if (!studs.has(r.a)) return false;
      if (r.type === 'tables') { r.tables = r.tables.filter(t => tabs.has(t)); return r.tables.length > 0; }
      if (r.type === 'seat') return seats.has(r.seat);
      r.others = r.others.filter(o => studs.has(o));
      return r.others.length > 0;
    });
  }

  function snapshot(cls, name, auto) {
    cls.versions.unshift({ id: uid(), name, ts: Date.now(), auto: !!auto, layout: clone(cls.layout), assignment: clone(cls.assignment) });
    const autos = cls.versions.filter(v => v.auto);
    if (autos.length > 20) cls.versions = cls.versions.filter(v => !v.auto || autos.indexOf(v) < 20);
  }

  /* ---------------- room rendering ---------------- */
  function bounds(layout, crop) {
    const things = layout.tables.concat(layout.items || []);
    if (!crop || !things.length) return { x: 0, y: 0, w: ROOM_W, h: ROOM_H };
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const t of things) {
      const d = dims(t);
      x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y);
      x1 = Math.max(x1, t.x + d.w); y1 = Math.max(y1, t.y + d.h);
    }
    return { x: x0 - .5, y: y0 - 1.1, w: x1 - x0 + 1, h: y1 - y0 + 2.2 };
  }
  function nameScale(name) {
    const words = name.split(/\s+/);
    const longest = Math.max(...words.map(w => w.length), 1);
    return Math.min(.62, 2.6 / (.6 * longest), 1.7 / (1.1 * Math.min(words.length, 3)));
  }
  const U = n => `calc(var(--u) * ${n})`;

  /* o: { flip, mode: 'seat'|'layout'|'view', crop, assignment } */
  function renderRoom(cls, o) {
    const b = bounds(cls.layout, o.crop);
    const asg = o.assignment || cls.assignment;
    const fx = (x, w) => o.flip ? b.w - (x - b.x) - w : x - b.x;
    const fy = (y, hh) => o.flip ? b.h - (y - b.y) - hh : y - b.y;
    const room = h('div', { class: 'room mode-' + o.mode });
    room.style.width = U(b.w); room.style.height = U(b.h);
    const closed = new Set(cls.layout.closed || []);
    for (const it of cls.layout.items || []) {
      const el = h('div', {
        class: 'item kind-' + it.kind + (it.h > it.w ? ' tall' : '') + (o.mode === 'layout' && ui.selTable === it.id ? ' sel' : ''), 'data-item': it.id,
      }, h('span', {}, it.text));
      Object.assign(el.style, { left: U(fx(it.x, it.w)), top: U(fy(it.y, it.h)), width: U(it.w), height: U(it.h) });
      room.append(el);
    }
    for (const t of cls.layout.tables) {
      const w = t.cols * SW, hh = t.rows * SH;
      const tx = fx(t.x, w), ty = fy(t.y, hh);
      const e = endCell(t), horiz = isHoriz(t);
      const tEl = h('div', { class: 'table' + (e ? ' hasend' : '') + (o.mode === 'layout' && ui.selTable === t.id ? ' sel' : ''), 'data-table': t.id });
      Object.assign(tEl.style, { left: U(tx), top: U(ty), width: U(w), height: U(hh) });
      // Where the desk on the end sits: centred across the end of the table.
      const ex = e && (horiz ? t.x + e.c * SW : t.x + (w - SW) / 2);
      const ey = e && (horiz ? t.y + (hh - SH) / 2 : t.y + e.r * SH);
      if (e) {
        const gx = t.x + (horiz && t.end === 'first' ? SW : 0), gy = t.y + (!horiz && t.end === 'first' ? SH : 0);
        const gw = horiz ? w - SW : w, gh = horiz ? hh : hh - SH;
        for (const [x, y, ww, h2] of [[gx, gy, gw, gh], [ex, ey, SW, SH]]) {
          const part = h('div', { class: 'tpart' });
          Object.assign(part.style, { left: U(fx(x, ww) - tx), top: U(fy(y, h2) - ty), width: U(ww), height: U(h2) });
          tEl.append(part);
        }
      }
      const lab = h('div', { class: 'tlabel' }, tableName(t));
      Object.assign(lab.style, { left: U(tx), top: U(ty - .9), width: U(w) });
      room.append(tEl, lab);
      for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
        if (!hasSeat(t, r, c)) continue;
        const id = seatId(t, r, c);
        const shut = closed.has(id);
        const sid = shut ? null : asg[id];
        const name = sid ? studentName(cls, sid) : '';
        const inner = h('div', {}, shut ? '\u2715' : name);
        if (name) inner.style.fontSize = U(nameScale(name).toFixed(3));
        const sEl = h('div', {
          class: 'seat' + (shut ? ' closed' : name ? '' : ' empty') + (ui.sel && ui.sel === sid && o.mode === 'seat' ? ' sel' : ''),
          'data-seat': id, draggable: o.mode === 'seat' && !!sid ? 'true' : null,
        }, inner);
        const isEnd = e && e.r === r && e.c === c;
        const sx = isEnd ? ex : t.x + c * SW, sy = isEnd ? ey : t.y + r * SH;
        Object.assign(sEl.style, { left: U(fx(sx, SW)), top: U(fy(sy, SH)), width: U(SW), height: U(SH) });
        room.append(sEl);
      }
    }
    const front = h('div', { class: 'front' }, 'FRONT');
    const wrap = h('div', { class: 'roomwrap' }, o.flip ? [front, room] : [room, front]);
    wrap._b = b;
    return wrap;
  }
  function fit(wrap, availW, availH) {
    const u = Math.max(8, Math.min(availW / wrap._b.w, availH / (wrap._b.h + 1.7)));
    wrap.style.setProperty('--u', u.toFixed(2) + 'px');
    return u;
  }

  /* ---------------- top bar ---------------- */
  function renderHeader() {
    const sel = $('classSelect');
    sel.replaceChildren(...state.classes.map(c => h('option', { value: c.id, selected: c.id === cur().id }, c.name)));
    document.querySelectorAll('nav button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
    $('chkFlip').checked = ui.flip;
    $('btnUndo').disabled = !undoStack.length; $('btnRedo').disabled = !redoStack.length;
    const last = +localStorage.getItem(BKEY) || 0, days = Math.floor((Date.now() - last) / 864e5);
    const hasData = state.classes.some(c => c.students.length);
    const note = $('backupNote');
    note.textContent = !last ? (hasData ? 'Not backed up yet' : '') : days < 1 ? 'Backed up today' : days === 1 ? 'Backed up yesterday' : `Backed up ${days} days ago`;
    note.classList.toggle('stale', hasData && (!last || days >= 14));
  }
  $('btnUndo').onclick = undo; $('btnRedo').onclick = redo;
  function switchClass(id) { state.current = id; ui.sel = ui.selTable = null; save(); render(); }

  $('classSelect').onchange = e => switchClass(e.target.value);
  $('btnNewClass').onclick = () => {
    const name = prompt('Name for the new class:');
    if (!name || !name.trim()) return;
    const c = newClass(name.trim());
    if (confirm('Copy the desk layout from "' + cur().name + '"?\n(Cancel = start with an empty room)')) {
      c.layout = clone(cur().layout);
    }
    state.classes.push(c); switchClass(c.id);
  };
  $('btnRenameClass').onclick = () => {
    const name = prompt('Class name:', cur().name);
    if (name && name.trim()) { cur().name = name.trim(); save(); render(); }
  };
  $('btnDupClass').onclick = () => {
    const c = clone(cur()); c.id = uid(); c.name += ' (copy)';
    state.classes.push(c); switchClass(c.id);
  };
  $('btnDelClass').onclick = () => {
    if (!confirm('Delete "' + cur().name + '" and all its saved seating plans? This cannot be undone.')) return;
    state.classes = state.classes.filter(c => c !== cur());
    if (!state.classes.length) state.classes.push(newClass('My class'));
    switchClass(state.classes[0].id);
  };
  $('btnBackup').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'seating-backup-' + new Date().toISOString().slice(0, 10) + '.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    localStorage.setItem(BKEY, Date.now()); renderHeader();
  };
  $('btnRestore').onclick = () => $('fileRestore').click();
  $('fileRestore').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!s || !Array.isArray(s.classes) || !s.classes.length) throw new Error('bad file');
      if (!confirm('Replace everything in this browser with the ' + s.classes.length + ' class(es) from the backup?')) return;
      state = s; state.classes.forEach(prune); localStorage.setItem(BKEY, Date.now()); save(); render();
    } catch (err) { alert('That file is not a seating planner backup.'); }
  };
  document.querySelectorAll('nav button[data-tab]').forEach(b => {
    b.onclick = () => { ui.tab = b.dataset.tab; ui.sel = null; ui.closing = false; render(); };
  });
  $('chkFlip').onchange = e => { ui.flip = e.target.checked; render(); };

  /* ---------------- seating tab ---------------- */
  function place(cls, sid, seat) {
    const from = seatOf(cls, sid), occ = cls.assignment[seat];
    if (from === seat) return;
    if (from) delete cls.assignment[from];
    if (occ && from) cls.assignment[from] = occ;
    cls.assignment[seat] = sid;
  }
  function unseat(cls, sid) { const s = seatOf(cls, sid); if (s) delete cls.assignment[s]; }

  function renderSeating(cls) {
    const seated = new Set(Object.values(cls.assignment));
    const unseated = cls.students.filter(s => !seated.has(s.id));
    const done = () => { ui.sel = null; save(); render(); };

    const chips = h('div', {
      class: 'chips',
      onclick: e => { if (e.target === chips && ui.sel) { unseat(cls, ui.sel); done(); } },
      ondragover: e => { e.preventDefault(); chips.classList.add('over'); },
      ondragleave: () => chips.classList.remove('over'),
      ondrop: e => { e.preventDefault(); const sid = e.dataTransfer.getData('text/plain'); if (sid) { unseat(cls, sid); done(); } },
    }, unseated.map(s => h('span', {
      class: 'chip' + (ui.sel === s.id ? ' sel' : ''), draggable: 'true',
      onclick: () => { ui.sel = ui.sel === s.id ? null : s.id; render(); },
      ondragstart: e => { e.dataTransfer.setData('text/plain', s.id); },
    }, s.name)));

    const nSeats = openSeats(cls).length;
    const shut = closedOf(cls);
    fill($('sidebar'), 
      h('button', { class: 'primary', onclick: () => doShuffle(cls) }, 'Shuffle seats'),
      h('button', { onclick: () => { if (confirm('Remove everyone from their seats?')) { cls.assignment = {}; done(); } } }, 'Clear all seats'),
      h('button', {
        onclick: () => {
          const name = prompt('Name for this saved plan:', new Date().toLocaleDateString());
          if (name) { snapshot(cls, name.trim() || 'Saved plan'); save(); alert('Saved. Find it under History.'); }
        },
      }, 'Save this plan…'),
      h('button', { class: ui.closing ? 'on' : '', onclick: () => { ui.closing = !ui.closing; ui.sel = null; render(); } },
        ui.closing ? 'Done closing desks' : 'Close or reopen desks…'),
      ui.closing && h('p', { class: 'hint' }, 'Click a desk to close it, or a closed desk to reopen it. Closed desks are never used.'),
      h('p', { class: 'hint' }, `${cls.students.length} students, ${nSeats} seats` + (shut.length ? `, ${shut.length} closed.` : '.')),
      h('h3', {}, `Not seated (${unseated.length})`), chips,
      h('p', { class: 'hint' }, 'Drag a name onto a seat, or click a name and then a seat. Drop one student on another to swap them.'),
    );

    const wrap = renderRoom(cls, { flip: ui.flip, mode: 'seat' });
    wrap.querySelectorAll('.seat').forEach(el => {
      const seat = el.dataset.seat;
      el.onclick = () => {
        const occ = cls.assignment[seat];
        if (ui.closing) {
          const i = shut.indexOf(seat);
          if (i >= 0) shut.splice(i, 1); else { shut.push(seat); delete cls.assignment[seat]; }
          prune(cls); return done();
        }
        if (shut.includes(seat)) return;
        if (ui.sel) { place(cls, ui.sel, seat); done(); }
        else if (occ) { ui.sel = occ; render(); }
      };
      el.ondragstart = e => { e.dataTransfer.setData('text/plain', cls.assignment[seat]); };
      el.ondragover = e => { e.preventDefault(); el.classList.add('over'); };
      el.ondragleave = () => el.classList.remove('over');
      el.ondrop = e => { e.preventDefault(); const sid = e.dataTransfer.getData('text/plain'); if (sid && !shut.includes(seat)) { place(cls, sid, seat); done(); } };
    });
    showRoom(wrap);
  }
  function showRoom(wrap) {
    const st = $('stage');
    st.replaceChildren(wrap);
    fit(wrap, st.clientWidth - 40, st.clientHeight - 50);
  }

  function trySolve(cls) {
    let prev = null;
    if (cls.avoid) {
      // "Last time" is the plan on screen, or the newest saved one if the seats are empty.
      const ref = Object.keys(cls.assignment).length ? cls.assignment : (cls.versions[0] || {}).assignment || {};
      prev = {};
      for (const seat in ref) prev[ref[seat]] = seat.split(':')[0];
    }
    return solve({ students: cls.students, layout: cls.layout, rules: cls.rules, across: cls.across, closed: closedOf(cls), prev });
  }
  function doShuffle(cls) {
    if (!cls.students.length) return alert('Add students first (Students tab).');
    const r = trySolve(cls);
    if (!r.ok) {
      return alert(r.reason === 'seats' ? 'There are more students than seats. Add seats in Desk layout.' : 'Couldn\'t shuffle. Check the class setup.');
    }
    cls.assignment = r.assignment;
    snapshot(cls, 'Shuffle', true);
    ui.sel = null; save(); render();
  }

  /* ---------------- layout tab ---------------- */
  /* Shape of a table: n desks, in `lines` rows, running across (or down if vert). */
  function shapeOf(t) {
    const vert = t.vert == null ? t.rows > t.cols : t.vert;
    return { n: t.n == null ? t.cols * t.rows : t.n, lines: vert ? t.cols : t.rows, vert, end: t.end || '' };
  }
  function setShape(t, n, lines, vert, end) {
    n = Math.max(1, Math.min(24, n));
    if (n < 2) end = '';
    const g = end ? n - 1 : n;
    lines = Math.max(1, Math.min(4, lines, g));
    const per = Math.ceil(g / lines);
    lines = Math.ceil(g / per);
    const span = per + (end ? 1 : 0);
    Object.assign(t, { n, vert, end: end || undefined, cols: vert ? lines : span, rows: vert ? span : lines });
    clamp(t);
  }
  function renderLayout(cls) {
    const t = tableById(cls, ui.selTable);
    const it = itemsOf(cls).find(x => x.id === ui.selTable);
    const changed = () => { const sel = tableById(cls, ui.selTable); if (sel) settle(cls, sel); prune(cls); save(); render(); };
    const addItem = (kind, text, w, hh) => {
      const ni = { id: uid(), kind, text, x: (ROOM_W - w) / 2, y: ROOM_H - hh, w, h: hh };
      // Start along the front wall, in the first stretch not already taken.
      const things = cls.layout.tables.concat(itemsOf(cls));
      const hits = x => things.some(o => { const d = dims(o); return x < o.x + d.w && o.x < x + w && ni.y < o.y + d.h && o.y < ni.y + hh; });
      for (let x = 0; x <= ROOM_W - w; x += .5) if (!hits(x)) { ni.x = x; break; }
      itemsOf(cls).push(ni); ui.selTable = ni.id; changed();
    };
    const nextNum = () => Math.max(0, ...cls.layout.tables.map(x => +x.num || 0)) + 1;
    const addTable = (n, lines) => {
      const nt = { id: uid(), num: nextNum(), x: 1, y: 1 };
      setShape(nt, n, lines, false);
      // Drop it in the first gap, leaving a little space around it.
      const hits = (x, y) => cls.layout.tables.some(o => x < o.x + o.cols * SW + 1 && o.x < x + nt.cols * SW + 1 &&
        y < o.y + o.rows * SH + 1 && o.y < y + nt.rows * SH + 1);
      search: for (let y = 1; y <= ROOM_H - nt.rows * SH; y++)
        for (let x = 1; x <= ROOM_W - nt.cols * SW; x += .5)
          if (!hits(x, y)) { nt.x = x; nt.y = y; break search; }
      cls.layout.tables.push(nt); ui.selTable = nt.id; changed();
    };
    const stepper = (label, value, set, min, max) => h('div', { class: 'row' }, h('label', {}, label),
      h('button', { disabled: value <= min, onclick: () => { set(value - 1); changed(); } }, '−'),
      h('b', { class: 'stepval' }, String(value)),
      h('button', { disabled: value >= max, onclick: () => { set(value + 1); changed(); } }, '+'));
    const sh = t && shapeOf(t);
    fill($('sidebar'), 
      h('h3', {}, 'Add'),
      h('div', { class: 'row' },
        h('button', { onclick: () => addTable(1, 1) }, 'Single desk'),
        h('button', { onclick: () => addTable(2, 1) }, 'Pair')),
      h('div', { class: 'row' },
        h('button', { onclick: () => addTable(4, 2) }, 'Group of 4'),
        h('button', { onclick: () => addTable(6, 2) }, 'Group of 6')),
      h('div', { class: 'row' },
        h('button', { onclick: () => addItem('desk', 'Teacher', 4, 2) }, 'Teacher desk'),
        h('button', { onclick: () => addItem('door', 'Door', 3, 1) }, 'Door')),
      h('div', { class: 'row' },
        h('button', { onclick: () => addItem('window', 'Window', 6, 1) }, 'Window'),
        h('button', { onclick: () => addItem('board', 'Board', 8, 1) }, 'Board')),
      h('button', { onclick: () => addItem('label', 'Label', 4, 1) }, 'Other label'),
      h('p', { class: 'hint' }, 'Drag anything to move it. Click it to select it, then change it below.'),
      it && [
        h('h3', {}, 'Selected: ' + it.text),
        h('input', { type: 'text', value: it.text, maxlength: 30, onchange: ev => { it.text = ev.target.value.trim() || it.text; changed(); } }),
        stepper('Width', it.w, v => { it.w = v; clamp(it); }, 1, ROOM_W),
        stepper('Height', it.h, v => { it.h = v; clamp(it); }, 1, ROOM_H),
        h('button', { onclick: () => { [it.w, it.h] = [it.h, it.w]; clamp(it); changed(); } }, 'Rotate'),
        h('button', { class: 'danger', onclick: () => { cls.layout.items = itemsOf(cls).filter(x => x !== it); ui.selTable = null; changed(); } }, 'Delete'),
      ],
      t ? [
        h('h3', {}, 'Selected: ' + tableName(t)),
        stepper('Desks', sh.n, v => setShape(t, v, sh.lines, sh.vert, sh.end), 1, 24),
        stepper('Rows of desks', sh.lines, v => setShape(t, sh.n, v, sh.vert, sh.end), 1, Math.min(4, sh.end ? sh.n - 1 : sh.n)),
        stepper('Table number', +t.num || 1, v => { t.num = v; }, 1, 99),
        sh.n >= 2 && h('label', {}, h('input', {
          type: 'checkbox', checked: !!sh.end,
          onchange: ev => { setShape(t, sh.n, sh.lines, sh.vert, ev.target.checked ? 'last' : ''); changed(); },
        }), ' One desk sticks out on the end'),
        h('div', { class: 'row' },
          // A quarter turn clockwise: the end desk goes right, bottom, left, top.
          h('button', {
            onclick: () => {
              const end = sh.end && sh.vert ? (sh.end === 'last' ? 'first' : 'last') : sh.end;
              setShape(t, sh.n, sh.lines, !sh.vert, end); changed();
            },
          }, 'Rotate'),
          sh.end && h('button', {
            onclick: () => { setShape(t, sh.n, sh.lines, sh.vert, sh.end === 'last' ? 'first' : 'last'); changed(); },
          }, 'Flip')),
        h('button', {
          onclick: () => {
            const nt = Object.assign(clone(t), { id: uid(), num: nextNum(), x: t.x + 1, y: t.y + 1 });
            clamp(nt); cls.layout.tables.push(nt); ui.selTable = nt.id; changed();
          },
        }, 'Duplicate'),
        h('button', {
          class: 'danger',
          onclick: () => { cls.layout.tables = cls.layout.tables.filter(x => x !== t); ui.selTable = null; changed(); },
        }, 'Delete'),
      ] : !it && h('p', { class: 'hint' }, 'Nothing selected.'),
      h('h3', {}, 'Whole room'),
      h('button', {
        class: 'danger', disabled: !cls.layout.tables.length && !itemsOf(cls).length,
        onclick: () => {
          if (confirm('Remove everything from this room? Students will be unseated.')) { cls.layout = defaultLayout(); ui.selTable = null; changed(); }
        },
      }, 'Clear the room'),
      !cls.layout.tables.length && h('p', { class: 'hint' }, 'The room is empty. Use the Add buttons above to put in desks.'),
    );

    const wrap = renderRoom(cls, { flip: ui.flip, mode: 'layout' });
    showRoom(wrap);
    wrap.querySelectorAll('.table, .item').forEach(el => {
      el.onpointerdown = e => startDrag(e, cls, el.dataset.table || el.dataset.item);
    });
    wrap.querySelector('.room').onpointerdown = e => {
      if (e.target.classList.contains('room') && ui.selTable) { ui.selTable = null; render(); }
    };
  }
  function clamp(t) {
    const d = dims(t);
    t.x = Math.max(0, Math.min(ROOM_W - d.w, t.x));
    t.y = Math.max(t.cols ? 1 : 0, Math.min(ROOM_H - d.h, t.y));
  }
  /* If a table sits on top of another, move it to the nearest clear spot.
     Tables may touch side by side but keep a gap above and below for the labels. */
  function settle(cls, t) {
    const d = dims(t);
    const hits = (x, y) => cls.layout.tables.some(o => o !== t && x < o.x + o.cols * SW && o.x < x + d.w &&
      y < o.y + o.rows * SH + 1 && o.y < y + d.h + 1);
    if (!hits(t.x, t.y)) return;
    let best = null, bd = 1e9;
    for (let y = 1; y <= ROOM_H - d.h; y += .5) for (let x = 0; x <= ROOM_W - d.w; x += .5) {
      const dist = (x - t.x) ** 2 + (y - t.y) ** 2;
      if (dist < bd && !hits(x, y)) { bd = dist; best = [x, y]; }
    }
    if (best) [t.x, t.y] = best;
  }
  function startDrag(e, cls, tid) {
    e.preventDefault();
    const t = tableById(cls, tid) || itemsOf(cls).find(x => x.id === tid);
    const u = parseFloat(getComputedStyle(e.target.closest('.roomwrap')).getPropertyValue('--u'));
    const sx = e.clientX, sy = e.clientY, ox = t.x, oy = t.y, dir = ui.flip ? -1 : 1;
    ui.selTable = tid;
    const move = ev => {
      t.x = Math.round((ox + dir * (ev.clientX - sx) / u) * 2) / 2;
      t.y = Math.round((oy + dir * (ev.clientY - sy) / u) * 2) / 2;
      clamp(t);
      renderLayoutRoomOnly(cls);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (t.cols) settle(cls, t);
      save(); render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function renderLayoutRoomOnly(cls) {
    const wrap = renderRoom(cls, { flip: ui.flip, mode: 'layout' });
    showRoom(wrap);
  }

  /* ---------------- students tab ---------------- */
  function applyStudents(cls, text) {
    const names = text.split('\n').map(s => s.trim()).filter(Boolean);
    const old = cls.students.slice();
    const used = new Set();
    const out = names.map(name => {
      const m = old.find(s => s.name === name && !used.has(s.id));
      if (m) { used.add(m.id); return m; }
      return { id: null, name };
    });
    // A changed line in the same position is treated as a rename, so the seat is kept.
    out.forEach((s, i) => {
      if (s.id) return;
      const o = old[i];
      if (o && !used.has(o.id)) { used.add(o.id); s.id = o.id; } else s.id = uid();
    });
    cls.students = out;
    prune(cls);
  }
  function renderStudents(cls) {
    fill($('sidebar'), 
      h('h3', {}, 'Class list'),
      h('p', { class: 'hint' }, 'One student per line. You can paste a list from a spreadsheet column.'),
      h('p', { class: 'hint' }, 'Removing a line removes that student from their seat. Editing a name in place keeps their seat.'),
    );
    const ta = h('textarea', { spellcheck: 'false', placeholder: 'Alice\nBen\nCarol' });
    ta.value = cls.students.map(s => s.name).join('\n');
    const count = h('span', { class: 'muted' }, cls.students.length + ' students');
    $('stage').replaceChildren(h('div', { class: 'panel' },
      h('h2', {}, 'Students in ' + cls.name), ta,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => { applyStudents(cls, ta.value); save(); render(); } }, 'Save list'),
        count)));
  }

  /* ---------------- history tab ---------------- */
  function renderHistory(cls) {
    fill($('sidebar'), 
      h('h3', {}, 'Saved plans'),
      h('p', { class: 'hint' }, 'Each saved plan remembers the desk layout and who sat where. A plan is also saved automatically every time you shuffle.'),
      h('button', {
        class: 'primary',
        onclick: () => {
          const name = prompt('Name for this saved plan:', new Date().toLocaleDateString());
          if (name) { snapshot(cls, name.trim() || 'Saved plan'); save(); render(); }
        },
      }, 'Save current plan…'),
    );
    const items = cls.versions.map(v => h('li', {},
      h('div', { class: 'vname' }, v.name, h('small', {}, new Date(v.ts).toLocaleString() + ` · ${Object.keys(v.assignment).length} seated`)),
      h('button', {
        onclick: () => {
          if (!confirm('Load "' + v.name + '"? The plan on screen now will be replaced.')) return;
          cls.layout = clone(v.layout); cls.assignment = clone(v.assignment);
          prune(cls); save(); ui.tab = 'seating'; render();
        },
      }, 'Load'),
      h('button', { onclick: () => { const n = prompt('Rename:', v.name); if (n) { v.name = n; v.auto = false; save(); render(); } } }, 'Rename'),
      h('button', { class: 'danger', onclick: () => { cls.versions = cls.versions.filter(x => x !== v); save(); render(); } }, 'Delete'),
    ));
    $('stage').replaceChildren(h('div', { class: 'panel' },
      h('h2', {}, 'History for ' + cls.name),
      items.length ? h('ul', { class: 'vlist' }, items) : h('p', { class: 'muted' }, 'No saved plans yet.')));
  }

  /* ---------------- print tab ---------------- */
  function renderPrint() {
    if (!ui.printIds) ui.printIds = state.classes.map(c => c.id);
    ui.printIds = ui.printIds.filter(id => state.classes.some(c => c.id === id));
    const chosen = state.classes.filter(c => ui.printIds.includes(c.id));
    fill($('sidebar'), 
      h('h3', {}, 'Classes to print'),
      state.classes.map(c => h('label', {}, h('input', {
        type: 'checkbox', checked: ui.printIds.includes(c.id),
        onchange: e => { ui.printIds = e.target.checked ? [...ui.printIds, c.id] : ui.printIds.filter(i => i !== c.id); render(); },
      }), ' ' + c.name)),
      h('p', { class: 'hint' }, 'Two classes fit on each portrait page, one above the other.'),
      h('h3', {}, 'Drawn from'),
      h('label', {}, h('input', { type: 'radio', name: 'pv', checked: !ui.printFlip, onchange: () => { ui.printFlip = false; render(); } }), ' Teacher\'s view (front at bottom)'),
      h('label', {}, h('input', { type: 'radio', name: 'pv', checked: ui.printFlip, onchange: () => { ui.printFlip = true; render(); } }), ' Students\' view (front at top)'),
      h('button', { class: 'primary', disabled: !chosen.length, onclick: () => window.print() }, 'Print / Save as PDF'),
      h('p', { class: 'hint' }, 'In the print window choose "Save as PDF" as the printer to get a PDF. Turn off "Headers and footers" for a cleaner page.'),
    );
    const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    const pages = [];
    for (let i = 0; i < chosen.length; i += 2) {
      pages.push(h('div', { class: 'page' }, chosen.slice(i, i + 2).map(c => {
        const wrap = renderRoom(c, { flip: ui.printFlip, mode: 'view', crop: true });
        const u = Math.min(7.4 / wrap._b.w, 4.25 / (wrap._b.h + 1.7));
        wrap.style.setProperty('--u', u.toFixed(4) + 'in');
        return h('div', { class: 'pblock' }, h('div', { class: 'ptitle' }, h('span', {}, c.name), h('small', {}, date)), wrap);
      })));
    }
    $('stage').replaceChildren(h('div', { class: 'pages' }, pages.length ? pages : h('p', { class: 'muted' }, 'Tick at least one class.')));
  }

  /* ---------------- present ---------------- */
  let pres = null;
  function openPresent() {
    pres = { flip: true, shown: null, busy: false, skip: false };
    $('present').hidden = false;
    $('presentMsg').textContent = '';
    renderPresent();
    const p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
  function closePresent() {
    if (!pres) return;
    pres.skip = true; pres = null;
    $('present').hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    render();
  }
  function renderPresent() {
    if (!pres) return;
    const cls = cur();
    $('presentTitle').textContent = cls.name;
    const wrap = renderRoom(cls, { flip: pres.flip, mode: 'view', crop: true, assignment: pres.shown || cls.assignment });
    $('presentStage').replaceChildren(wrap);
    fit(wrap, window.innerWidth - 40, window.innerHeight - 110);
  }
  const pick = a => a[Math.floor(Math.random() * a.length)];
  /* Each animation only reveals a result that has already been decided and saved.
     c.entries is [seat, studentId] in a random order. */
  const ANIMS = {
    // One desk at a time, names flickering before each lands.
    async slots(c) {
      for (const [seat, sid] of c.entries) {
        for (let k = 0; k < 7 && !c.p.skip; k++) { c.show(seat, c.rand()); await c.wait(45); }
        c.land(seat, sid); await c.wait(110);
      }
    },
    // A whole table spins together, then locks in desk by desk.
    async tables(c) {
      const by = {};
      for (const e of c.entries) (by[e[0].split(':')[0]] = by[e[0].split(':')[0]] || []).push(e);
      for (const group of shuffle(Object.values(by))) {
        for (let k = 0; k < 10 && !c.p.skip; k++) { group.forEach(([seat]) => c.show(seat, c.rand())); await c.wait(60); }
        for (const [seat, sid] of group) { c.land(seat, sid); await c.wait(150); }
        await c.wait(250);
      }
    },
    // Every desk spins at once and they stop one after another.
    async together(c) {
      const left = c.entries.slice();
      for (let k = 0; k < 12 && !c.p.skip; k++) { left.forEach(([seat]) => c.show(seat, c.rand())); await c.wait(50); }
      while (left.length) {
        for (let k = 0; k < 3 && !c.p.skip; k++) { left.forEach(([seat]) => c.show(seat, c.rand())); await c.wait(45); }
        const [seat, sid] = left.shift(); c.land(seat, sid);
      }
    },
    // A name is called, hops around the empty desks, then settles.
    async spotlight(c) {
      for (const [seat, sid] of c.entries) {
        const name = studentName(c.cls, sid);
        $('presentTitle').textContent = name;
        const empties = [...document.querySelectorAll('#presentStage .seat.empty')].map(e => e.dataset.seat).filter(x => x !== seat);
        for (const hop of shuffle(empties).slice(0, 5)) {
          if (c.p.skip) break;
          c.show(hop, name); await c.wait(85); c.clear(hop);
        }
        c.land(seat, sid); await c.wait(170);
      }
    },
    // Names are dealt out from the front of the room like cards.
    async deal(c) {
      const front = document.querySelector('#presentStage .front').getBoundingClientRect();
      const flights = [];
      for (const [seat, sid] of c.entries) {
        if (c.p.skip) break;
        const el = c.el(seat); if (!el) continue;
        const to = el.getBoundingClientRect(), name = studentName(c.cls, sid);
        const card = h('div', { class: 'floater' }, name);
        Object.assign(card.style, {
          left: to.left + 'px', top: to.top + 'px', width: to.width + 'px', height: to.height + 'px',
          fontSize: (nameScale(name) * to.width / SW).toFixed(1) + 'px', transitionDuration: (480 * c.k) + 'ms',
          transform: `translate(${front.left + front.width / 2 - to.left - to.width / 2}px, ${front.top + front.height / 2 - to.top - to.height / 2}px) scale(.3) rotate(${Math.random() * 60 - 30}deg)`,
        });
        $('present').append(card);
        card.getBoundingClientRect();
        card.style.transform = 'none';
        flights.push(sleep(480 * c.k).then(() => { card.remove(); c.land(seat, sid); }));
        await c.wait(120);
      }
      if (!c.p.skip) await Promise.all(flights);
    },
  };
  async function presentShuffle() {
    const cls = cur(), p = pres;
    if (!p) return;
    if (p.busy) { p.skip = true; return; }
    $('presentMsg').textContent = '';
    const r = cls.students.length ? trySolve(cls) : { ok: false };
    if (!r.ok) { $('presentMsg').textContent = 'Shuffle isn\'t available right now.'; return; }

    // The result is committed straight away; the animation only reveals it.
    cls.assignment = r.assignment;
    snapshot(cls, 'Shuffle', true);
    save();

    p.busy = true; p.skip = false; p.shown = {};
    renderPresent();
    const pool = cls.students.map(s => s.name);
    const k = { fast: .45, normal: 1, slow: 2.2 }[prefs.speed] || 1;
    const el = seat => document.querySelector(`#presentStage [data-seat="${seat}"]`);
    const put = (seat, name) => { const e = el(seat); if (e) { e.firstChild.textContent = name; e.firstChild.style.fontSize = U(nameScale(name || 'x').toFixed(3)); } return e; };
    const c = {
      cls, p, k, el, entries: shuffle(Object.entries(r.assignment)),
      wait: ms => p.skip ? Promise.resolve() : sleep(ms * k),
      rand: () => pick(pool),
      show(seat, name) { const e = put(seat, name); if (e) { e.classList.remove('empty'); e.classList.add('rolling'); } },
      clear(seat) { const e = put(seat, ''); if (e) { e.classList.add('empty'); e.classList.remove('rolling'); } },
      land(seat, sid) {
        const e = put(seat, studentName(cls, sid));
        if (e) { e.classList.remove('rolling', 'empty'); e.classList.add('landed'); }
        if (p.shown) p.shown[seat] = sid;
      },
    };
    const style = ANIMS[prefs.style] ? prefs.style : pick(Object.keys(ANIMS).filter(n => n !== p.lastStyle));
    p.lastStyle = style;
    await ANIMS[style](c);
    document.querySelectorAll('.floater').forEach(f => f.remove());
    p.busy = false; p.shown = null;
    if (pres === p) renderPresent();
  }
  for (const [id, key] of [['pStyle', 'style'], ['pSpeed', 'speed']]) {
    $(id).value = prefs[key];
    $(id).onchange = e => { prefs[key] = e.target.value; localStorage.setItem(PKEY, JSON.stringify(prefs)); e.target.blur(); };
  }
  $('btnPresent').onclick = openPresent;
  $('pExit').onclick = closePresent;
  $('pFlip').onclick = () => { if (pres && !pres.busy) { pres.flip = !pres.flip; renderPresent(); } };
  $('pShuffle').onclick = presentShuffle;

  /* ---------------- rules (opened with Alt+R or a triple-click on the title) ---------------- */
  const RULE_TYPES = [
    ['tables', 'must sit at one of these tables'],
    ['with', 'must share a table with at least one of'],
    ['beside', 'must sit beside at least one of'],
    ['notwith', 'must NOT share a table with any of'],
    ['notbeside', 'must NOT sit beside any of'],
    ['seat', 'stays in the seat they are in now'],
  ];
  const joinOr = (a, word) => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' ' + word + ' ' + a[a.length - 1];
  function ruleText(cls, r) {
    const a = studentName(cls, r.a);
    const names = (r.others || []).map(o => studentName(cls, o));
    switch (r.type) {
      case 'tables': return `${a} must sit at ${joinOr(r.tables.map(t => tableName(tableById(cls, t))), 'or')}`;
      case 'with': return `${a} must share a table with ${joinOr(names, 'or')}`;
      case 'beside': return `${a} must sit beside ${joinOr(names, 'or')}`;
      case 'notwith': return `${a} must not share a table with ${joinOr(names, 'or')}`;
      case 'notbeside': return `${a} must not sit beside ${joinOr(names, 'or')}`;
      case 'seat': return `${a} stays in their seat at ${tableName(tableById(cls, r.seat.split(':')[0]))}`;
    }
    return '';
  }
  const form = { a: '', type: 'tables', picks: new Set() };
  function openRules() {
    if (pres) return;
    form.a = ''; form.picks = new Set();
    renderRules();
    if (!$('rulesDialog').open) $('rulesDialog').showModal();
  }
  function renderRules() {
    const cls = cur();
    prune(cls);
    const changed = () => { save(); renderRules(); };
    let status;
    if (!cls.students.length) status = h('div', { class: 'status bad' }, 'Add students first.');
    else {
      const r = trySolve(cls);
      status = r.ok
        ? h('div', { class: 'status ok' }, cls.rules.length ? 'These rules can all be met.' : 'No rules yet. Shuffles are fully random.')
        : h('div', { class: 'status bad' }, r.reason === 'seats' ? 'There are more students than seats.' : 'These rules cannot all be met with this desk layout. Shuffle will not run until one is removed.');
    }
    const list = h('ul', { class: 'rulelist' }, cls.rules.map(r => h('li', {},
      h('span', {}, ruleText(cls, r)),
      h('button', { class: 'danger', onclick: () => { cls.rules = cls.rules.filter(x => x !== r); changed(); } }, 'Remove'))));

    const sorted = cls.students.slice().sort((x, y) => x.name.localeCompare(y.name));
    const isTables = form.type === 'tables', isSeat = form.type === 'seat';
    const options = isTables
      ? cls.layout.tables.slice().sort((x, y) => x.num - y.num).map(t => [t.id, tableName(t)])
      : sorted.filter(s => s.id !== form.a).map(s => [s.id, s.name]);
    const picker = isSeat ? null : h('div', { class: 'picker' }, options.map(([id, label]) => h('label', {}, h('input', {
      type: 'checkbox', checked: form.picks.has(id),
      onchange: e => { e.target.checked ? form.picks.add(id) : form.picks.delete(id); },
    }), ' ' + label)));

    const add = () => {
      if (!form.a) return alert('Choose a student.');
      const picks = [...form.picks].filter(id => options.some(o => o[0] === id));
      if (isSeat) {
        const seat = seatOf(cls, form.a);
        if (!seat) return alert('That student is not in a seat yet.');
        cls.rules.push({ type: 'seat', a: form.a, seat });
      } else {
        if (!picks.length) return alert('Tick at least one ' + (isTables ? 'table.' : 'student.'));
        cls.rules.push(isTables ? { type: 'tables', a: form.a, tables: picks } : { type: form.type, a: form.a, others: picks });
      }
      form.picks = new Set(); changed();
    };

    $('rulesBody').replaceChildren(
      h('p', { class: 'muted', style: 'margin:0' }, `Rules for ${cls.name}. Every shuffle follows them. This window cannot be opened while presenting.`),
      status, list,
      h('div', { class: 'ruleform' },
        h('div', { class: 'row' },
          h('select', { onchange: e => { form.a = e.target.value; form.picks.delete(form.a); renderRules(); } },
            h('option', { value: '' }, 'Student…'), sorted.map(s => h('option', { value: s.id, selected: s.id === form.a }, s.name))),
          h('select', { onchange: e => { form.type = e.target.value; form.picks = new Set(); renderRules(); } },
            RULE_TYPES.map(([v, label]) => h('option', { value: v, selected: v === form.type }, label)))),
        picker,
        h('div', { class: 'row' }, h('button', { class: 'primary', onclick: add }, 'Add rule'))),
      h('label', {}, h('input', {
        type: 'checkbox', checked: cls.across,
        onchange: e => { cls.across = e.target.checked; changed(); },
      }), ' Sitting directly across also counts as "beside"'),
      h('label', {}, h('input', {
        type: 'checkbox', checked: !!cls.avoid,
        onchange: e => { cls.avoid = e.target.checked; changed(); },
      }), ' Try not to put students with the same tablemates as last time'),
    );
  }
  let logoClicks = 0, logoTimer = null;
  $('logo').onclick = () => {
    logoClicks++; clearTimeout(logoTimer);
    logoTimer = setTimeout(() => { logoClicks = 0; }, 600);
    if (logoClicks >= 3) { logoClicks = 0; openRules(); }
  };
  $('rulesDialog').addEventListener('close', () => render());

  window.addEventListener('keydown', e => {
    if (pres) {
      if (e.key === 'Escape') closePresent();
      else if (e.key === ' ' || e.key.toLowerCase() === 's') { e.preventDefault(); presentShuffle(); }
      else if (e.key.toLowerCase() === 'f') $('pFlip').click();
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || $('rulesDialog').open;
    if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (e.altKey && e.code === 'KeyR') { e.preventDefault(); openRules(); }
    else if (e.key === 'Escape' && ui.sel) { ui.sel = null; render(); }
  });
  document.addEventListener('fullscreenchange', () => { if (pres) renderPresent(); });
  window.addEventListener('resize', () => { pres ? renderPresent() : render(); });

  /* ---------------- main ---------------- */
  function render() {
    const cls = cur();
    renderHeader();
    document.querySelector('.viewtoggle').style.visibility = (ui.tab === 'seating' || ui.tab === 'layout') ? '' : 'hidden';
    if (ui.tab === 'seating') renderSeating(cls);
    else if (ui.tab === 'layout') renderLayout(cls);
    else if (ui.tab === 'students') renderStudents(cls);
    else if (ui.tab === 'history') renderHistory(cls);
    else renderPrint();
  }
  state.classes.forEach(prune);
  render();
})();
