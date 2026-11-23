// Pure geometry helpers for the face mesh (no DOM, testable in Node).

// MediaPipe Face Mesh landmark groups (468-point topology).
export const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,
  152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
export const MOUTH_INNER = [78,191,80,81,82,13,312,311,310,415,308,324,318,402,317,14,87,178,88,95];
export const LEFT_EYE = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246];
export const RIGHT_EYE = [263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466];
export const MESH_POINTS = 468;

// Bowyer–Watson Delaunay triangulation. pts: [[x,y],...] -> [[i,j,k],...]
export function delaunay(pts) {
  const n = pts.length;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const d = Math.max(maxX - minX, maxY - minY, 1e-6) * 20;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const P = pts.concat([[mx - d, my - d], [mx, my + d], [mx + d, my - d]]);

  const circ = (a, b, c) => {
    const [ax, ay] = P[a], [bx, by] = P[b], [cx, cy] = P[c];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-12) return { x: 0, y: 0, r2: Infinity };
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / D;
    const y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / D;
    return { x, y, r2: (ax - x) ** 2 + (ay - y) ** 2 };
  };

  let tris = [{ v: [n, n + 1, n + 2], c: circ(n, n + 1, n + 2) }];
  for (let i = 0; i < n; i++) {
    const [px, py] = P[i];
    const keep = [], edges = new Map();
    for (const t of tris) {
      const dx = px - t.c.x, dy = py - t.c.y;
      if (dx * dx + dy * dy <= t.c.r2 * (1 + 1e-9)) {
        const [a, b, c] = t.v;
        for (const [u, w] of [[a, b], [b, c], [c, a]]) {
          const k = u < w ? u + ',' + w : w + ',' + u;
          const e = edges.get(k);
          if (e) e.count++; else edges.set(k, { u, w, count: 1 });
        }
      } else keep.push(t);
    }
    for (const e of edges.values()) {
      if (e.count === 1) keep.push({ v: [e.u, e.w, i], c: circ(e.u, e.w, i) });
    }
    tris = keep;
  }
  return tris.filter(t => t.v.every(k => k < n)).map(t => t.v);
}

// Graph distance (in mesh edges) of every vertex from the face outline.
export function depthFromOutline(tris, count, outline = FACE_OVAL) {
  const nb = Array.from({ length: count }, () => new Set());
  for (const [a, b, c] of tris) {
    nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
  }
  const depth = new Array(count).fill(Infinity);
  const q = [];
  for (const i of outline) { depth[i] = 0; q.push(i); }
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    for (const j of nb[i]) if (depth[j] === Infinity) { depth[j] = depth[i] + 1; q.push(j); }
  }
  return depth;
}

// Per-vertex opacity: 0 at the outline ramping to 1 after `feather` rings.
export function featherAlpha(depth, feather) {
  return Float32Array.from(depth, d => (d === Infinity ? 1 : Math.min(1, d / feather)));
}

// Drop triangles that lie entirely inside a hole (mouth / eyes) we want to keep from the target.
export function filterTriangles(tris, { keepMouth, keepEyes }) {
  const holes = [];
  if (keepMouth) holes.push(new Set(MOUTH_INNER));
  if (keepEyes) { holes.push(new Set(LEFT_EYE)); holes.push(new Set(RIGHT_EYE)); }
  return tris.filter(t => !holes.some(h => t.every(i => h.has(i))));
}

export function bbox(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}
