/* Seat geometry + arrangement solver. No DOM here so it can be tested in Node. */
(function (root) {
  'use strict';

  function seatId(t, r, c) { return t.id + ':' + r + ':' + c; }

  /* A table is a cols x rows grid. If t.n is set, only the first n cells hold a desk
     (filled along the long side), which allows odd sizes such as 5.
     If t.end is 'last' or 'first', one of the n desks sits on its own at that end of
     the table; it occupies a single cell in an extra line of the grid. */
  const isHoriz = t => t.vert == null ? t.cols >= t.rows : !t.vert;
  function endCell(t) {
    if (!t.end) return null;
    const first = t.end === 'first';
    return isHoriz(t) ? { r: 0, c: first ? 0 : t.cols - 1 } : { r: first ? 0 : t.rows - 1, c: 0 };
  }
  function hasSeat(t, r, c) {
    if (r < 0 || r >= t.rows || c < 0 || c >= t.cols) return false;
    if (t.n == null) return true;
    if (!t.end) return (t.vert ? c * t.rows + r : r * t.cols + c) < t.n;
    const e = endCell(t), off = t.end === 'first' ? 1 : 0;
    if (isHoriz(t)) return c === e.c ? r === 0 : r * (t.cols - 1) + (c - off) < t.n - 1;
    return r === e.r ? c === 0 : c * (t.rows - 1) + (r - off) < t.n - 1;
  }

  function listSeats(layout) {
    const out = [];
    for (const t of layout.tables)
      for (let r = 0; r < t.rows; r++)
        for (let c = 0; c < t.cols; c++)
          if (hasSeat(t, r, c)) out.push({ id: seatId(t, r, c), table: t.id, r, c });
    return out;
  }

  /* "Beside" = next to each other along the long side of the table.
     With across=true, the seat directly opposite also counts.
     A desk on the end is beside the desks it touches. */
  function adjacency(layout, across) {
    const adj = {};
    for (const t of layout.tables) {
      const horiz = isHoriz(t), e = endCell(t);
      const isEnd = (r, c) => !!e && e.r === r && e.c === c;
      const grid = (r, c) => hasSeat(t, r, c) && !isEnd(r, c) && !(e && (horiz ? c === e.c : r === e.r));
      for (let r = 0; r < t.rows; r++) {
        for (let c = 0; c < t.cols; c++) {
          if (!grid(r, c)) continue;
          const n = [];
          const add = (rr, cc) => { if (grid(rr, cc)) n.push(seatId(t, rr, cc)); };
          if (horiz || across) { add(r, c - 1); add(r, c + 1); }
          if (!horiz || across) { add(r - 1, c); add(r + 1, c); }
          adj[seatId(t, r, c)] = n;
        }
      }
      if (e) {
        const eid = seatId(t, e.r, e.c), n = [];
        const step = t.end === 'first' ? 1 : -1;
        const lines = horiz ? t.rows : t.cols;
        for (let i = 0; i < lines; i++) {
          const r = horiz ? i : e.r + step, c = horiz ? e.c + step : i;
          if (grid(r, c)) { n.push(seatId(t, r, c)); adj[seatId(t, r, c)].push(eid); }
        }
        adj[eid] = n;
      }
    }
    return adj;
  }

  function shuffle(a, rnd) {
    rnd = rnd || Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* opts: { students:[{id}], layout, rules, across, rnd }
     returns { ok:true, assignment:{seatId: studentId} } or { ok:false, reason } */
  function solve(opts) {
    const rnd = opts.rnd || Math.random;
    const students = opts.students.map(s => s.id);
    const seats = listSeats(opts.layout);
    if (students.length > seats.length) return { ok: false, reason: 'seats' };

    const tableOf = {};
    seats.forEach(s => { tableOf[s.id] = s.table; });
    const adj = adjacency(opts.layout, !!opts.across);
    const valid = new Set(students);
    const tableIds = new Set(opts.layout.tables.map(t => t.id));
    const allSeatIds = seats.map(s => s.id);

    const domain = {};
    const restricted = new Set();
    const rel = [];
    for (const r of opts.rules || []) {
      if (!valid.has(r.a)) continue;
      if (r.type === 'tables') {
        const ts = (r.tables || []).filter(t => tableIds.has(t));
        if (!ts.length) continue;
        domain[r.a] = (domain[r.a] || allSeatIds).filter(s => ts.includes(tableOf[s]));
        restricted.add(r.a);
      } else if (r.type === 'seat') {
        if (!(r.seat in tableOf)) continue;
        domain[r.a] = (domain[r.a] || allSeatIds).filter(s => s === r.seat);
        restricted.add(r.a);
      } else {
        const others = (r.others || []).filter(o => valid.has(o) && o !== r.a);
        if (!others.length) continue;
        rel.push({ type: r.type, a: r.a, others });
      }
    }
    for (const s of restricted) if (!domain[s].length) return { ok: false, reason: 'rules' };

    // Group linked students so they are placed one after another.
    const parent = {};
    const find = x => (parent[x] === undefined || parent[x] === x) ? x : (parent[x] = find(parent[x]));
    const constrained = new Set(restricted);
    for (const r of rel) {
      constrained.add(r.a);
      for (const o of r.others) { constrained.add(o); parent[find(o)] = find(r.a); }
    }

    const pos = {}, occ = {}, freeInTable = {};
    function relOk() {
      for (const r of rel) {
        const pa = pos[r.a];
        if (!pa) continue;
        const neg = r.type === 'notwith' || r.type === 'notbeside';
        const table = r.type === 'with' || r.type === 'notwith';
        let sat = false, pending = false;
        for (const o of r.others) {
          const po = pos[o];
          if (!po) { pending = true; continue; }
          const hit = table ? tableOf[po] === tableOf[pa] : adj[pa].includes(po);
          if (hit) { if (neg) return false; sat = true; }
        }
        if (neg || sat) continue;
        if (!pending) return false;
        if (table) { if (freeInTable[tableOf[pa]] <= 0) return false; }
        else if (!adj[pa].some(q => !occ[q])) return false;
      }
      return true;
    }

    for (let attempt = 0; attempt < 60; attempt++) {
      for (const k in pos) delete pos[k];
      for (const k in occ) delete occ[k];
      for (const s of seats) freeInTable[s.table] = 0;
      for (const s of seats) freeInTable[s.table]++;

      const comps = {};
      for (const s of shuffle([...constrained], rnd)) (comps[find(s)] = comps[find(s)] || []).push(s);
      const size = c => Math.min(...c.map(s => (domain[s] || allSeatIds).length));
      const order = shuffle(Object.values(comps), rnd).sort((a, b) => size(a) - size(b)).flat();

      let budget = 20000;
      const place = i => {
        if (i === order.length) return true;
        const s = order[i];
        for (const seat of shuffle((domain[s] || allSeatIds).slice(), rnd)) {
          if (occ[seat]) continue;
          if (--budget < 0) return false;
          pos[s] = seat; occ[seat] = s; freeInTable[tableOf[seat]]--;
          if (relOk() && place(i + 1)) return true;
          delete pos[s]; delete occ[seat]; freeInTable[tableOf[seat]]++;
        }
        return false;
      };

      if (place(0)) {
        const free = shuffle(allSeatIds.filter(s => !occ[s]), rnd);
        const rest = shuffle(students.filter(s => !constrained.has(s)), rnd);
        rest.forEach((s, i) => { occ[free[i]] = s; });
        return { ok: true, assignment: Object.assign({}, occ) };
      }
    }
    return { ok: false, reason: 'rules' };
  }

  const api = { hasSeat, endCell, isHoriz, seatId, listSeats, adjacency, shuffle, solve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SeatSolver = api;
})(typeof window !== 'undefined' ? window : globalThis);
