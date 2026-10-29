# 手机版 · 云同步设置

员工勾选任务 → 工时自动汇总到老板，**全程不需要手动导入**。
这一步只需要做一次。

---

## 一、注册 Supabase

1. 打开 https://supabase.com ，用 GitHub 或邮箱注册（免费）
2. **New project**
   - 名字随便，比如 `project-recorder`
   - 数据库密码：自己存好（这是数据库密码，不是你的登录密码）
   - Region 选 **Northeast Asia (Tokyo)** 或 **Southeast Asia (Singapore)**，离国内近

等 2~3 分钟初始化完成。

---

## 二、建表（复制粘贴，一次跑完）

左侧 **SQL Editor** → New query → 粘贴下面整段 → **Run**

```sql
-- ============================================================
--  1. 数据表
-- ============================================================

-- 账号资料。用"账号名 + 密码"登录，不用真邮箱。
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  code text unique not null,               -- 登录名：老板用手机号，员工用工号
  name text not null,
  role text not null default 'employee',   -- boss / employee
  boss_id uuid references profiles(id),    -- 员工属于哪个老板
  weekly_hours numeric default 40,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 任务。只有老板能建，指派给某个员工。
create table tasks (
  id uuid primary key default gen_random_uuid(),
  boss_id uuid not null references profiles(id) on delete cascade,
  employee_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  detail text default '',
  plan_date date not null,
  est_hours numeric default 0,             -- 预估工时，没点开始时的兜底
  project_name text default '',
  step_name text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 勾选记录。员工只能写自己的。
create table task_logs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  employee_id uuid not null references profiles(id) on delete cascade,
  started_at timestamptz,
  finished_at timestamptz not null default now(),
  finish_date date not null default current_date,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- 同一条任务同一天只允许一条：重复提交自动忽略
  unique (task_id, finish_date)
);

-- 工时。由勾选自动生成，老板端读这张。
create table worklogs (
  id uuid primary key default gen_random_uuid(),
  boss_id uuid not null references profiles(id) on delete cascade,
  employee_id uuid not null references profiles(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  work_date date not null,
  hours numeric not null,
  content text default '',
  project_name text default '',
  source text default 'task',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
--  2. 自动维护 updated_at
-- ============================================================
--  客户端会写这一列。用触发器维护而不是每个写入路径自己赋值：
--  一处定义，不会漏。
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_tasks_touch before update on tasks
  for each row execute function public.touch_updated_at();
create trigger trg_profiles_touch before update on profiles
  for each row execute function public.touch_updated_at();
create trigger trg_task_logs_touch before update on task_logs
  for each row execute function public.touch_updated_at();
create trigger trg_worklogs_touch before update on worklogs
  for each row execute function public.touch_updated_at();

-- ============================================================
--  3. 注册时自动创建 profiles 行
-- ============================================================
--  为什么需要它：不管用 App 注册还是在后台用管理 API 建号，
--  auth.users 里会有记录但 profiles 里没有。而 tasks.employee_id
--  外键指向 profiles(id) —— 缺这一行，派任务会直接失败。
--
--  角色按内部邮箱的域名判断：
--      账号名@boss.pr   → 老板
--      账号名@staff.pr  → 员工
create or replace function public.handle_new_user()
returns trigger language plpgsql
security definer set search_path = public as $$
declare
  local_part text;
  domain_part text;
begin
  local_part  := split_part(new.email, '@', 1);
  domain_part := split_part(new.email, '@', 2);

  insert into public.profiles (id, code, name, role)
  values (
    new.id,
    local_part,
    coalesce(new.raw_user_meta_data->>'name', local_part),
    case when domain_part = 'boss.pr' then 'boss' else 'employee' end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 给已有账号补 profiles 行（触发器只对之后的新用户生效）
insert into public.profiles (id, code, name, role)
select u.id, split_part(u.email, '@', 1), split_part(u.email, '@', 1),
       case when split_part(u.email, '@', 2) = 'boss.pr'
            then 'boss' else 'employee' end
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- ============================================================
--  4. 行级权限（RLS）
-- ============================================================
--  安全靠这些策略保证，anon key 打进 apk 是安全的。
alter table profiles  enable row level security;
alter table tasks     enable row level security;
alter table task_logs enable row level security;
alter table worklogs  enable row level security;

-- profiles：读自己那一行；老板能读"还没归属的"和"已经归自己的"员工。
--   （认领之前也要能读到——syncStaffAccounts 得先按工号找到人）
create policy "own profile" on profiles for select
  using (
    id = auth.uid()
    or (role = 'employee' and (boss_id is null or boss_id = auth.uid()))
  );

-- profiles：老板能把员工认领成自己的。
--   using 决定"能改哪些行"，with check 决定"能改成什么样"——
--   两个都要写，只写 using 的话"把 boss_id 设成自己"会被拒。
create policy "boss updates staff" on profiles for update
  using (role = 'employee' and (boss_id is null or boss_id = auth.uid()))
  with check (role = 'employee' and boss_id = auth.uid());

-- profiles：注册时能写自己那一行（触发器之外的保险）
create policy "insert own profile" on profiles for insert
  with check (id = auth.uid());

-- tasks：老板全权管自己的任务；员工只读指派给自己的
create policy "boss manages tasks" on tasks for all
  using (boss_id = auth.uid()) with check (boss_id = auth.uid());
create policy "employee reads own tasks" on tasks for select
  using (employee_id = auth.uid());

-- task_logs：员工写自己的，老板读自己员工的
create policy "employee writes own logs" on task_logs for insert
  with check (employee_id = auth.uid());
create policy "read own logs" on task_logs for select
  using (employee_id = auth.uid()
         or exists (select 1 from tasks t
                    where t.id = task_logs.task_id and t.boss_id = auth.uid()));
create policy "employee deletes own logs" on task_logs for delete
  using (employee_id = auth.uid());

-- worklogs：老板读自己的，员工读自己的、写自己的
create policy "read own worklogs" on worklogs for select
  using (boss_id = auth.uid() or employee_id = auth.uid());
create policy "insert worklogs" on worklogs for insert
  with check (boss_id = auth.uid() or employee_id = auth.uid());
create policy "delete own worklogs" on worklogs for delete
  using (employee_id = auth.uid());

-- ============================================================
--  5. 索引（数据量大了才明显，早加没坏处）
-- ============================================================
create index if not exists idx_tasks_employee_date
  on tasks (employee_id, plan_date);
create index if not exists idx_worklogs_boss_date
  on worklogs (boss_id, work_date);
create index if not exists idx_task_logs_employee
  on task_logs (employee_id, finish_date);
```

---

## 三、关掉邮箱验证（**必须**）

**Authentication → Sign In / Providers → Email → 把 `Confirm email` 关掉**

不关的话：

- 员工没有真邮箱，收不到确认信 → **登不上**
- 每次注册都会真的发一封邮件到不存在的地址 → 触发限流

> 新版 Supabase 可能把这个开关挪到了 `Authentication → Settings`
> 或 `Project Settings → Authentication`。找不到就翻一下。

---

## 四、拿两个值填进 App

**Project Settings → API**：

| 值 | 长什么样 | 填在哪 |
|---|---|---|
| **Project URL** | `https://xxxxx.supabase.co` | App 的「云服务设置」 |
| **anon public key** | `eyJhbGci...` 很长 | 同上 |

⚠️ **不要用 `service_role` key**。那是管理密钥，能绕过所有权限，
泄露等于数据库裸奔。**只填 anon public。**

---

## 五、建员工账号

**App 里建**（老板端 → 团队 → 员工账号 → + 账号）填姓名、工号、密码。

**然后还要在 Supabase 后台建同样的账号**：

Authentication → Users → **Add user** → Create new user

| 字段 | 填什么 |
|---|---|
| Email | `<工号>@staff.pr` ← **注意后缀** |
| Password | 和 App 里填的一致 |
| Auto Confirm User | **勾上** |

> **为什么要在后台建两遍**：在客户端建号会把老板自己的登录顶掉
> （Supabase 的限制）；用管理密钥建号又要把 `service_role` 打进 apk，
> 不安全。所以这一步放后台。
>
> 嫌麻烦的话，可以加一个 Supabase Edge Function 代为建号——
> 那是下一步的事。

**老板自己的账号**同理，邮箱是 `<手机号>@boss.pr`。

---

## 六、验证一切正常

在电脑上跑（**需要 node**）：

```powershell
cd E:\miniSoftware\ProjectRecorder\mobile
node e2e-cloud.js
```

它会真的注册几个测试账号，跑一遍
**派任务 → 勾选 → 上报 → 老板收到**的完整流程，并检查权限隔离。

预期末尾：

```
全部通过（15 项）。云端链路是通的。
```

**如果哪一项失败，把输出贴出来**——它会指明是权限、外键还是触发器的问题。

---

## 七、界面层验证

```powershell
node build-devtools.js
```

然后打开 `devtools/e2e-ui.html`，它会用 App 自己的代码跑一遍完整业务流程
（登录 → 建号 → 认领 → 派任务 → 勾选 → 老板收到），共 11 组检查。

---

## 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 注册报 `Email not confirmed` | 邮箱验证没关 | 见第三步 |
| 派任务失败 `PGRST204` | 表缺列 | 跑完第二步的完整 SQL |
| 员工登录后"今天没有任务" | 员工没被认领（`boss_id` 为空） | 老板端点「同步账号到云端」 |
| 老板收不到工时 | 上传失败 | 看顶栏的同步标签，**失败会显示"同步失败"**，悬停看原因 |
| 认领员工失败 | UPDATE 策略缺 `with check` | 跑完第二步的完整 SQL |
| 一直显示"待上传 N 条" | 网络问题或被服务端拒绝 | 点「立即同步」重试；看标签 title 里的具体错误 |
