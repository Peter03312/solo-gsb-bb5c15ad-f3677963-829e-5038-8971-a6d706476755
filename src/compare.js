'use strict';

/*
 * 两版快照逐灯亮度比较（纯函数，无依赖，仅读取已发布快照，不触碰草稿/播放会话）。
 *
 * 核心思路：把每盏灯在每个版本里的亮度重建成“精确的分段线性函数”（瞬变表现为
 * 端点取值的右跳变），规则与 public/engine.js 完全一致——同秒 Cue 按编号顺序、
 * 瞬变先跳变、渐变中途接管、线性渐变。随后在两版分段函数的全部转折点（Cue 触发、
 * 渐变结束、瞬变点）之间逐个“板层”求解 |bA(t)-bB(t)| > threshold，阈值交点用
 * 一次线性方程精确求出，而不是按固定间隔采样。
 */

const EPS = 1e-9;

const lt = (a, b) => a < b - EPS;
const eq = (a, b) => Math.abs(a - b) <= EPS;
const clamp = (v) => (v < 0 ? 0 : v > 100 ? 100 : v);

/**
 * 为某一盏灯构建分段亮度函数。
 * 段 {from,to,a,b} 覆盖 [from, to)，亮度 = clamp(a*t + b)；触发点 t 的取值用
 * valueAt 取“最后一条已触发 Cue”语义，瞬变在触发点取跳变后的目标值（右连续）。
 */
function buildLightPieces(cues, lightId) {
  const mine = cues.filter((c) => c.lightId === lightId);
  mine.sort((c1, c2) => c1.time - c2.time || c1.cueNo - c2.cueNo);

  // 同一时刻多条 Cue：只有编号最大（最后生效）的一条决定该时刻及其后的状态
  const groups = [];
  for (const c of mine) {
    const g = groups[groups.length - 1];
    if (g && eq(g.time, c.time)) g.last = c;
    else groups.push({ time: c.time, last: c });
  }

  const pieces = [];
  // 当前活动段：渐变段（naturalEnd=渐变结束）或瞬变后的常量段（naturalEnd=触发时刻）
  let cur = null;
  let held = 0;

  for (const { time, last: c } of groups) {
    if (cur) {
      // 在下一条 Cue 触发点关闭上一段：渐变可能在此之前已自然结束
      const closeAt = Math.min(time, cur.naturalEnd);
      if (lt(cur.from, closeAt)) {
        cur.to = closeAt;
        pieces.push(cur);
      }
      // 渐变自然结束到新 Cue 之间：保持在目标（常量平台）
      if (lt(closeAt, time)) {
        pieces.push({ from: closeAt, to: time, a: 0, b: held });
      }
      cur = null;
    }
    if (c.duration === 0) {
      // 瞬变：该时刻取值即目标，其后为常量平台，等待下一条 Cue
      cur = { from: time, to: Infinity, a: 0, b: c.target, naturalEnd: time };
    } else {
      const a = (c.target - c.from) / c.duration;
      cur = { from: time, to: time + c.duration, a, b: c.from - a * time, naturalEnd: time + c.duration };
    }
    held = c.target;
  }
  if (cur) {
    const closeAt = cur.naturalEnd;
    if (lt(cur.from, closeAt)) {
      cur.to = closeAt;
      pieces.push(cur);
    }
    pieces.push({ from: closeAt, to: Infinity, a: 0, b: held });
  }

  // 点取值：触发时刻 <= t 的最后一条 Cue（瞬变取目标，渐变取段内插值/到达后取目标）
  const valueAt = (t) => {
    let lastCue = null;
    for (const c of mine) {
      if (c.time <= t + EPS) lastCue = c;
      else break;
    }
    if (!lastCue) return 0;
    if (lastCue.duration === 0 || t >= lastCue.time + lastCue.duration - EPS) {
      return lastCue.target;
    }
    const k = (t - lastCue.time) / lastCue.duration;
    return clamp(lastCue.from + (lastCue.target - lastCue.from) * k);
  };

  return { pieces, valueAt };
}

/** 把一份快照预处理成比较模型 */
function buildModel(snapshot) {
  const cues = snapshot.cues.map((c) => ({
    cueNo: c.cue_no,
    lightId: c.light_id,
    time: Number(c.time),
    target: clamp(Number(c.target)),
    duration: Number(c.duration),
    from: 0,
  }));
  cues.sort((a, b) => a.time - b.time || a.cueNo - b.cueNo);

  // 每条 Cue 触发瞬间的实际起始亮度（与 engine.prepareCues 同一套衔接规则）
  const last = new Map();
  for (const seg of cues) {
    const prev = last.get(seg.lightId);
    if (!prev) {
      seg.from = 0; // 该灯第一条 Cue：从熄灭起步
    } else if (seg.time > prev.time + EPS) {
      if (seg.time >= prev.time + prev.duration - EPS || prev.duration === 0) {
        seg.from = prev.target;
      } else {
        // 中途接管：取上一渐变在新 Cue 触发时刻的实际亮度
        const k = (seg.time - prev.time) / prev.duration;
        seg.from = clamp(prev.from + (prev.target - prev.from) * k);
      }
    } else {
      // 同刻触发（已按编号排序）：瞬变先跳到目标；普通渐变此刻尚未变化
      seg.from = prev.duration === 0 ? prev.target : prev.from;
    }
    last.set(seg.lightId, seg);
  }

  const lights = new Map();
  for (const l of snapshot.lights) lights.set(l.id, buildLightPieces(cues, l.id));
  return { cues, lights };
}

/** 找到 t 所在的开区间段（from <= t < to，EPS 容差）；瞬变平台上返回 null（常量） */
function pieceAt(pieces, t) {
  for (const p of pieces) {
    if (t >= p.from - EPS && t < p.to - EPS) return p;
  }
  return null;
}

/**
 * 精确求解开区间 (x0, x1) 内 |a t + b| > threshold 的部分。
 * 线性绝对值的超阈集至多是两条“尾巴”，在板层内可能有 0/1/2 个互不相交的部分，
 * 因此返回数组（不能取并集最小/最大端点，否则会错误跨过中间的低差区）。
 */
function solveAbsAbove(a, b, threshold, x0, x1) {
  if (x1 - x0 <= EPS) return [];
  const out = [];
  const clip = (r0, r1) => {
    const s = Math.max(r0, x0);
    const e = Math.min(r1, x1);
    if (s < e - EPS) out.push({ lo: s, hi: e });
  };
  if (Math.abs(a) <= EPS) {
    if (Math.abs(b) > threshold + EPS) clip(x0, x1);
  } else if (a > 0) {
    clip((threshold - b) / a, Infinity); // at+b > thr
    clip(-Infinity, (-threshold - b) / a); // at+b < -thr
  } else {
    clip(-Infinity, (threshold - b) / a);
    clip((-threshold - b) / a, Infinity);
  }
  return out;
}

/** 收集模型中落在 (t0,t1) 内部的全部转折时刻 */
function breakpointsOf(model, lightId, t0, t1) {
  const xs = [];
  for (const p of model.lights.get(lightId).pieces) {
    for (const x of [p.from, p.to]) {
      if (x > t0 + EPS && x < t1 - EPS && isFinite(x)) xs.push(x);
    }
  }
  return xs;
}

/** 排序并把浮点上重合的时刻聚成一簇（取最小值，保证板层不重叠） */
function clusterTimes(values) {
  values.sort((x, y) => x - y);
  const out = [];
  for (const x of values) {
    const lastX = out[out.length - 1];
    if (lastX === undefined || Math.abs(x - lastX) > 1e-7) out.push(x);
  }
  return out;
}

/**
 * 计算一盏“两版共有”的灯在 [t0,t1] 内亮度差严格大于阈值的连续区间。
 * 返回 [{start,end,start_included,end_included,max_diff}]（已排序、相邻已合并）。
 */
function diffIntervals(modelA, modelB, lightId, t0, t1, threshold) {
  const pa = modelA.lights.get(lightId);
  const pb = modelB.lights.get(lightId);
  const evalDiff = (t) => Math.abs(pa.valueAt(t) - pb.valueAt(t));

  // 开区间段令牌：端点一定不包含（阈值为严格大于，交点本身不取）
  const open = [];
  // 单点令牌：每个板层端点（含时窗端点），按该点“实际亮度差”判定包含性
  const points = [];

  // ---- 板层内部：两函数都为线性，精确求解 |a t+b| > threshold ----
  const inner = clusterTimes([
    ...breakpointsOf(modelA, lightId, t0, t1),
    ...breakpointsOf(modelB, lightId, t0, t1),
  ]);
  const bounds = [t0, ...inner, t1];
  for (let i = 0; i < bounds.length - 1; i++) {
    const x0 = bounds[i];
    const x1 = bounds[i + 1];
    if (x1 - x0 <= EPS) continue;
    const mid = (x0 + x1) / 2;
    const ca = pieceAt(pa.pieces, mid);
    const cb = pieceAt(pb.pieces, mid);
    // 开区间段为线性 a*t+b；首条 Cue 之前（无段）为常量 0
    const va = ca ? ca.a * mid + ca.b : 0;
    const vb = cb ? cb.a * mid + cb.b : 0;
    const a = (ca ? ca.a : 0) - (cb ? cb.a : 0);
    const b = va - vb - a * mid;
    const parts = solveAbsAbove(a, b, threshold, x0, x1);
    for (const r of parts) {
      // 板层端点处的真实差（可能是另一板层在该点的取值）；交点在板层内部，线性式精确
      open.push({
        lo: r.lo,
        hi: r.hi,
        peak: Math.max(evalDiff(r.lo), evalDiff(r.hi)),
      });
    }
  }
  for (const x of bounds) points.push({ t: x, included: evalDiff(x) > threshold + EPS });

  // ---- 线性扫描：按时间合并开区间与端点，跨越超阈端点时拼接相邻板层 ----
  open.sort((p, q) => p.lo - q.lo || q.hi - p.hi);
  points.sort((p, q) => p.t - q.t);
  const pointAt = (t) => points.find((p) => Math.abs(p.t - t) <= 1e-7);

  const intervals = [];
  let oi = 0;
  while (oi < open.length) {
    const first = open[oi++];
    const cur = {
      start: first.lo,
      end: first.hi,
      start_included: false, // 开区间左端点（阈值交点）一律不包含
      end_included: false,
      max_diff: first.peak,
    };
    const ps = pointAt(cur.start);
    if (ps) cur.start_included = ps.included; // 时窗起点落在超阈区时包含

    // 不断并入“左端点恰好等于当前右端点”的相邻板层超阈开区间；
    // 中间断点自身的超阈与否决定了两侧是否连通（Cue 触发时刻按实际右取值判定）
    for (;;) {
      const atEnd = pointAt(cur.end);
      const bridge = atEnd && atEnd.included;
      const next = open[oi];
      if (bridge && next && Math.abs(next.lo - cur.end) <= 1e-7) {
        oi++;
        cur.end = next.hi;
        cur.max_diff = Math.max(cur.max_diff, next.peak);
        continue;
      }
      break;
    }
    const pe = pointAt(cur.end);
    if (pe) cur.end_included = pe.included;
    intervals.push(cur);
  }

  // ---- 未被任何开区间覆盖、但自身严格超阈的孤立点（如时窗终点恰遇瞬变跳变）----
  const covered = new Set();
  for (const itv of intervals) {
    for (const p of points) {
      if (p.t >= itv.start - 1e-7 && p.t <= itv.end + 1e-7) {
        covered.add(p.t.toFixed(12));
      }
    }
  }
  for (const p of points) {
    if (p.included && !covered.has(p.t.toFixed(12))) {
      intervals.push({
        start: p.t,
        end: p.t,
        start_included: true,
        end_included: true,
        max_diff: evalDiff(p.t),
      });
    }
  }

  intervals.sort((x, y) => x.start - y.start);
  return intervals.map((r) => ({
    start: round9(r.start),
    end: round9(r.end),
    start_included: r.start_included,
    end_included: r.end_included,
    max_diff: round9(clamp(r.max_diff)),
  }));
}

function round9(v) {
  const r = Math.round(v * 1e9) / 1e9;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * 比较两份已发布版本快照（只读）。
 * snapshot: { id,label, lights:[{id,name}], cues:[{cue_no,light_id,time,target,duration}] }
 * 参数已由路由层校验：t0<=t1、t0<=view<=t1、0<=threshold<=100。
 */
function compareSnapshots(snapA, snapB, { t0, t1, view, threshold }) {
  const modelA = buildModel(snapA);
  const modelB = buildModel(snapB);

  const idsA = new Set(snapA.lights.map((l) => l.id));
  const idsB = new Set(snapB.lights.map((l) => l.id));
  const common = [...idsA].filter((id) => idsB.has(id)).sort((x, y) => x - y);
  const nameA = new Map(snapA.lights.map((l) => [l.id, l.name]));

  const level = (model, id, t) => round9(clamp(model.lights.get(id).valueAt(t)));

  const levels = common.map((id) => {
    const ba = level(modelA, id, view);
    const bb = level(modelB, id, view);
    return {
      light_id: id,
      light_name: nameA.get(id),
      brightness_a: ba,
      brightness_b: bb,
      diff: round9(Math.abs(ba - bb)),
    };
  });

  // 仅在一版存在的灯具单列为配置差异；缺失不等于熄灭，不参与亮度区间比较
  const config_diff = {
    only_in_a: snapA.lights
      .filter((l) => !idsB.has(l.id))
      .map((l) => ({ light_id: l.id, light_name: l.name }))
      .sort((x, y) => x.light_id - y.light_id),
    only_in_b: snapB.lights
      .filter((l) => !idsA.has(l.id))
      .map((l) => ({ light_id: l.id, light_name: l.name }))
      .sort((x, y) => x.light_id - y.light_id),
  };

  // 零长度时窗：只返回该时刻亮度，不产生任何区间
  let intervals = [];
  if (t1 - t0 > EPS) {
    intervals = common
      .map((id) => ({
        light_id: id,
        light_name: nameA.get(id),
        segments: diffIntervals(modelA, modelB, id, t0, t1, threshold),
      }))
      .filter((x) => x.segments.length > 0)
      .sort((x, y) => x.light_id - y.light_id);
  }

  return {
    version_a: { id: snapA.id, label: snapA.label },
    version_b: { id: snapB.id, label: snapB.label },
    window: { start: round9(t0), end: round9(t1) },
    view_time: round9(view),
    threshold,
    levels,
    config_diff,
    intervals,
  };
}

module.exports = { compareSnapshots, buildModel, buildLightPieces, diffIntervals, EPS };
