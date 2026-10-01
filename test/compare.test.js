'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../public/engine.js');
const { compareSnapshots, buildModel } = require('../src/compare.js');

const snap = (id, lights, cues, label = `v${id}`) => ({ id, label, lights, cues });
const light = (id, name = `L${id}`) => ({ id, name });
const cue = (cue_no, light_id, time, target, duration) => ({ cue_no, light_id, time, target, duration });

const seg = (r, i = 0) => r.intervals[0].segments[i];
const onlySegs = (r, lightId) => r.intervals.find((x) => x.light_id === lightId)?.segments ?? [];

function approx(actual, expected, eps = 1e-7) {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} !=~ ${expected}`);
}

test('简单线性渐变差：交点精确，阈值严格大于（交点端点不包含）', () => {
  // A: 灯1 在 [0,10] 从 0→100；B: 灯1 常量 0
  const a = snap(1, [light(1)], [cue(1, 1, 0, 100, 10)]);
  const b = snap(2, [light(1)], []);
  const r = compareSnapshots(a, b, { t0: 0, t1: 10, view: 0, threshold: 30 });
  // t > 3 时差严格 > 30；右端点 10 差值 100 > 30 包含
  assert.equal(r.intervals.length, 1);
  const s = seg(r);
  approx(s.start, 3);
  approx(s.end, 10);
  assert.equal(s.start_included, false); // 交点本身差=30，不取
  assert.equal(s.end_included, true);
  approx(s.max_diff, 100);
});

test('渐变结束后保持：区间可延伸到时窗内的常量平台', () => {
  const a = snap(1, [light(1)], [cue(1, 1, 0, 100, 10)]);
  const b = snap(2, [light(1)], []);
  const r = compareSnapshots(a, b, { t0: 0, t1: 20, view: 20, threshold: 50 });
  // t>5 起差>50，渐变 10 秒结束后保持 100，区间一直到时窗终点
  const s = seg(r);
  approx(s.start, 5);
  approx(s.end, 20);
  assert.equal(s.start_included, false);
  assert.equal(s.end_included, true);
});

test('反向渐变下降：差值先大后小，精确穿越阈值', () => {
  // A: 灯1 t=0 瞬变到 100，然后 [2,12] 100→0；B: 恒 0
  const a = snap(1, [light(1)], [cue(1, 1, 0, 100, 0), cue(2, 1, 2, 0, 10)]);
  const b = snap(2, [light(1)], []);
  const r = compareSnapshots(a, b, { t0: 0, t1: 12, view: 0, threshold: 40 });
  // [0,2] 差=100>40；下降沿在 t=8 差=40，故 (..,8) 超阈
  const s = seg(r);
  approx(s.start, 0);
  approx(s.end, 8);
  assert.equal(s.start_included, true); // 时窗起点差 100
  assert.equal(s.end_included, false); // 交点不取
});

test('瞬变 Cue 触发时刻：触发前常量一侧不算，触发点右取值计入（端点包含性）', () => {
  // A: t=5 瞬变 0→60；B: 恒 0；阈值 50
  const a = snap(1, [light(1)], [cue(1, 1, 5, 60, 0)]);
  const b = snap(2, [light(1)], []);
  const r = compareSnapshots(a, b, { t0: 0, t1: 10, view: 5, threshold: 50 });
  const s = seg(r);
  approx(s.start, 5);
  approx(s.end, 10);
  assert.equal(s.start_included, true); // t=5 右取值 60，差 60>50
  assert.equal(s.end_included, true);
});

test('时窗终点恰遇瞬变跳变：另一侧无超阈开区间时只给包含的单点区间', () => {
  // A: t=5 瞬变到 60；时窗 [0,5]，阈值 50。t<5 差=0，t=5 差=60
  const a = snap(1, [light(1)], [cue(1, 1, 5, 60, 0)]);
  const b = snap(2, [light(1)], []);
  const r = compareSnapshots(a, b, { t0: 0, t1: 5, view: 5, threshold: 50 });
  const s = seg(r);
  approx(s.start, 5);
  approx(s.end, 5);
  assert.equal(s.start_included, true);
  assert.equal(s.end_included, true);
});

test('瞬变反向：时窗终点处跳离超阈，则终点不包含', () => {
  // A: t=0 瞬变到 60，[0,5) 差=60；t=5 瞬变到 0；时窗 [0,5]
  const a = snap(1, [light(1)], [cue(1, 1, 0, 60, 0), cue(2, 1, 5, 0, 0)]);
  const b = snap(2, [light(1)], []);
  const r = compareSnapshots(a, b, { t0: 0, t1: 5, view: 0, threshold: 50 });
  const s = seg(r);
  approx(s.start, 0);
  approx(s.end, 5);
  assert.equal(s.start_included, true);
  assert.equal(s.end_included, false); // t=5 已跳回 0
});

test('同秒多条 Cue 按编号顺序：只有编号最大者决定该时刻亮度', () => {
  // t=2：编号 1 先 0→100（渐变），编号 2 同刻 0 时长渐变，接管自编号1起点亮度0
  const a = snap(
    1,
    [light(1)],
    [cue(1, 1, 2, 100, 10), cue(2, 1, 2, 0, 10)],
  );
  const b = snap(2, [light(1)], []);
  const r = compareSnapshots(a, b, { t0: 0, t1: 12, view: 2, threshold: 10 });
  // 编号 2 从 0 渐变到 0，整场恒 0 → 无差异
  assert.deepEqual(r.intervals, []);
});

test('同秒先瞬变后渐变：渐变从瞬变目标起步', () => {
  const a = snap(
    1,
    [light(1)],
    [cue(1, 1, 0, 80, 0), cue(2, 1, 0, 100, 10)],
  );
  const b = snap(2, [light(1)], []);
  const r = compareSnapshots(a, b, { t0: 0, t1: 10, view: 0, threshold: 90 });
  // 80 + 2t > 90 → t>5
  const s = seg(r);
  approx(s.start, 5);
  approx(s.end, 10);
  assert.equal(s.start_included, false);
  assert.equal(s.end_included, true);
});

test('中途接管：新渐变从当时实际亮度转向，区间在接管点连续合并', () => {
  // A: [0,10] 0→100，t=5 接管 [5,15] 50→0；B: 恒 0；阈值 25
  const a = snap(
    1,
    [light(1)],
    [cue(1, 1, 0, 100, 10), cue(2, 1, 5, 0, 10)],
  );
  const b = snap(2, [light(1)], []);
  const r = compareSnapshots(a, b, { t0: 0, t1: 15, view: 0, threshold: 25 });
  // 上升沿 10t>25 → t>2.5；峰值在 t=5（50）；下降沿 50-5(t-5)>25 → t<10
  assert.equal(r.intervals.length, 1); // 接管点连续，不拆成两段
  const s = seg(r);
  approx(s.start, 2.5);
  approx(s.end, 10);
  assert.deepEqual([s.start_included, s.end_included], [false, false]);
  approx(s.max_diff, 50);
});

test('V 形差值：单个时窗内给出三个区间（谷底两侧各穿越一次阈值）', () => {
  // A: t=0 瞬变 100，[0,10] 100→0，[10,20] 0→100；B: 恒 50；阈值 20
  const a = snap(
    1,
    [light(1)],
    [cue(1, 1, 0, 0, 10), cue(2, 1, 10, 100, 10)],
  );
  a.cues.unshift(cue(0, 1, 0, 100, 0));
  const b = snap(2, [light(1)], [cue(3, 1, 0, 50, 0)]);
  const r = compareSnapshots(a, b, { t0: 0, t1: 20, view: 0, threshold: 20 });
  const ss = onlySegs(r, 1);
  assert.equal(ss.length, 3);
  // 下降沿：50-10t>20 → t<3
  approx(ss[0].start, 0);
  approx(ss[0].end, 3);
  assert.deepEqual([ss[0].start_included, ss[0].end_included], [true, false]);
  approx(ss[0].max_diff, 50);
  // 谷底两侧：u=t-10，|50-10u|>20 → u<3(t<13) 或 u>7(t>17)。
  // (7,10) 与 (10,13) 在 Cue 触发点 t=10（差=50，包含）处拼接成一段 (7,13)
  approx(ss[1].start, 7);
  approx(ss[1].end, 13);
  assert.deepEqual([ss[1].start_included, ss[1].end_included], [false, false]);
  approx(ss[1].max_diff, 50);
  // 上升沿：10(t-10)-50>20 → t>17，至时窗终点 20
  approx(ss[2].start, 17);
  approx(ss[2].end, 20);
  assert.deepEqual([ss[2].start_included, ss[2].end_included], [false, true]);
  approx(ss[2].max_diff, 50);
});

test('配置差异：仅在一版存在的灯单列，不当作熄灭 0', () => {
  const a = snap(1, [light(1), light(2)], [cue(1, 2, 0, 100, 0)]);
  const b = snap(2, [light(1), light(3)], [cue(2, 3, 0, 100, 0)]);
  const r = compareSnapshots(a, b, { t0: 0, t1: 5, view: 0, threshold: 0 });
  assert.deepEqual(r.config_diff.only_in_a, [{ light_id: 2, light_name: 'L2' }]);
  assert.deepEqual(r.config_diff.only_in_b, [{ light_id: 3, light_name: 'L3' }]);
  // 共有灯 1 两版都没 Cue，恒等为 0 → 无区间
  assert.deepEqual(r.intervals, []);
  // 灯 2/3 不进入亮度表
  assert.deepEqual(r.levels.map((x) => x.light_id), [1]);
});

test('相同版本可比较：结果为空区间、空配置差异', () => {
  const s = snap(1, [light(1)], [cue(1, 1, 0, 100, 10)]);
  const r = compareSnapshots(s, s, { t0: 0, t1: 10, view: 3, threshold: 0 });
  assert.deepEqual(r.intervals, []);
  assert.deepEqual(r.config_diff, { only_in_a: [], only_in_b: [] });
  assert.deepEqual(r.levels[0], {
    light_id: 1,
    light_name: 'L1',
    brightness_a: 30,
    brightness_b: 30,
    diff: 0,
  });
});

test('零长度时窗：只返回该时刻亮度，不产生区间', () => {
  const a = snap(1, [light(1)], [cue(1, 1, 0, 100, 10)]);
  const b = snap(2, [light(1)], []);
  const r = compareSnapshots(a, b, { t0: 4, t1: 4, view: 4, threshold: 0 });
  assert.deepEqual(r.intervals, []);
  assert.equal(r.levels[0].brightness_a, 40);
  assert.equal(r.levels[0].brightness_b, 0);
  assert.equal(r.levels[0].diff, 40);
});

test('查看时刻亮度与 engine.js 完全一致（含瞬变、接管、同秒顺序）', () => {
  const a = snap(
    1,
    [light(1), light(2)],
    [
      cue(1, 1, 0, 100, 10),
      cue(2, 1, 5, 0, 10),
      cue(3, 2, 2, 80, 0),
      cue(4, 2, 2, 20, 0),
    ],
  );
  const b = snap(2, [light(1), light(2)], [cue(5, 1, 1, 30, 4)]);
  for (const v of [0, 2, 2.5, 4.999, 5, 7, 15]) {
    const r = compareSnapshots(a, b, { t0: 0, t1: 20, view: v, threshold: 0 });
    const ma = Engine.prepareCues(a.cues);
    const mb = Engine.prepareCues(b.cues);
    for (const lvl of r.levels) {
      approx(lvl.brightness_a, Engine.brightnessAt(ma, lvl.light_id, v), 1e-9);
      approx(lvl.brightness_b, Engine.brightnessAt(mb, lvl.light_id, v), 1e-9);
    }
  }
});

test('阈值 0：任何非零差（含常量差）都计入，差值恒为 0 时无区间', () => {
  const a = snap(1, [light(1)], [cue(1, 1, 0, 100, 0)]);
  const b = snap(2, [light(1)], [cue(2, 1, 0, 40, 0)]);
  const r = compareSnapshots(a, b, { t0: 0, t1: 8, view: 0, threshold: 0 });
  const s = seg(r);
  approx(s.start, 0);
  approx(s.end, 8);
  assert.deepEqual([s.start_included, s.end_included], [true, true]);
  approx(s.max_diff, 60);
});

// 与真实引擎密集采样对拍：随机快照下，区间对任意 t 的“是否报告”必须与引擎一致
test('Fuzz：区间归属与 engine.brightnessAt 密集采样在大量随机场景下一致', () => {
  function randCues(n, lightIds, rnd) {
    const rows = [];
    for (let i = 1; i <= n; i++) {
      rows.push(
        cue(
          i,
          lightIds[Math.floor(rnd() * lightIds.length)],
          +(rnd() * 10).toFixed(2),
          +(rnd() * 100).toFixed(2),
          +(rnd() * 6).toFixed(2),
        ),
      );
    }
    return rows;
  }

  let seed = 20261001;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let iter = 0; iter < 120; iter++) {
    const nLights = 1 + Math.floor(rnd() * 3);
    const ids = Array.from({ length: nLights }, (_, i) => i + 1);
    const lights = ids.map((id) => light(id));
    const a = snap(1, lights, randCues(2 + Math.floor(rnd() * 6), ids, rnd));
    const b = snap(2, lights, randCues(2 + Math.floor(rnd() * 6), ids, rnd));
    const threshold = +(rnd() * 60).toFixed(2);
    const T = 12;
    const r = compareSnapshots(a, b, { t0: 0, t1: T, view: 0, threshold });
    const ma = Engine.prepareCues(a.cues);
    const mb = Engine.prepareCues(b.cues);

    const byLight = new Map(r.intervals.map((x) => [x.light_id, x.segments]));
    const inside = (segs, t) =>
      segs.some(
        (s) =>
          (t > s.start + 1e-6 || (Math.abs(t - s.start) <= 1e-6 && s.start_included)) &&
          (t < s.end - 1e-6 || (Math.abs(t - s.end) <= 1e-6 && s.end_included)),
      );

    for (const id of ids) {
      const segs = byLight.get(id) ?? [];
      for (let k = 0; k <= T * 200; k++) {
        const t = +(k / 200).toFixed(4);
        const da = Math.abs(
          Engine.brightnessAt(ma, id, t) - Engine.brightnessAt(mb, id, t),
        );
        const actual = da > threshold + 1e-7;
        // 采样点离交点太近时跳过（数值容差区）
        if (Math.abs(da - threshold) < 1e-5) continue;
        assert.equal(
          inside(segs, t),
          actual,
          `iter=${iter} light=${id} t=${t} da=${da} thr=${threshold} segs=${JSON.stringify(segs)}`,
        );
      }
    }
  }
});

test('buildModel 对未在 lights 中声明的 Cue 灯具不报错（快照自洽性兜底）', () => {
  const a = snap(1, [light(1)], [cue(1, 9, 0, 100, 0)]);
  const m = buildModel(a);
  assert.ok(m.lights.has(1));
});
