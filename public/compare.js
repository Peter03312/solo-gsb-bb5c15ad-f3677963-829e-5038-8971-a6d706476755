/*
 * 已发布版本亮度比较引擎（纯函数，无副作用）
 * 浏览器与 Node 共用：浏览器挂到 window.VersionCompare，Node 通过 module.exports 引入。
 *
 * 不做固定间隔采样：每盏灯在一版中的亮度是关于时间的分段线性函数
 * （Cue 触发点为渐变起点/瞬变跳变点，渐变结束点为斜率折点）。把两版的
 * 事件点合并后，每个开区间内两版亮度均为线性，其差 g(t)=a·t+b 也是线性，
 * |g(t)| 与阈值 T 的交点可直接求根解析得到，从而严格、精确地界定“差值 > T”
 * 的连续区间及其端点包含性。
 *
 * 端点规则：
 *  - 渐变交点处差值恰为阈值（严格大于不成立）→ 端点排除；
 *  - 瞬变（duration=0）触发瞬间取触发后亮度，故跳变点是否纳入按触发后差值判定；
 *  - 时窗边界按该点实际差值判定。
 * 仅按灯具编号匹配；只存在于一版的灯具作为配置差异返回，缺失不等于熄灭。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.VersionCompare = factory(root.LightingEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  const EPS = 1e-9; // 浮点容差：交点吸附、阈值贴边判定

  function round6(v) {
    const r = Math.round(v * 1e6) / 1e6;
    return Object.is(r, -0) ? 0 : r;
  }

  function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  // 宽松数字转换（与服务器 toNum 一致）：有限数字或可解析的数字字符串通过
  function toNum(v) {
    if (typeof v === 'number') return isNum(v) ? v : NaN;
    if (typeof v === 'string' && v.trim() !== '' && v.trim() !== '-') {
      const n = Number(v);
      return isNum(n) ? n : NaN;
    }
    return NaN;
  }

  /**
   * 校验比较参数：时窗为非负秒数且起点 <= 终点；查看时刻须落在时窗内；
   * 阈值须为 0～100 的数字。错误直接抛出中文异常，由上层映射为 400。
   * 接受数字或数字字符串（query 参数天然是字符串），原样回显非法输入。
   */
  function validateCompareParams(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new Error('比较参数必须是一个对象');
    }

    const needNum = (raw, name, { nonNeg = false } = {}) => {
      const n = toNum(raw);
      if (Number.isNaN(n)) throw new Error(`${name}无效：${JSON.stringify(raw)}（须为数字秒数）`);
      if (nonNeg && n < 0) throw new Error(`${name}：${n}（不得为负）`);
      return n;
    };

    const start = needNum(p.start, '时窗起点', { nonNeg: true });
    const end = needNum(p.end, '时窗终点', { nonNeg: true });
    if (start > end) {
      throw new Error(`时窗起点（${round6(start)}）不能大于终点（${round6(end)}）`);
    }
    const at = needNum(p.at, '查看时刻');
    if (at < start - EPS || at > end + EPS) {
      throw new Error(
        `查看时刻 ${round6(at)} 越界：须在时窗 [${round6(start)}, ${round6(end)}] 内`
      );
    }

    const threshold = toNum(p.threshold);
    if (Number.isNaN(threshold)) {
      throw new Error(`亮度差阈值无效：${JSON.stringify(p.threshold)}（须为 0～100 的数字）`);
    }
    if (threshold < 0 || threshold > 100) {
      throw new Error(`亮度差阈值越界：${threshold}（须在 0～100 之间）`);
    }
    return { start, end, at, threshold };
  }

  /* --------- 基于 engine 段（prepareCues 产物）的分段取值工具 --------- */

  // t 时刻“生效中”的段（触发时刻 <= t 的最后一条；同秒取编号最大者）
  function activeAt(segs, t) {
    let active = null;
    for (const s of segs) {
      if (s.time > t) break;
      active = s;
    }
    return active;
  }

  // 段在 t 时刻的亮度（段须在 t 生效）
  function segValue(s, t) {
    if (!s) return 0;
    if (s.duration === 0 || t >= s.end) return s.target;
    const k = (t - s.time) / s.duration;
    return Engine.clamp(s.from + (s.target - s.from) * k);
  }

  // t 点左极限亮度（严格早于 t 的最后一条段在 t 的取值）：用于瞬变点左侧
  function preValueAt(segs, t) {
    let active = null;
    for (const s of segs) {
      if (s.time >= t) break;
      active = s;
    }
    if (!active) return 0;
    if (active.duration === 0 || t >= active.end) return active.target;
    const k = (t - active.time) / active.duration;
    return Engine.clamp(active.from + (active.target - active.from) * k);
  }

  /**
   * 在不含任何事件点的开区间 (L, R) 内，单侧亮度是一条直线（或常数）。
   * 返回 { v0, slope }，value(x) = v0 + slope·(x−L)。
   */
  function lineOnPiece(segs, L) {
    const s = activeAt(segs, L); // R 处的 Cue 在 L 之后，不影响 (L, R)
    if (!s) return { v0: 0, slope: 0 };
    if (s.duration === 0 || L >= s.end) return { v0: s.target, slope: 0 };
    return { v0: segValue(s, L), slope: (s.target - s.from) / s.duration };
  }

  // 某盏灯在时窗内部的全部事件点：Cue 触发点、渐变结束点（斜率折点）
  function eventTimes(segs, start, end) {
    const set = new Set();
    for (const s of segs) {
      if (s.time > start && s.time < end) set.add(s.time);
      if (s.duration > 0 && s.end > start && s.end < end) set.add(s.end);
    }
    return [...set].sort((a, b) => a - b);
  }

  function dedupeSorted(nums) {
    const out = [];
    for (const x of nums) {
      if (!out.length || Math.abs(x - out[out.length - 1]) > EPS) out.push(x);
    }
    return out;
  }

  /**
   * 整条时间轴上 |g(t)| = T 的全部根（解析求根，不采样）。
   * 单侧亮度分段线性，两版之差 g(t) 也是分段线性：逐线性片段求 g = ±T 的根，
   * 去重后返回落在 (start, end) 内的根。events 为合并后的事件点
   * （Cue 触发、渐变结束），每个相邻事件点之间 g 为一条直线。
   */
  function crossingRoots(segsA, segsB, start, end, events, T) {
    const pts = [start, ...events, end];
    const roots = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const L = pts[i];
      const R = pts[i + 1];
      if (R - L <= EPS) continue;
      const la = lineOnPiece(segsA, L);
      const lb = lineOnPiece(segsB, L);
      const g0 = la.v0 - lb.v0;
      const slope = la.slope - lb.slope;
      if (slope === 0) continue;
      for (const c of [T, -T]) {
        const x = L + (c - g0) / slope;
        if (x > L + EPS && x < R - EPS) roots.push(x);
      }
    }
    return dedupeSorted(roots.sort((a, b) => a - b));
  }

  /**
   * 由超阈开区域（由解析根/折点切分整窗得到）与“超阈点表”stamps 组装最终区间。
   * 开区域在切点/折点处相接时，仅当该点本身超阈（在 stamps 中）才连通，
   * 否则并集在该点有洞（差值恰为阈值），保持两个区间。
   * stamps 中没有落在任何开区域端点上的点（两侧都不超阈）构成零长度闭区间 [e,e]。
   * 注意：折点即使超阈也只是开区域的内部点，不应产生额外的零长度区间。
   */
  function finalizeIntervals(openRegions, stamps) {
    const sorted = openRegions
      .map((iv) => ({ start: iv.start, end: iv.end }))
      .sort((a, b) => a.start - b.start || a.end - b.end);

    const chains = [];
    for (const r of sorted) {
      const m = chains[chains.length - 1];
      if (m && r.start === m.end && stamps.has(r.start)) m.end = r.end;
      else chains.push({ ...r });
    }

    const out = chains.map((c) => ({
      start: c.start,
      end: c.end,
      startIncluded: stamps.has(c.start),
      endIncluded: stamps.has(c.end),
    }));

    // 所有开区域端点（连通前）已被某个区间覆盖（内部点或端点），只有不在其中的
    // 超阈点才是真正的孤立点 [e,e]。
    const covered = new Set();
    for (const r of sorted) {
      covered.add(r.start);
      covered.add(r.end);
    }
    for (const x of stamps) {
      if (!covered.has(x)) out.push({ start: x, end: x, startIncluded: true, endIncluded: true });
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return out;
  }

  /**
   * 单灯在时窗 [start,end] 内差值严格大于 T 的全部连续区间（解析计算，无采样）。
   * segsA/segsB 为两版 prepareCues 后、按灯过滤出的段。
   *
   * 思路：合并两版事件点（Cue 触发、渐变结束）；事件点之间两侧亮度均为线性，
   * 差 g(t) 线性，|g|=T 逐段解析求根，整窗被“根 + 事件点”切成开区域，取中点
   * 判定是否超阈；事件点/边界点是否纳入只看该点实际差值（瞬变取触发后亮度）。
   * 孤立超阈点构成零长度闭区间 [e, e]。
   */
  function analyzeLight(segsA, segsB, start, end, T) {
    const events = dedupeSorted(
      eventTimes(segsA, start, end).concat(eventTimes(segsB, start, end))
    );
    const post = (x) =>
      Math.abs(segValue(activeAt(segsA, x), x) - segValue(activeAt(segsB, x), x));
    const pre = (x) => Math.abs(preValueAt(segsA, x) - preValueAt(segsB, x));

    // 差值分段线性（事件点可能瞬变跳变），任意区间上的最大差只可能出现在
    // 这些断点（左极限/实际取值），解析取得，无需采样。
    const samples = [{ x: start, v: post(start) }];
    for (const e of events) samples.push({ x: e, v: pre(e) }, { x: e, v: post(e) });
    samples.push({ x: end, v: post(end) });
    const maxAbsDiff = samples.reduce((m, s) => Math.max(m, s.v), 0);

    // 超阈点表：时窗边界 + 内部事件点（按该点实际/触发后亮度判定）
    const stamps = new Set();
    if (post(start) > T + EPS) stamps.add(start);
    for (const e of events) {
      if (post(e) > T + EPS) stamps.add(e);
    }
    if (post(end) > T + EPS) stamps.add(end);

    // 整窗切分点：解析交点 + 内部事件点（折点/跳变点）
    const roots = crossingRoots(segsA, segsB, start, end, events, T);
    const cuts = dedupeSorted([...roots, ...events].sort((a, b) => a - b));
    const boundaries = [start, ...cuts, end];

    // 每个开片段取中点判定差值是否严格大于阈值（片段内无线性折点）
    const openRegions = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const L = boundaries[i];
      const R = boundaries[i + 1];
      if (R - L <= EPS) continue;
      const mid = (L + R) / 2;
      if (post(mid) > T + EPS) openRegions.push({ start: L, end: R });
    }

    const maxOn = (s, e) => {
      let m = 0;
      for (const z of samples) {
        if (z.x >= s - EPS && z.x <= e + EPS && z.v > m) m = z.v;
      }
      return round6(m);
    };

    const intervals = finalizeIntervals(openRegions, stamps).map((iv) => ({
      start: round6(iv.start),
      end: round6(iv.end),
      start_included: iv.startIncluded,
      end_included: iv.endIncluded,
      max_abs_diff: maxOn(iv.start, iv.end),
    }));
    return { intervals, maxAbsDiff: round6(maxAbsDiff) };
  }

  /**
   * 比较两个已发布版本快照。
   * snap: { id, label, lights: [{id,name}], cues: [{cue_no,light_id,time,target,duration}] }
   * 参数非法抛 Error（中文信息）；版本是否存在由调用方（服务器）负责。
   */
  function compareSnapshots(snapA, snapB, paramsRaw) {
    const { start, end, at, threshold } = validateCompareParams(paramsRaw);

    const cuesA = Engine.prepareCues(snapA.cues);
    const cuesB = Engine.prepareCues(snapB.cues);
    const segsFor = (ordered, id) => ordered.filter((s) => s.lightId === id);

    const lightsA = new Map(snapA.lights.map((l) => [l.id, l.name]));
    const lightsB = new Map(snapB.lights.map((l) => [l.id, l.name]));
    const idsA = new Set(lightsA.keys());
    const idsB = new Set(lightsB.keys());

    const common = [...idsA].filter((id) => idsB.has(id)).sort((a, b) => a - b);
    const onlyA = [...idsA].filter((id) => !idsB.has(id)).sort((a, b) => a - b);
    const onlyB = [...idsB].filter((id) => !idsA.has(id)).sort((a, b) => a - b);

    // 查看时刻：仅共有灯具逐灯对比
    const brightnesses = common.map((id) => {
      const a = Engine.brightnessAt(cuesA, id, at);
      const b = Engine.brightnessAt(cuesB, id, at);
      return {
        light_id: id,
        name_a: lightsA.get(id),
        name_b: lightsB.get(id),
        brightness_a: round6(a),
        brightness_b: round6(b),
        abs_diff: round6(Math.abs(a - b)),
      };
    });

    // 时窗内各共有灯具的超阈连续区间（零长度时窗不产生区间）
    const zeroLength = start === end;
    const intervals = [];
    if (!zeroLength) {
      for (const id of common) {
        const { intervals: ivs } = analyzeLight(
          segsFor(cuesA, id),
          segsFor(cuesB, id),
          start,
          end,
          threshold
        );
        for (const iv of ivs) {
          intervals.push({
            light_id: id,
            name_a: lightsA.get(id),
            name_b: lightsB.get(id),
            ...iv,
          });
        }
      }
      intervals.sort((a, b) => a.light_id - b.light_id || a.start - b.start);
    }

    // 配置差异：只存在于一版的灯具单列；缺失不当作熄灭
    // （brightness_at 仅为该版本自身在查看时刻的亮度，便于展示）
    const configDifferences = [
      ...onlyA.map((id) => ({
        light_id: id,
        present_in: 'a',
        name: lightsA.get(id),
        brightness_at: round6(Engine.brightnessAt(cuesA, id, at)),
      })),
      ...onlyB.map((id) => ({
        light_id: id,
        present_in: 'b',
        name: lightsB.get(id),
        brightness_at: round6(Engine.brightnessAt(cuesB, id, at)),
      })),
    ];

    return {
      versions: {
        a: { id: snapA.id, label: snapA.label },
        b: { id: snapB.id, label: snapB.label },
      },
      window: { start: round6(start), end: round6(end), zero_length: zeroLength },
      at: round6(at),
      threshold,
      brightnesses,
      intervals,
      config_differences: configDifferences,
    };
  }

  return {
    validateCompareParams,
    analyzeLight,
    compareSnapshots,
    _internals: { activeAt, segValue, preValueAt, crossingRoots, finalizeIntervals },
  };
});
