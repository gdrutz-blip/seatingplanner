/* Plan builder: searches for a seating plan that best fits the teacher's notes
   (friends, keep-aparts, front-of-room needs, tags). Runs entirely in the browser.
   Separate from the shuffle; it only reuses the seat geometry from solver.js. */
(function (root) {
  'use strict';
  const G = typeof module !== 'undefined' && module.exports ? require('./solver.js') : root.SeatSolver;

  const W = { rule: 1000, prefer: 150, apart: 300, front: 40, friend: 20, max: 25, spread: 8, even: 10, repeat: 4 };

  /* opts: { students:[{id,name}], layout, closed, rules, across, prefs, roomH, seatH, fixed, recent }
     fixed: { studentId: seatId } for pinned students, who are never moved.
     recent: [{ weight, table: { studentId: tableId } }], earlier plans whose tablemates to avoid repeating.
     prefs: { friends:'with'|'apart'|'ignore', students:{id:{friends,apart,tags,front}}, tags:[{id,name,mode,max}] } */
  function prepare(opts) {
    const closed = new Set(opts.closed || []);
    const seats = G.listSeats(opts.layout).filter(s => !closed.has(s.id));
    const tableOf = {};
    seats.forEach(s => { tableOf[s.id] = s.table; });
    const adj = G.adjacency(opts.layout, !!opts.across);
    const tables = opts.layout.tables;
    const ids = opts.students.map(s => s.id), valid = new Set(ids);
    const prefs = opts.prefs || {}, P = prefs.students || {};
    const mode = prefs.friends || 'with';

    // Front tables: those whose near edge is within one desk of the closest table.
    const dist = {};
    for (const t of tables) dist[t.id] = opts.roomH - (t.y + t.rows * opts.seatH);
    const nearest = Math.min(...tables.map(t => dist[t.id]));
    const far = Math.max(1, ...tables.map(t => dist[t.id] - nearest));
    const isFront = t => dist[t] - nearest <= opts.seatH;

    const friends = {}, wantsFront = [], apart = [], seen = new Set();
    for (const s of ids) {
      const p = P[s] || {};
      friends[s] = (p.friends || []).filter(f => valid.has(f) && f !== s);
      if (p.front) wantsFront.push(s);
      for (const o of p.apart || []) {
        const key = [s, o].sort().join('|');
        if (valid.has(o) && o !== s && !seen.has(key)) { seen.add(key); apart.push([s, o]); }
      }
    }
    const tags = (prefs.tags || []).map(t => ({ tag: t, who: ids.filter(s => ((P[s] || {}).tags || []).includes(t.id)) }));
    const rules = (opts.rules || []).filter(r => r.type === 'atmost'
      ? (r.group || []).filter(x => valid.has(x)).length > (r.max || 1) : valid.has(r.a));

    // Pinned students, plus hidden "stays in their seat" rules, are fixed in place.
    const fixed = {}, taken = new Set();
    const fix = (s, seat) => { if (valid.has(s) && seat in tableOf && !fixed[s] && !taken.has(seat)) { fixed[s] = seat; taken.add(seat); } };
    for (const [s, seat] of Object.entries(opts.fixed || {})) fix(s, seat);
    for (const r of rules) if (r.type === 'seat' && !r.soft) fix(r.a, r.seat);

    // Rotation: a weight for every pair who shared a table in a recent plan.
    const n = ids.length, idx = {};
    ids.forEach((s, i) => { idx[s] = i; });
    const recent = (opts.recent || []).filter(pl => pl.weight > 0);
    const pw = recent.length ? new Float64Array(n * n) : null;
    for (const pl of recent) {
      const by = {};
      for (const s in pl.table) if (s in idx) (by[pl.table[s]] = by[pl.table[s]] || []).push(idx[s]);
      for (const m of Object.values(by))
        for (let i = 0; i < m.length; i++) for (let j = 0; j < m.length; j++) if (i !== j) pw[m[i] * n + m[j]] += pl.weight;
    }

    function ruleBroken(r, pos) {
      if (r.type === 'atmost') {
        const per = {};
        for (const s of r.group) if (pos[s] && (per[tableOf[pos[s]]] = (per[tableOf[pos[s]]] || 0) + 1) > (r.max || 1)) return true;
        return false;
      }
      const pa = pos[r.a];
      if (!pa) return false;
      if (r.type === 'tables') return !r.tables.includes(tableOf[pa]);
      if (r.type === 'seat') return pa !== r.seat;
      const table = r.type === 'with' || r.type === 'notwith';
      const hit = (r.others || []).some(o => pos[o] && (table ? tableOf[pos[o]] === tableOf[pa] : adj[pa].includes(pos[o])));
      return r.type === 'with' || r.type === 'beside' ? !hit : hit;
    }

    /* pos: studentId -> seatId. Returns the cost and, if asked, a readable report. */
    function score(pos, wantReport) {
      const tOf = s => pos[s] ? tableOf[pos[s]] : null;
      const count = {}, members = {};
      for (const s of ids) { const t = tOf(s); if (t) { count[t] = (count[t] || 0) + 1; (members[t] = members[t] || []).push(idx[s]); } }
      let cost = 0;
      const repeats = [];
      if (pw) for (const t in members) {
        const m = members[t];
        for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) {
          const w = pw[m[i] * n + m[j]];
          if (w) { cost += W.repeat * w; if (wantReport) repeats.push([ids[m[i]], ids[m[j]], w]); }
        }
      }
      for (const t of tables) cost += W.even * (count[t.id] || 0) ** 2;

      const brokenRules = rules.filter(r => ruleBroken(r, pos));
      for (const r of brokenRules) cost += r.soft ? W.prefer : W.rule;

      const brokenApart = apart.filter(([a, b]) => tOf(a) && tOf(a) === tOf(b));
      cost += W.apart * brokenApart.length;

      const frontMissed = wantsFront.filter(s => tOf(s) && !isFront(tOf(s)));
      for (const s of frontMissed) cost += W.front * (1 + (dist[tOf(s)] - nearest) / far);

      const lonely = [], together = [];
      if (mode !== 'ignore') for (const s of ids) {
        const mine = friends[s].filter(f => tOf(s) && tOf(f) === tOf(s));
        if (mode === 'with' && friends[s].length && tOf(s) && !mine.length) lonely.push(s);
        if (mode === 'apart') for (const f of mine) together.push([s, f]);
      }
      cost += W.friend * (lonely.length + together.length);

      const tagRows = tags.map(({ tag, who }) => {
        const per = {};
        for (const s of who) { const t = tOf(s); if (t) per[t] = (per[t] || 0) + 1; }
        const seated = who.filter(s => tOf(s)).length, all = ids.filter(s => tOf(s)).length || 1;
        let over = 0;
        for (const t of tables) {
          const n = per[t.id] || 0;
          if (tag.mode === 'max') { const x = Math.max(0, n - (tag.max || 1)); over += x; cost += W.max * x; }
          else if (tag.mode === 'spread') cost += W.spread * (n - seated * (count[t.id] || 0) / all) ** 2;
        }
        return { tag, over, counts: tables.map(t => ({ table: t, n: per[t.id] || 0 })) };
      });

      if (!wantReport) return cost;
      const withFriends = ids.filter(s => friends[s].length && tOf(s));
      return {
        cost,
        report: {
          mode, seated: ids.filter(s => pos[s]).length, total: ids.length,
          friend: { asked: withFriends.length, lonely, together },
          apart: { total: apart.length, broken: brokenApart },
          front: { total: wantsFront.length, missed: frontMissed },
          tags: tagRows, rules: { total: rules.length, broken: brokenRules.length, mustBroken: brokenRules.filter(r => !r.soft).length },
          repeat: { plans: recent.length, pairs: repeats.sort((a, b) => b[2] - a[2]) },
        },
      };
    }
    /* Each unmet rule or note as its own item, so a move can be checked for what it breaks. */
    function issues(pos) {
      const tOf = s => pos[s] ? tableOf[pos[s]] : null;
      const out = [];
      rules.forEach((r, i) => { if (ruleBroken(r, pos)) out.push({ key: 'r' + i, kind: 'rule', rule: r, who: r.type === 'atmost' ? r.group.filter(x => pos[x]) : [r.a] }); });
      for (const [a, b] of apart) if (tOf(a) && tOf(a) === tOf(b)) out.push({ key: 'a' + a + b, kind: 'apart', who: [a, b] });
      for (const s of wantsFront) if (tOf(s) && !isFront(tOf(s))) out.push({ key: 'f' + s, kind: 'front', who: [s] });
      if (mode === 'with') for (const s of ids)
        if (friends[s].length && tOf(s) && !friends[s].some(f => tOf(f) === tOf(s))) out.push({ key: 'l' + s, kind: 'lonely', who: [s] });
      if (mode === 'apart') for (const s of ids) for (const f of friends[s])
        if (tOf(s) && tOf(f) === tOf(s) && !(friends[f].includes(s) && f < s)) out.push({ key: 'p' + [s, f].sort().join(), kind: 'friends', who: [s, f] });
      for (const { tag, who } of tags) {
        if (tag.mode !== 'max') continue;
        const per = {};
        for (const s of who) { const t = tOf(s); if (t) (per[t] = per[t] || []).push(s); }
        for (const t in per) if (per[t].length > (tag.max || 1)) out.push({ key: 't' + tag.id + t, kind: 'tag', tag, table: t, who: per[t] });
      }
      return out;
    }
    return { seats, ids, score, issues, fixed };
  }

  /* Returns a function that lists the unmet rules and notes for an assignment (seatId -> studentId). */
  function checker(opts) {
    const p = prepare(opts);
    return assignment => {
      const pos = {};
      for (const seat in assignment) pos[assignment[seat]] = seat;
      return p.issues(pos);
    };
  }

  /* Report on an existing plan (assignment: seatId -> studentId). */
  function evaluate(opts) {
    const pos = {};
    for (const seat in opts.assignment) pos[opts.assignment[seat]] = seat;
    return prepare(opts).score(pos, true).report;
  }

  /* Simulated annealing: start random, swap seats, keep improvements, and accept
     the odd worse move early on so the search doesn't get stuck. */
  function build(opts) {
    const rnd = opts.rnd || Math.random;
    const { seats, ids, score, fixed } = prepare(opts);
    if (ids.length > seats.length) return { ok: false, reason: 'seats' };
    if (!ids.length) return { ok: false, reason: 'students' };
    const pinnedSeats = new Set(Object.values(fixed));
    const seatIds = seats.map(s => s.id).filter(s => !pinnedSeats.has(s));
    const free = ids.filter(s => !fixed[s]);
    if (free.length > seatIds.length) return { ok: false, reason: 'seats' };
    const start = () => { const pos = Object.assign({}, fixed), occ = {}; for (const s in fixed) occ[fixed[s]] = s; return { pos, occ }; };
    if (!free.length) return { ok: true, assignment: start().occ };
    let best = null, bestCost = Infinity;
    const rounds = opts.rounds || 5, steps = opts.steps || 20000;
    for (let round = 0; round < rounds; round++) {
      const order = G.shuffle(seatIds.slice(), rnd);
      const { pos, occ } = start();
      free.forEach((s, i) => { pos[s] = order[i]; occ[order[i]] = s; });
      let cost = score(pos);
      for (let i = 0; i < steps; i++) {
        const temp = 30 * Math.pow(0.003, i / steps);
        const a = free[Math.floor(rnd() * free.length)];
        const from = pos[a], to = seatIds[Math.floor(rnd() * seatIds.length)];
        if (from === to) continue;
        const b = occ[to];
        pos[a] = to; occ[to] = a;
        if (b) { pos[b] = from; occ[from] = b; } else delete occ[from];
        const next = score(pos);
        if (next <= cost || rnd() < Math.exp((cost - next) / temp)) cost = next;
        else {
          pos[a] = from; occ[from] = a;
          if (b) { pos[b] = to; occ[to] = b; } else delete occ[to];
        }
      }
      if (cost < bestCost) { bestCost = cost; best = Object.assign({}, occ); }
    }
    return { ok: true, assignment: best };
  }

  const api = { build, evaluate, checker };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SeatBuilder = api;
})(typeof window !== 'undefined' ? window : globalThis);
