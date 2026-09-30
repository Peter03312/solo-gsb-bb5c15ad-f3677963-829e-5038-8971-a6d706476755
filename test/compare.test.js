'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Compare = require('../public/compare.js');

const snap = (id, lights, cues, label = `v${id}`) => ({ id, label, lights, cues });
const L = (ids) => ids.map((id) => ({ id, name: `灯${id}` }));
const P = (start, end, at, threshold) => ({ start, end, at, threshold });
const approxEq = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !=~ ${b}`);

// 基础两版：
//  A：灯1 t=0 从 0 线性渐变到 100，用时 10（A(t)=10t，t∈[0,10]，之后保持 100）
//  B：灯1 无 Cue，恒为 0
const A = snap(1, L([1]), [{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }]);
const B = snap(2, L([1]), []);

test('渐变中途越过阈值：交点解析精确，阈值点排除、时窗边界按实际差值包含', () => {
  // d(t)=10t，阈值 30，时窗 [0,100]：交点 t=3 排除，终点差 100 含 → (3, 100]
  const r = Compare.compareSnapshots(A, B, P(0, 100, 0, 30));
  assert.equal(r.intervals.length, 1);
  const iv = r.intervals[0];
  approxEq(iv.start, 3);
  assert.equal(iv.end, 100);
  assert.equal(iv.start_included, false);
  assert.equal(iv.end_included, true);
});

test('查看时刻逐灯亮度；相同两个版本可比较且无差异返回空区间', () => {
  const r = Compare.compareSnapshots(A, A, P(0, 10, 5, 10));
  const row = r.brightnesses.find((x) => x.light_id === 1);
  assert.equal(row.brightness_a, 50);
  assert.equal(row.brightness_b, 50);
  assert.equal(row.abs_diff, 0);
  assert.equal(r.intervals.length, 0);
});

test('阈值为 0：差值恰为 0 的时刻排除（严格大于）', () => {
  // d(t)=10t，时窗 [0,10]：仅起点差为 0 → (0, 10]
  const r = Compare.compareSnapshots(A, B, P(0, 10, 2, 0));
  assert.equal(r.intervals.length, 1);
  const iv = r.intervals[0];
  assert.deepEqual(
    [iv.start, iv.start_included, iv.end, iv.end_included],
    [0, false, 10, true]
  );
  assert.equal(r.brightnesses[0].brightness_a, 20);
  assert.equal(r.brightnesses[0].brightness_b, 0);
  assert.equal(r.brightnesses[0].abs_diff, 20);
});

test('整段恒超阈：两端闭合；区间最大差取该区间断点值', () => {
  // d(t)=10t，阈值 40，时窗 [50(窗裁剪后 d=100 保持), 80] —— 起点取 t=0 更直观：
  // 用阈值 40、时窗 [5, 8]：d 从 50 到 80，恒 >40
  const r = Compare.compareSnapshots(A, B, P(5, 8, 6, 40));
  assert.equal(r.intervals.length, 1);
  const iv = r.intervals[0];
  assert.deepEqual([iv.start, iv.end], [5, 8]);
  assert.deepEqual([iv.start_included, iv.end_included], [true, true]);
  assert.equal(iv.max_abs_diff, 80);
});

test('V 形差值：中途接管折点两侧超阈区按解析交点界定并在折点缝合', () => {
  // A: 0→100/d10（t=10 接管）→0/d10，即 A=10t（[0,10]）、A=200-10t（[10,20]）
  // B: 恒 50。阈值 10，时窗 [0,20]：
  //   [0,10] d=|10t-50|>10 → [0,4) 与 (6,10]
  //   [10,20] d=|150-10t|>10 → [10,14) 与 (16,20]
  //   (6,10] 与 [10,14) 在 t=10（差 50，含）相接 → 合并为 (6,14)
  const sA = snap(1, L([1]), [
    { cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 },
    { cue_no: 2, light_id: 1, time: 10, target: 0, duration: 10 },
  ]);
  const sB = snap(2, L([1]), [{ cue_no: 1, light_id: 1, time: 0, target: 50, duration: 0 }]);
  const r = Compare.compareSnapshots(sA, sB, P(0, 20, 10, 10));
  assert.equal(r.intervals.length, 3);
  const [i1, i2, i3] = r.intervals;
  assert.deepEqual(
    [i1.start, i1.start_included, i1.end, i1.end_included],
    [0, true, 4, false]
  );
  assert.deepEqual(
    [i2.start, i2.start_included, i2.end, i2.end_included],
    [6, false, 14, false]
  );
  assert.deepEqual(
    [i3.start, i3.start_included, i3.end, i3.end_included],
    [16, false, 20, true]
  );
  for (const iv of r.intervals) assert.equal(iv.max_abs_diff, 50);
});

test('交点恰落在时窗边界且差值等于阈值：该端点排除', () => {
  // B 恒 20；d=|10t-20|，阈值 30，时窗 [0,5]：d>30 需 t>5，窗内空
  const sB = snap(2, L([1]), [{ cue_no: 1, light_id: 1, time: 0, target: 20, duration: 0 }]);
  const r = Compare.compareSnapshots(A, sB, P(0, 5, 0, 30));
  assert.equal(r.intervals.length, 0);

  // 时窗终点取 t=6：交点 t=5 在窗内部且排除 → (5, 6]
  const r2 = Compare.compareSnapshots(A, sB, P(0, 6, 0, 30));
  assert.equal(r2.intervals.length, 1);
  approxEq(r2.intervals[0].start, 5);
  assert.equal(r2.intervals[0].start_included, false);
  assert.equal(r2.intervals[0].end_included, true);
});

test('瞬变 Cue：触发瞬间按触发后亮度判定区间起点包含性', () => {
  // A 恒 0；B t=5 瞬变到 50 并保持。阈值 40，时窗 [0,6]：t=5 前差 0，t=5 起差 50
  // 左极限差 0（不含），实际差 50（含）→ [5, 6]
  const sA = snap(1, L([1]), []);
  const sB = snap(2, L([1]), [{ cue_no: 1, light_id: 1, time: 5, target: 50, duration: 0 }]);
  const r = Compare.compareSnapshots(sA, sB, P(0, 6, 5, 40));
  assert.equal(r.intervals.length, 1);
  assert.deepEqual(
    [r.intervals[0].start, r.intervals[0].start_included, r.intervals[0].end, r.intervals[0].end_included],
    [5, true, 6, true]
  );
});

test('瞬变恰好发生在时窗终点：退化为端点闭合的零长度区间 [e, e]', () => {
  // A 恒 0；B t=5 瞬变 50。阈值 40，时窗 [0,5]：窗内 t<5 差 0，仅终点 t=5 差 50
  const sA = snap(1, L([1]), []);
  const sB = snap(2, L([1]), [{ cue_no: 1, light_id: 1, time: 5, target: 50, duration: 0 }]);
  const r = Compare.compareSnapshots(sA, sB, P(0, 5, 5, 40));
  assert.equal(r.intervals.length, 1);
  const iv = r.intervals[0];
  assert.equal(iv.start, 5);
  assert.equal(iv.end, 5);
  assert.equal(iv.start_included, true);
  assert.equal(iv.end_included, true);
  assert.equal(iv.max_abs_diff, 50);
});

test('瞬变点两侧区域在该点相接：点含则合并，点不含则断开', () => {
  // A 恒 50；B t=5 瞬变 0→保持。d: t<5 为 50，t>=5 为 50（两侧都超）→ 点含，合并
  const sA = snap(1, L([1]), [{ cue_no: 1, light_id: 1, time: 0, target: 50, duration: 0 }]);
  const sB = snap(2, L([1]), [{ cue_no: 1, light_id: 1, time: 5, target: 0, duration: 0 }]);
  const r = Compare.compareSnapshots(sA, sB, P(0, 10, 0, 10));
  assert.equal(r.intervals.length, 1);
  assert.deepEqual([r.intervals[0].start, r.intervals[0].end], [0, 10]);
});

test('瞬变后差值持续：超阈跳变点并入右侧开区域（右连续，内部不可能孤立成点）', () => {
  // A：t=0 置 20、t=5 瞬变到 0；B：t=5 瞬变到 21。阈值 20。
  //   t<5：d=20 恰贴阈值（不超）；t=5 起 A=0、B=21，d=21 且持续 → 区间 [5,10]
  const sA = snap(1, L([1]), [
    { cue_no: 1, light_id: 1, time: 0, target: 20, duration: 0 },
    { cue_no: 2, light_id: 1, time: 5, target: 0, duration: 0 },
  ]);
  const sB = snap(2, L([1]), [
    { cue_no: 1, light_id: 1, time: 5, target: 21, duration: 0 },
  ]);
  const r = Compare.compareSnapshots(sA, sB, P(0, 10, 5, 20));
  assert.equal(r.intervals.length, 1);
  const iv = r.intervals[0];
  assert.deepEqual([iv.start, iv.end], [5, 10]);
  assert.equal(iv.start_included, true);
  assert.equal(iv.end_included, true);
  assert.equal(iv.max_abs_diff, 21);
});

test('finalizeIntervals 拓扑：孤立超阈点给 [e,e]；折点不产生多余单点', () => {
  const fin = Compare._internals.finalizeIntervals;
  // 孤立点
  assert.deepEqual(
    fin([], new Set([5])).map((iv) => [iv.start, iv.end, iv.startIncluded, iv.endIncluded]),
    [[5, 5, true, true]]
  );
  // 折点 5 是两个开区域的公共端点且在 stamps：连通为一条，端点取 stamps
  const merged = fin([{ start: 3, end: 5 }, { start: 5, end: 10 }], new Set([5, 10]));
  assert.equal(merged.length, 1);
  assert.deepEqual([merged[0].start, merged[0].end], [3, 10]);
  assert.deepEqual([merged[0].startIncluded, merged[0].endIncluded], [false, true]);
  // 折点不在 stamps（差值恰为阈值）：在该点断开为两个区间，端点均不含
  const split = fin([{ start: 0, end: 5 }, { start: 5, end: 9 }], new Set());
  assert.equal(split.length, 2);
  assert.deepEqual([split[0].endIncluded, split[1].startIncluded], [false, false]);
});

test('配置差异：仅一版存在的灯具单列，缺失不当作熄灭', () => {
  const sA = snap(1, L([1, 2]), []);
  const sB = snap(2, L([2, 3]), []);
  const r = Compare.compareSnapshots(sA, sB, P(0, 10, 3, 0));
  assert.deepEqual(r.brightnesses.map((x) => x.light_id), [2]); // 仅共有灯逐灯对比
  assert.deepEqual(
    r.config_differences.map((d) => [d.light_id, d.present_in]),
    [[1, 'a'], [3, 'b']]
  );
  // 配置差异灯具不在逐灯亮度对比中
  assert.equal(r.intervals.length, 0);
});

test('零长度时窗：只返回该时刻亮度，不产生区间（即使有差异）', () => {
  const r = Compare.compareSnapshots(A, B, P(7, 7, 7, 0));
  assert.equal(r.window.zero_length, true);
  assert.equal(r.intervals.length, 0);
  assert.equal(r.brightnesses[0].brightness_a, 70);
  assert.equal(r.brightnesses[0].brightness_b, 0);
  assert.equal(r.brightnesses[0].abs_diff, 70);
});

test('参数校验：起点大于终点、查看时刻越界、阈值越界、负数、无效数字', () => {
  assert.throws(() => Compare.compareSnapshots(A, B, P(10, 5, 7, 0)), /起点.*不能大于终点/);
  assert.throws(() => Compare.compareSnapshots(A, B, P(0, 10, 11, 0)), /查看时刻.*越界/);
  assert.throws(() => Compare.compareSnapshots(A, B, P(0, 10, -1, 0)), /查看时刻.*越界/);
  assert.throws(() => Compare.compareSnapshots(A, B, P(0, 10, 5, 101)), /阈值越界/);
  assert.throws(() => Compare.compareSnapshots(A, B, P(0, 10, 5, -0.01)), /阈值越界/);
  assert.throws(() => Compare.compareSnapshots(A, B, P(-1, 10, 0, 0)), /不得为负/);
  assert.throws(
    () => Compare.compareSnapshots(A, B, { start: 'x', end: 1, at: 0, threshold: 0 }),
    /时窗起点无效/
  );
  assert.throws(
    () => Compare.compareSnapshots(A, B, { start: 0, end: 1, at: 0, threshold: NaN }),
    /阈值无效/
  );
  assert.throws(
    () => Compare.compareSnapshots(A, B, { start: 0, end: 1, at: Infinity, threshold: 0 }),
    /查看时刻无效/
  );
});

test('多灯互不干扰：区间按灯分别给出', () => {
  // A: 灯1 0→100/d10；灯2 恒 0。B: 灯1 恒 0；灯2 0→100/d10（t=0 起）。
  const sA = snap(1, L([1, 2]), [
    { cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 },
  ]);
  const sB = snap(2, L([1, 2]), [
    { cue_no: 2, light_id: 2, time: 0, target: 100, duration: 10 },
  ]);
  const r = Compare.compareSnapshots(sA, sB, P(0, 10, 5, 50));
  // 两灯 d=10t，阈值 50 → (5,10]
  assert.equal(r.intervals.length, 2);
  assert.deepEqual(r.intervals.map((iv) => iv.light_id), [1, 2]);
  for (const iv of r.intervals) {
    assert.equal(iv.start_included, false);
    assert.equal(iv.end_included, true);
  }
});
