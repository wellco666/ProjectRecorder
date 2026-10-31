-- 项目记录器的数据结构
--
-- 设计原则：
--   1. 员工和项目是多对多（一个人同时参与多个项目），所以中间用分配表连接
--   2. 每一步分析、每一条工时都单独存一行，不塞进大字段
--      —— 这样「谁在哪周超负荷」这类问题一句 SQL 就能答，不用在 Python 里翻
--   3. 时间统一存 ISO 文本（YYYY-MM-DD），SQLite 的日期函数直接能用

PRAGMA foreign_keys = ON;

-- 项目
CREATE TABLE IF NOT EXISTS project (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    owner       TEXT    NOT NULL DEFAULT '',   -- 项目负责人
    client      TEXT    NOT NULL DEFAULT '',   -- 甲方 / 需求方
    status      TEXT    NOT NULL DEFAULT '进行中',  -- 规划中 / 进行中 / 已暂停 / 已交付 / 已取消
    priority    TEXT    NOT NULL DEFAULT '中',      -- 高 / 中 / 低
    start_date  TEXT    NOT NULL DEFAULT '',
    due_date    TEXT    NOT NULL DEFAULT '',
    budget      REAL    NOT NULL DEFAULT 0,    -- 预算
    cost        REAL    NOT NULL DEFAULT 0,    -- 已花费
    progress    INTEGER NOT NULL DEFAULT 0,    -- 0~100
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 项目的分析步骤（阶段 / 任务）
CREATE TABLE IF NOT EXISTS step (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL DEFAULT 0,    -- 排序
    name        TEXT    NOT NULL,
    owner       TEXT    NOT NULL DEFAULT '',   -- 这一步谁负责
    status      TEXT    NOT NULL DEFAULT '未开始',  -- 未开始 / 进行中 / 已完成 / 已阻塞
    start_date  TEXT    NOT NULL DEFAULT '',
    due_date    TEXT    NOT NULL DEFAULT '',
    progress    INTEGER NOT NULL DEFAULT 0,
    note        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_step_project ON step(project_id, seq);

-- 员工
CREATE TABLE IF NOT EXISTS employee (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT '',   -- 岗位
    level       TEXT    NOT NULL DEFAULT '',   -- 职级，用于能力评估参考
    weekly_hours REAL   NOT NULL DEFAULT 40,   -- 每周可用工时，算负荷率的基准
    hired_date  TEXT    NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,    -- 1 在职 / 0 离职
    note        TEXT    NOT NULL DEFAULT ''
);

-- 工时记录
CREATE TABLE IF NOT EXISTS worklog (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    project_id  INTEGER REFERENCES project(id) ON DELETE SET NULL,  -- 可以记非项目事务
    step_id     INTEGER REFERENCES step(id) ON DELETE SET NULL,
    work_date   TEXT    NOT NULL,              -- YYYY-MM-DD
    hours       REAL    NOT NULL DEFAULT 0,
    content     TEXT    NOT NULL DEFAULT '',   -- 干了什么
    -- 来源：timer=计时器真实计时，manual=手工补录。
    -- 分开存是为了让老板看得出哪些是计时的、哪些是补的——
    -- 补录比例高说明流程没落地。这个区分比「禁止补录」有用得多。
    source      TEXT    NOT NULL DEFAULT 'manual',
    -- 去重指纹：员工提交文件导入时靠它判断「这条是不是已经在库里」。
    -- 同一个人的同一天、同一项目、同样的工时和说明，指纹相同，
    -- 所以同一个文件导入两次也不会出现两份记录。
    source_key  TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_worklog_emp_date ON worklog(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_worklog_project ON worklog(project_id, work_date);

-- 计时会话。
--
-- 为什么单独一张表而不是直接往 worklog 里写：
--   工时记录是「已经发生的事实」，而会话有「正在跑」这个中间状态。
--   混在一起的话，统计工时就得处处过滤「哪些还没结束」，很容易漏。
--
-- 关于防作弊，说清楚：
--   员工的程序跑在他自己电脑上，他对那台机器有完全控制权，
--   所以**本地计时做不到无法篡改**。真正无法作弊的前提是计时结果
--   实时上报到服务器，而这套方案是文件交换、不联网。
--   能做到的是**篡改可被发现**：
--     · 时长用单调时钟算（monotonic），改系统时间不会让它跳
--     · 同时记下墙钟时间，导入时两边交叉核对，改过就对不上
--     · 异常（超 24 小时、时间重叠、单次超长）全部报出来
CREATE TABLE IF NOT EXISTS session (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    project_id  INTEGER REFERENCES project(id) ON DELETE SET NULL,
    step_id     INTEGER REFERENCES step(id) ON DELETE SET NULL,
    work_date   TEXT    NOT NULL,              -- 归属哪一天
    -- 单调时钟读数的起点（秒，浮点）。只在本机有意义，用来累加时长。
    mono_start  REAL    NOT NULL DEFAULT 0,
    -- 已经累计的秒数（暂停后累加）。运行时 = 已累计 + (现在 - mono_start)
    elapsed     REAL    NOT NULL DEFAULT 0,
    -- 墙钟时间，用于导入时和时长交叉核对
    started_at  TEXT    NOT NULL DEFAULT '',
    ended_at    TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'running',  -- running / paused / finished
    content     TEXT    NOT NULL DEFAULT '',
    -- 手工补录的会话直接带时长，没有真实的开始结束时间
    manual      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session_emp ON session(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_session_status ON session(status);

-- 任务分配（把员工挂到项目的某一步上，和工时互补：
-- 分配是「计划」，工时是「实际」，两者对比就能看出谁被压了活、谁闲着）
CREATE TABLE IF NOT EXISTS assignment (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    step_id     INTEGER REFERENCES step(id) ON DELETE SET NULL,
    employee_id INTEGER NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    role_in_task TEXT   NOT NULL DEFAULT '',
    planned_hours REAL   NOT NULL DEFAULT 0,
    start_date  TEXT    NOT NULL DEFAULT '',
    due_date    TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT '待开始'
);
CREATE INDEX IF NOT EXISTS idx_assign_project ON assignment(project_id);
CREATE INDEX IF NOT EXISTS idx_assign_emp ON assignment(employee_id);

-- 能力与资源评估。一张表装两类，用 kind 区分：
--   kind='ability' 是「这个人/这个项目组的技术能力」
--   kind='resource' 是「这个项目有哪些有利资源」
CREATE TABLE IF NOT EXISTS assessment (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL,              -- ability / resource
    name        TEXT    NOT NULL,              -- 能力名 / 资源名
    score       INTEGER NOT NULL DEFAULT 3,    -- 1~5 分
    weight      REAL    NOT NULL DEFAULT 1,    -- 这项有多重要，用于加权总分
    note        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_assess_project ON assessment(project_id, kind);

-- 表格数据：自定义列的关键指标
-- 设计成「一行一个指标」而不是「一行一条记录 + 固定列」，
-- 这样老板想加什么指标都不用改表结构
CREATE TABLE IF NOT EXISTS metric (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    metric_date TEXT    NOT NULL,              -- 这项指标是哪天的
    name        TEXT    NOT NULL,              -- 指标名，例如「毛利率」
    value       REAL    NOT NULL DEFAULT 0,
    unit        TEXT    NOT NULL DEFAULT '',
    note        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_metric_project ON metric(project_id, metric_date);


-- ============================================================ 知识星球
-- 一条知识不是一篇普通笔记：它有认知区域、显性/隐性、沉淀阶段，
-- 还可以被反思、被手动连接，也可以靠共同标签自动形成引力关系。
CREATE TABLE IF NOT EXISTS knowledge (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT    NOT NULL,
    content         TEXT    NOT NULL DEFAULT '',
    zone            TEXT    NOT NULL DEFAULT '实际知识',
    kind            TEXT    NOT NULL DEFAULT '显性知识',
    source          TEXT    NOT NULL DEFAULT '',
    tags            TEXT    NOT NULL DEFAULT '',
    project_id      INTEGER REFERENCES project(id) ON DELETE SET NULL,
    importance      INTEGER NOT NULL DEFAULT 3,
    status          TEXT    NOT NULL DEFAULT '已沉淀',
    next_review     TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_zone ON knowledge(zone, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_updated ON knowledge(updated_at);

-- 手动建立的认知关系。标签相同会自动产生「同频」关系，不必重复存。
CREATE TABLE IF NOT EXISTS knowledge_link (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id     INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    to_id       INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    relation    TEXT    NOT NULL DEFAULT '关联',
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(from_id, to_id),
    CHECK(from_id <> to_id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_link_from ON knowledge_link(from_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_link_to ON knowledge_link(to_id);

-- 每次反思都单独留痕。只存一个「反思次数」看不出认知是怎么变化的。
CREATE TABLE IF NOT EXISTS knowledge_reflection (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    knowledge_id    INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    prompt          TEXT    NOT NULL DEFAULT '',
    content         TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_reflection ON knowledge_reflection(knowledge_id, created_at);
