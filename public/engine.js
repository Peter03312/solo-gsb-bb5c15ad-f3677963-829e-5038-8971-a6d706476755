/*
 * 灯光 Cue 渐变引擎（纯函数，无依赖）
 * 浏览器与 Node 共用：浏览器挂到 window.LightingEngine，Node 通过 module.exports 引入。
 *
 * 规则：
 *  - 每条 Cue 在 time 秒触发，把指定灯具从触发瞬间的“实际亮度”线性渐变到 target，
 *    渐变耗时 duration 秒（0 表示瞬变）。
 *  - 新 Cue 到来时，若该灯仍在上一条 Cue 的渐变中，以上一渐变在该时刻的实际亮度
 *    为起点转向新目标（中途接管，不跳变）。
 *  - 同一秒触发的多条 Cue，按 Cue 编号（cue_no）从小到大依次生效：
 *      · 前一条是普通渐变时，它在同一瞬间尚未来得及渐变，起点取其起始亮度；
 *      · 前一条是 0 秒瞬变时，它先一步跳到目标，起点取其目标亮度。
 *  - 亮度始终限制在 0～100。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LightingEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 0;
  const MAX = 100;

  function clamp(v) {
    if (v < MIN) return MIN;
    if (v > MAX) return MAX;
    return v;
  }

  /**
   * 整理一场演出的 Cue：按触发时码、再按 Cue 编号（同秒先后次序）排序，
   * 并为每盏灯把 Cue 展开成“渐变段”，预先记录每条 Cue 触发瞬间的实际起始亮度。
   * cue 字段：{ cue_no, light_id, time, target, duration }
   */
  function prepareCues(cues) {
    const ordered = cues
      .map((c) => ({
        cueNo: c.cue_no,
        lightId: c.light_id,
        time: Number(c.time),
        target: clamp(Number(c.target)),
        duration: Number(c.duration),
        end: Number(c.time) + Number(c.duration),
        from: 0, // 触发瞬间的实际亮度，下面按灯逐条计算
      }))
      .sort((a, b) => a.time - b.time || a.cueNo - b.cueNo);

    // 每盏灯只与自己的上一条 Cue 衔接
    const last = new Map();
    for (const seg of ordered) {
      const prev = last.get(seg.lightId);
      if (!prev) {
        seg.from = 0; // 该灯的第一条 Cue：从熄灭状态起步
      } else if (seg.time > prev.time) {
        if (seg.time >= prev.end || prev.duration === 0) {
          seg.from = prev.target; // 上一渐变已结束（或为瞬变）：保持在目标
        } else {
          // 中途接管：取上一渐变在新 Cue 触发时刻的实际亮度
          const k = (seg.time - prev.time) / prev.duration;
          seg.from = clamp(prev.from + (prev.target - prev.from) * k);
        }
      } else {
        // 同一时刻触发（已按编号排好序）：
        // 瞬变 Cue 先一步跳到目标；普通渐变此刻还未产生变化，取其起始亮度
        seg.from = prev.duration === 0 ? prev.target : prev.from;
      }
      last.set(seg.lightId, seg);
    }
    return ordered;
  }

  /**
   * 计算 t 秒时某盏灯的实际亮度：
   * 只需找到该灯“触发时刻 <= t”的最后一条 Cue（即当前生效段）。
   */
  function brightnessAt(orderedCues, lightId, t) {
    let active = null;
    for (const seg of orderedCues) {
      if (seg.lightId !== lightId) continue;
      if (seg.time > t) break; // 全局已按 time, cueNo 排序
      active = seg;
    }
    if (!active) return 0;
    if (active.duration === 0 || t >= active.end) return active.target;
    const k = (t - active.time) / active.duration;
    return clamp(active.from + (active.target - active.from) * k);
  }

  /** 整场演出所有灯具在 t 秒的亮度表 { lightId: brightness } */
  function levelsAt(orderedCues, lights, t) {
    const out = {};
    for (const l of lights) {
      out[l.id] = brightnessAt(orderedCues, l.id, t);
    }
    return out;
  }

  /** 演出总时长 = 最后一条 Cue 渐变结束时刻（无 Cue 时为 0） */
  function showDuration(orderedCues) {
    let d = 0;
    for (const c of orderedCues) {
      if (c.end > d) d = c.end;
    }
    return d;
  }

  return { clamp, prepareCues, brightnessAt, levelsAt, showDuration };
});
