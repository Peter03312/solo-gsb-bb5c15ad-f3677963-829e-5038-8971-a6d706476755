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

所有错误返回 `400/404/409` 与形如 `{"error": "具体中文原因"}` 的 JSON。

## 目录结构

```
server.js            Express 服务与 API、输入校验、版本快照事务
src/db.js            SQLite 初始化与表结构
public/engine.js     纯函数灯光渐变引擎（浏览器/Node 共用，含线性渐变与中途接管规则）
public/index.html    单页界面
public/styles.css    剧场暗色主题
public/app.js        前端交互与基于 requestAnimationFrame 的播放器
test/engine.test.js  渐变规则单元测试
Dockerfile           镜像构建（依赖、初始化、启动）
docker-compose.yml   一键编排
```
