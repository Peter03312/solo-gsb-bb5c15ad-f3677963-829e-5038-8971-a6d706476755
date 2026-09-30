# 小剧场灯光 Cue 排演（Lighting Cue Rehearsal）

一款用于小剧场灯光排演的 Web 应用。录入**灯具**与按演出秒数触发的 **Cue**
（灯具编号、目标亮度、非负渐变时长），所有灯光效果都在浏览器中模拟，**无需连接任何真实灯具**。
支持播放 / 暂停 / 跳转，并实时显示任意时刻每盏灯的实际亮度；发布后生成**不可变演出版本**。

技术栈：Node.js + Express + SQLite（better-sqlite3），原生 HTML/CSS/JS 前端，无前端构建步骤。

## 灯光规则

- 亮度范围 **0～100**，按**线性渐变**变化。
- 每条 Cue 在指定时码（非负秒数，支持小数）触发，把目标灯具从触发瞬间的**实际亮度**
  渐变到目标亮度；渐变时长为非负秒数，`0` 表示瞬变。
- **中途接管**：新 Cue 到来时，若同一盏灯仍在渐变中，效果从该时刻的实际亮度直接转向
  新目标（不跳变、不重置）。
- **同秒顺序**：同一秒触发的多条 Cue，按 Cue 编号（正整数、唯一）从小到大依次生效。
- **不可变版本**：发布即对当前灯具与草稿 Cue 做完整快照。开始播放后始终使用开始时所选的
  版本；之后继续编辑草稿或发布新版本，都不会影响正在/已开始的那次播放。
- 提交校验：非法时码（负数/非数字）、未知灯具编号、无效亮度（超出 0～100/非数字）
  或非法渐变时长会明确指出错误，并且**整次提交被拒绝**（批量录入任意一行非法则全部不落库）。

## 一键启动（Docker Compose）

需要 Docker 与 Docker Compose 插件。在本目录执行：

```bash
docker compose up --build -d
```

该命令会一次性完成：安装依赖 → 初始化 SQLite 数据库与表结构 → 启动服务。

启动后访问：

- 地址：<http://localhost:3000>
- 端口：容器内固定 `3000`，宿主机默认映射到 `3000`（可用 `HOST_PORT` 修改）

停止：

```bash
docker compose down          # 停止（数据保留在命名卷 cue-data 中）
docker compose down -v       # 停止并删除演出数据
```

查看日志：`docker compose logs -f`

## 配置（环境变量）

在 docker-compose.yml 中配置，或通过 `.env` / 环境变量覆盖：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST_PORT` | `3000` | 宿主机映射端口（访问端口），如 `HOST_PORT=8080 docker compose up -d` |
| `PORT` | `3000` | 容器内监听端口（改动需同步调整 compose 的端口映射） |
| `DB_PATH` | `/data/app.db` | SQLite 数据库文件路径；位于挂载卷中，容器重建不丢数据 |
| `NODE_ENV` | `production` | 运行环境 |

## 不使用 Docker 的本地运行方式

需要 Node.js ≥ 20。

```bash
npm install
npm start                 # 默认监听 http://localhost:3000，数据文件在 ./data/app.db
PORT=8080 DB_PATH=/tmp/cue.db npm start   # 自定义端口与数据库位置
npm test                  # 运行灯光渐变引擎单元测试
```

## 使用说明

1. **灯具录入**：添加灯具（名称唯一），系统自动分配灯具编号 `#1、#2 …`。
2. **草稿 Cue**：
   - 单条录入：选择灯具、填写触发秒数、目标亮度（0～100）、渐变秒数；
     Cue 编号可留空自动分配，也可手填正整数。
   - 批量录入：每行 `时码 灯具编号 目标亮度 渐变时长 [Cue编号]`，空格分隔；
     任一行非法将拒绝整次提交。
   - 草稿可随时编辑/删除；这些改动只作用于草稿。
3. **发布版本**：填写备注（可留空）后点击“冻结并发布当前草稿”，生成不可变版本。
4. **排演播放**：选择版本后即可 ▶ 播放 / ⏸ 暂停 / ⏹ 回起点 / 拖动时间轴 / 输入秒数跳转，
   可切换 0.5× / 1× / 2× 速度；舞台模拟、亮度条与 Cue 状态（等待 / 渐变中 / 已触发）
   随时间实时更新。快捷键：页面空白处按空格播放/暂停。
5. **版本比较（排演人员）**：在「版本比较」页输入**两个已发布版本**、非负起止秒数
   （时窗）、时窗内的**查看时刻**与 **0～100 的亮度差阈值**：
   - 页面显示查看时刻两版**逐灯亮度**（按灯具编号匹配）；
   - 列出时窗内各灯两版亮度差**严格大于阈值**的连续区间，区间用 `[ ] / ( )` 标明
     端点包含性（交点处差值恰为阈值则该端点不含；瞬变 Cue 触发瞬间按触发后亮度判定）；
   - 阈值交点与 Cue 触发时刻均为**解析计算**（分段线性求根），不依赖固定间隔采样；
   - 只存在于一版的灯具单列为**配置差异**，缺失不当作熄灭；完全无差异时区间为空；
   - 时窗**起点不能大于终点**，查看时刻须在时窗内，阈值越界 / 无效数字 / 版本不存在
     均会明确报错；相同两个版本也可比较；**零长度时窗**（起点=终点）只返回该时刻亮度；
   - 比较只读已发布快照，**不改动草稿或播放会话**。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/lights` | 灯具列表 |
| POST | `/api/lights` | 新增灯具 `{name}` |
| DELETE | `/api/lights/:id` | 删除灯具（仍被草稿 Cue 引用时返回 409） |
| GET | `/api/cues` | 草稿 Cue 列表（按时码、编号排序） |
| POST | `/api/cues` | 新增 Cue，接受单条对象或数组（数组为批量，整批事务） |
| PATCH | `/api/cues/:id` | 修改草稿 Cue |
| DELETE | `/api/cues/:id` | 删除草稿 Cue |
| POST | `/api/versions` | 冻结当前草稿，发布不可变版本 |
| GET | `/api/versions` | 版本列表 |
| GET | `/api/versions/:id` | 版本完整快照（灯具 + Cue，供播放器使用） |
| GET/POST | `/api/compare` | 两个已发布版本的逐灯亮度比较（只读，见下） |

### 版本比较 API：`/api/compare`

只读两个已发布快照（相同版本也可比较），不影响草稿或播放会话。参数可走 query（GET）
或 JSON body（POST），数字可传数字或数字字符串：

| 参数 | 别名 | 说明 |
| --- | --- | --- |
| `version_a` | `a` | 版本 A 编号（正整数，须已发布） |
| `version_b` | `b` | 版本 B 编号（正整数，须已发布） |
| `start` | — | 时窗起点（非负秒数，`start <= end`） |
| `end` | — | 时窗终点（非负秒数） |
| `at` | `time` | 查看时刻（须落在 `[start, end]` 内） |
| `threshold` | — | 亮度差阈值，`0～100`；列出严格大于该值的区间 |

返回：

- `versions`：两版编号与备注；`window`：时窗及是否零长度；`at`、`threshold` 回显；
- `brightnesses`：查看时刻共有灯具逐灯亮度 `{light_id, name_a, name_b, brightness_a,
  brightness_b, abs_diff}`；
- `intervals`：时窗内亮度差严格大于阈值的连续区间（空结果为 `[]`），每项含
  `{light_id, name_a, name_b, start, end, start_included, end_included, max_abs_diff}`；
  端点包含性即“严格大于”在边界/Cue 触发点上的精确判定；
- `config_differences`：仅一版存在的灯具 `{light_id, present_in: "a"|"b", name,
  brightness_at}`；缺失不当作熄灭，故不并入逐灯对比。

区间边界与 Cue 触发时刻由分段线性差值**解析求根**得到，不做固定间隔采样。
零长度时窗只返回 `brightnesses`，`intervals` 恒为空。

调用示例：

```bash
# GET（query）
curl "http://localhost:3000/api/compare?version_a=1&version_b=2&start=0&end=60&at=12.5&threshold=10"

# POST（JSON body）
curl -X POST http://localhost:3000/api/compare \
  -H 'Content-Type: application/json' \
  -d '{"version_a":1,"version_b":2,"start":0,"end":60,"at":12.5,"threshold":10}'
```

```jsonc
// 响应示例（节选）
{
  "versions": { "a": {"id":1,"label":"首演"}, "b": {"id":2,"label":"复排"} },
  "window": { "start": 0, "end": 60, "zero_length": false },
  "at": 12.5,
  "threshold": 10,
  "brightnesses": [
    { "light_id": 1, "name_a": "面光1", "name_b": "面光1",
      "brightness_a": 100, "brightness_b": 80, "abs_diff": 20 }
  ],
  "intervals": [
    { "light_id": 1, "name_a": "面光1", "name_b": "面光1",
      "start": 3.000001, "end": 60, "start_included": false, "end_included": true,
      "max_abs_diff": 40 }
  ],
  "config_differences": [
    { "light_id": 3, "present_in": "b", "name": "新增侧光", "brightness_at": 0 }
  ]
}
```

非法参数（起点大于终点、查看时刻越界、无效数字、阈值越界）返回 `400`；
版本编号无效或不存在返回 `400/404`；错误体形如 `{"error": "具体中文原因"}`。

所有错误返回 `400/404/409` 与形如 `{"error": "具体中文原因"}` 的 JSON。

## 目录结构

```
server.js            Express 服务与 API、输入校验、版本快照事务、版本比较 API
src/db.js            SQLite 初始化与表结构
public/engine.js     纯函数灯光渐变引擎（浏览器/Node 共用，含线性渐变与中途接管规则）
public/compare.js    纯函数版本比较引擎（分段线性解析求根、端点包含性、配置差异）
public/index.html    单页界面
public/styles.css    剧场暗色主题
public/app.js        前端交互、基于 requestAnimationFrame 的播放器与版本比较页
test/engine.test.js  渐变规则单元测试
test/compare.test.js 版本比较（区间界定/端点/校验）单元测试
Dockerfile           镜像构建（依赖、初始化、启动）
docker-compose.yml   一键编排
```
