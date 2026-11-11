// Gradient-boosted decision trees for a yes/no outcome (logistic loss), small enough to train inside DI
// in seconds and to read back as JSON. Each feature is cut into up to 32 bins at its quantiles; each
// tree splits where the second-order gain is largest; leaves are shrunk by the learning rate. A score
// splits into what each feature added along each tree's path (Saabas), so every score has reasons.
// Deterministic: the same data and settings give the same model.

export interface GbmParams {
  trees: number;
  depth: number;
  learningRate: number;
  /** L2 penalty on leaf values. */
  lambda: number;
  /** The least hessian (about the number of examples, weighted) a leaf may hold. */
  minChild: number;
  /** Share of rows each tree sees. */
  subsample: number;
  bins: number;
}

export const DEFAULT_PARAMS: GbmParams = { trees: 120, depth: 4, learningRate: 0.08, lambda: 1, minChild: 20, subsample: 0.8, bins: 32 };

/** A node: a split (feature, threshold, left, right) or a leaf; v is the node's value either way. */
export interface Node {
  f?: number;
  t?: number;
  l?: number;
  r?: number;
  v: number;
}

export interface Gbm {
  features: string[];
  base: number;
  trees: Node[][];
  params: GbmParams;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Up to n-1 cut points at the feature's quantiles. */
function cuts(values: number[], n: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (let k = 1; k < n; k++) {
    const v = sorted[Math.min(sorted.length - 1, Math.floor((k / n) * sorted.length))]!;
    if (!out.length || v > out[out.length - 1]!) out.push(v);
  }
  return out;
}

const binOf = (edges: number[], x: number) => {
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x <= edges[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

/** Trains on rows of feature values, 0/1 labels and optional weights (for sampled negatives). */
export function train(features: string[], X: number[][], y: number[], w: number[] | null, params: Partial<GbmParams> = {}): Gbm {
  const P = { ...DEFAULT_PARAMS, ...params };
  const n = X.length;
  const p = features.length;
  const weight = w ?? new Array<number>(n).fill(1);
  const edges = features.map((_, j) => cuts(X.map((r) => r[j]!), P.bins));
  const binned = new Uint8Array(n * p);
  for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) binned[i * p + j] = binOf(edges[j]!, X[i]![j]!);
  const sw = weight.reduce((s, v) => s + v, 0);
  const swy = weight.reduce((s, v, i) => s + v * y[i]!, 0);
  const rate = Math.min(1 - 1e-6, Math.max(1e-6, swy / sw));
  const base = Math.log(rate / (1 - rate));
  const F = new Float64Array(n).fill(base);
  const g = new Float64Array(n);
  const h = new Float64Array(n);
  const rand = rng(20261111);
  const trees: Node[][] = [];
  const nb = P.bins + 1;
  for (let t = 0; t < P.trees; t++) {
    for (let i = 0; i < n; i++) {
      const pr = sigmoid(F[i]!);
      g[i] = weight[i]! * (pr - y[i]!);
      h[i] = weight[i]! * Math.max(pr * (1 - pr), 1e-6);
    }
    const rows: number[] = [];
    for (let i = 0; i < n; i++) if (rand() < P.subsample) rows.push(i);
    const nodes: Node[] = [];
    const grow = (idx: number[], depth: number): number => {
      let G = 0;
      let H = 0;
      for (const i of idx) {
        G += g[i]!;
        H += h[i]!;
      }
      const at = nodes.push({ v: (-G / (H + P.lambda)) * P.learningRate }) - 1;
      if (depth >= P.depth || H < 2 * P.minChild) return at;
      let best = { gain: 0, f: -1, b: -1 };
      const parent = (G * G) / (H + P.lambda);
      const hg = new Float64Array(nb);
      const hh = new Float64Array(nb);
      for (let j = 0; j < p; j++) {
        hg.fill(0);
        hh.fill(0);
        for (const i of idx) {
          const b = binned[i * p + j]!;
          hg[b] = hg[b]! + g[i]!;
          hh[b] = hh[b]! + h[i]!;
        }
        let gl = 0;
        let hl = 0;
        for (let b = 0; b < edges[j]!.length; b++) {
          gl += hg[b]!;
          hl += hh[b]!;
          const gr = G - gl;
          const hr = H - hl;
          if (hl < P.minChild || hr < P.minChild) continue;
          const gain = (gl * gl) / (hl + P.lambda) + (gr * gr) / (hr + P.lambda) - parent;
          if (gain > best.gain) best = { gain, f: j, b };
        }
      }
      if (best.f < 0) return at;
      const left: number[] = [];
      const right: number[] = [];
      for (const i of idx) (binned[i * p + best.f]! <= best.b ? left : right).push(i);
      const node = nodes[at]!;
      node.f = best.f;
      node.t = edges[best.f]![best.b]!;
      node.l = grow(left, depth + 1);
      node.r = grow(right, depth + 1);
      return at;
    };
    grow(rows, 0);
    for (let i = 0; i < n; i++) F[i] = F[i]! + leaf(nodes, X[i]!);
    trees.push(nodes);
  }
  return { features, base, trees, params: P };
}

function leaf(nodes: Node[], x: number[]) {
  let k = 0;
  for (;;) {
    const nd = nodes[k]!;
    if (nd.f === undefined) return nd.v;
    k = x[nd.f]! <= nd.t! ? nd.l! : nd.r!;
  }
}

/** The model's log-odds for one row. */
export function raw(m: Gbm, x: number[]) {
  let s = m.base;
  for (const tr of m.trees) s += leaf(tr, x);
  return s;
}

export const predict = (m: Gbm, x: number[]) => sigmoid(raw(m, x));

/** What each feature added to the log-odds, from the root to the leaf of every tree. They sum to raw - base - the trees' root values. */
export function contributions(m: Gbm, x: number[]) {
  const out = new Float64Array(m.features.length);
  for (const tr of m.trees) {
    let k = 0;
    for (;;) {
      const nd = tr[k]!;
      if (nd.f === undefined) break;
      const next = x[nd.f]! <= nd.t! ? nd.l! : nd.r!;
      out[nd.f] = out[nd.f]! + tr[next]!.v - nd.v;
      k = next;
    }
  }
  return out;
}

/** How often each feature is split on, weighted by the trees: a rough importance. */
export function importance(m: Gbm) {
  const out = new Float64Array(m.features.length);
  for (const tr of m.trees) for (const nd of tr) if (nd.f !== undefined) out[nd.f] = out[nd.f]! + Math.abs(tr[nd.l!]!.v - nd.v) + Math.abs(tr[nd.r!]!.v - nd.v);
  const total = out.reduce((s, v) => s + v, 0) || 1;
  return m.features.map((f, j) => ({ feature: f, share: out[j]! / total })).sort((a, b) => b.share - a.share);
}

// ---- measuring a model ----------------------------------------------------------------------------

/** Area under the ROC curve: the chance a random positive scores above a random negative. */
export function auc(scores: number[], y: number[]) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  let rank = 0;
  let sumPos = 0;
  let pos = 0;
  for (let k = 0; k < idx.length; ) {
    let e = k;
    while (e + 1 < idx.length && scores[idx[e + 1]!] === scores[idx[k]!]) e++;
    const avg = (k + e) / 2 + 1;
    for (let q = k; q <= e; q++) if (y[idx[q]!]) {
      sumPos += avg;
      pos++;
    }
    rank = e + 1;
    k = rank;
  }
  const neg = idx.length - pos;
  return pos && neg ? (sumPos - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}

/** Of everyone who left, the share in the top `share` of scores, and how many times the base rate that is. */
export function capture(scores: number[], y: number[], share = 0.1) {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]!);
  const top = Math.max(1, Math.round(idx.length * share));
  const pos = y.reduce((s, v) => s + v, 0);
  const caught = idx.slice(0, top).reduce((s, i) => s + y[i]!, 0);
  return { captured: pos ? caught / pos : 0, lift: pos ? caught / top / (pos / idx.length) : 0 };
}

/** Population stability index between a baseline's shares and a sample's, over the same cut points. */
export function psi(edges: number[], baseline: number[], values: number[]) {
  const counts = new Array<number>(edges.length + 1).fill(0);
  for (const v of values) counts[binOf(edges, v)]! += 1;
  let out = 0;
  for (let b = 0; b < counts.length; b++) {
    const a = Math.max(baseline[b] ?? 0, 1e-4);
    const c = Math.max(counts[b]! / Math.max(values.length, 1), 1e-4);
    out += (c - a) * Math.log(c / a);
  }
  return out;
}

/** Decile cut points and each bin's share, for drift checks later. */
export function profileOf(values: number[]) {
  const edges = cuts(values, 10);
  const counts = new Array<number>(edges.length + 1).fill(0);
  for (const v of values) counts[binOf(edges, v)]! += 1;
  return { edges, shares: counts.map((c) => c / Math.max(values.length, 1)) };
}
