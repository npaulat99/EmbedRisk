/* Isomorphic DFD routing and geometry helpers. Exposes a browser global and CommonJS module. */
(function (g) {
  "use strict";

  /** Liang-Barsky: does the segment (x1,y1)-(x2,y2) cross the interior of rect r? */
  function segHitsRect(x1, y1, x2, y2, r) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    let t0 = 0;
    let t1 = 1;
    const edges = [
      [-dx, x1 - r.x],
      [dx, r.x + r.w - x1],
      [-dy, y1 - r.y],
      [dy, r.y + r.h - y1],
    ];
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) return false;
      } else {
        const t = q / p;
        if (p < 0) {
          if (t > t1) return false;
          if (t > t0) t0 = t;
        } else {
          if (t < t0) return false;
          if (t < t1) t1 = t;
        }
      }
    }
    return t0 < t1;
  }

  // Greedy router that bends around obstacle boxes.
  function routeAround(sx, sy, tx, ty, obstacles, pad, depth = 0) {
    if (depth >= 5) return [[sx, sy], [tx, ty]];
    let best = null;
    let bestD = Infinity;
    for (const o of obstacles) {
      const r = { x: o.x - pad, y: o.y - pad, w: o.w + 2 * pad, h: o.h + 2 * pad };
      const inside = (px, py) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
      if (inside(sx, sy) || inside(tx, ty)) continue;
      if (segHitsRect(sx, sy, tx, ty, r)) {
        const d = (o.x + o.w / 2 - sx) ** 2 + (o.y + o.h / 2 - sy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = o;
        }
      }
    }
    if (!best) return [[sx, sy], [tx, ty]];
    const x0 = best.x - pad;
    const x1 = best.x + best.w + pad;
    const y0 = best.y - pad;
    const y1 = best.y + best.h + pad;
    let wps;
    if (Math.abs(tx - sx) >= Math.abs(ty - sy)) {
      const midY = (sy + ty) / 2;
      const wy = Math.abs(y0 - midY) <= Math.abs(y1 - midY) ? y0 : y1;
      wps = sx <= tx ? [[x0, wy], [x1, wy]] : [[x1, wy], [x0, wy]];
    } else {
      const midX = (sx + tx) / 2;
      const wx = Math.abs(x0 - midX) <= Math.abs(x1 - midX) ? x0 : x1;
      wps = sy <= ty ? [[wx, y0], [wx, y1]] : [[wx, y1], [wx, y0]];
    }
    const rest = obstacles.filter((o) => o !== best);
    const a = routeAround(sx, sy, wps[0][0], wps[0][1], rest, pad, depth + 1);
    const b = routeAround(wps[0][0], wps[0][1], wps[1][0], wps[1][1], rest, pad, depth + 1);
    const c = routeAround(wps[1][0], wps[1][1], tx, ty, rest, pad, depth + 1);
    return [...a, ...b.slice(1), ...c.slice(1)];
  }

  /** SVG path through a polyline with rounded corners. */
  function roundedPath(pts, r) {
    if (pts.length <= 2) return `M ${pts[0][0]},${pts[0][1]} L ${pts[1][0]},${pts[1][1]}`;
    let d = `M ${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i - 1];
      const [cx, cy] = pts[i];
      const [nx, ny] = pts[i + 1];
      const l1 = Math.hypot(px - cx, py - cy) || 1;
      const l2 = Math.hypot(nx - cx, ny - cy) || 1;
      const rr = Math.min(r, l1 / 2, l2 / 2);
      d += ` L ${cx + ((px - cx) / l1) * rr},${cy + ((py - cy) / l1) * rr} Q ${cx},${cy} ${cx + ((nx - cx) / l2) * rr},${cy + ((ny - cy) / l2) * rr}`;
    }
    d += ` L ${pts[pts.length - 1][0]},${pts[pts.length - 1][1]}`;
    return d;
  }

  /** Point at 2/3 along a polyline by arc length. */
  function labelPtOnPolyline(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let dist = (total * 2) / 3;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (dist <= seg) {
        const r = seg ? dist / seg : 0;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * r, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * r];
      }
      dist -= seg;
    }
    return pts[Math.floor((pts.length * 2) / 3)];
  }

  /** Point where a line toward (tx,ty) exits a rectangle. */
  function borderPoint(b, tx, ty) {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (!dx && !dy) return [cx, cy];
    const tX = dx !== 0 ? b.w / 2 / Math.abs(dx) : Infinity;
    const tY = dy !== 0 ? b.h / 2 / Math.abs(dy) : Infinity;
    const t = Math.min(tX, tY);
    return [cx + dx * t, cy + dy * t];
  }

  const api = { routeAround, roundedPath, labelPtOnPolyline, borderPoint };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  g.DfdEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
