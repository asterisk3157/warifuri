// The layout of a goal's flowchart, without the DOM, so that it can be tested in Node.
//
// Columns come from the order: a task stands one column right of the rightmost task before
// it. An arrow that spans more than one column gets invisible relay points in the columns
// between, so it runs through the gaps between boxes, not across them. Inside a column,
// boxes are ordered by the mean position of what they connect to, three times, from the left
// and from the right. An order that loops (the ledger refuses one, but an import may bring
// one) cannot hang the layout: a task met again while its column is being worked out counts
// as column 0.
//
// tasks: [{ id, after: [ids before it, in this list], small }] (a small task, such as a done one,
// gets a lower box). Returns { nodes: { id: { x, y, h } },
// edges: [{ from, to, d, tipX, tipY }], width, height } with d an SVG path ending at the tip.

export const SIZES = { NW: 150, NH: 84, SH: 40, DH: 18, GX: 32, GY: 12 };

export function layoutFlow(tasks, sizes = SIZES) {
  const { NW, NH, DH, GX, GY } = sizes;
  const SH = sizes.SH ?? NH;
  const by = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map();
  const visiting = new Set();
  const lv = (t) => {
    if (level.has(t.id)) return level.get(t.id);
    if (visiting.has(t.id)) return 0;
    visiting.add(t.id);
    const before = (t.after ?? []).filter((id) => by.has(id) && id !== t.id);
    const l = before.length ? Math.max(...before.map((id) => lv(by.get(id)))) + 1 : 0;
    visiting.delete(t.id);
    level.set(t.id, l);
    return l;
  };
  for (const t of tasks) lv(t);

  const items = new Map();
  const cols = [];
  const put = (it) => {
    items.set(it.id, it);
    (cols[it.lvl] ??= []).push(it);
    return it;
  };
  for (const t of tasks) put({ id: t.id, lvl: level.get(t.id), real: true, small: Boolean(t.small), prev: [], next: [] });
  const edges = [];
  for (const t of tasks) {
    for (const a of new Set(t.after ?? [])) {
      if (!by.has(a) || a === t.id) continue;
      const chain = [a];
      for (let k = level.get(a) + 1; k < level.get(t.id); k += 1) chain.push(put({ id: `${a}>${t.id}@${k}`, lvl: k, real: false, prev: [], next: [] }).id);
      chain.push(t.id);
      for (let i = 1; i < chain.length; i += 1) {
        items.get(chain[i]).prev.push(chain[i - 1]);
        items.get(chain[i - 1]).next.push(chain[i]);
      }
      edges.push({ from: a, to: t.id, chain });
    }
  }
  for (let k = 0; k < cols.length; k += 1) cols[k] ??= [];

  const rank = new Map();
  cols.forEach((col) => col.forEach((it, i) => rank.set(it.id, i)));
  const order = (col, key) => {
    col.forEach((it, i) => {
      it.bary = it[key].length ? it[key].reduce((n, x) => n + rank.get(x), 0) / it[key].length : (rank.get(it.id) ?? i);
    });
    col.sort((x, y) => x.bary - y.bary);
    col.forEach((it, i) => rank.set(it.id, i));
  };
  for (let pass = 0; pass < 3; pass += 1) {
    if (pass % 2 === 0) for (let k = 1; k < cols.length; k += 1) order(cols[k], 'prev');
    else for (let k = cols.length - 2; k >= 0; k -= 1) order(cols[k], 'next');
  }

  const at = new Map();
  let height = 0;
  cols.forEach((col, k) => {
    let y = 0;
    for (const it of col) {
      const ih = !it.real ? DH : it.small ? SH : NH;
      at.set(it.id, { x: k * (NW + GX), y, h: ih, cy: y + ih / 2 });
      y += ih + GY;
    }
    height = Math.max(height, y - GY);
  });

  const curve = (x1, y1, x2, y2) => {
    const mx = (x1 + x2) / 2;
    return `C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  };
  const outEdges = edges.map((e) => {
    const p0 = at.get(e.chain[0]);
    let d = `M${p0.x + NW} ${p0.cy}`;
    let x = p0.x + NW;
    let y = p0.cy;
    for (const id of e.chain.slice(1, -1)) {
      const q = at.get(id);
      d += `${curve(x, y, q.x, q.cy)}L${q.x + NW} ${q.cy}`;
      x = q.x + NW;
      y = q.cy;
    }
    const z = at.get(e.to);
    const tipX = z.x - 6;
    d += curve(x, y, tipX, z.cy);
    return { from: e.from, to: e.to, d, tipX, tipY: z.cy };
  });

  const nodes = {};
  for (const t of tasks) nodes[t.id] = { x: at.get(t.id).x, y: at.get(t.id).y, h: at.get(t.id).h };
  return { nodes, edges: outEdges, width: Math.max(0, cols.length * (NW + GX) - GX), height: Math.max(height, tasks.length ? Math.min(...Object.values(nodes).map((n) => n.h)) : 0) };
}

// The arrow head at a tip.
export const arrowHead = (x, y) => `M${x - 1} ${y - 5}L${x + 6} ${y}L${x - 1} ${y + 5}Z`;
