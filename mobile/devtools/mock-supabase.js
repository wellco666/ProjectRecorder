/* =============================================================
   假的 Supabase 客户端（开发用）

   为什么需要它：
     验证通知链路要有一个 task_events 表。但那段建表 SQL 要你
     在 Supabase 后台跑，在跑之前我**没法验证整条链路**。

     换成"等用户操作"不是办法——那会让"没验证过的代码"留在这里。
     所以用一个假客户端顶替真的：
       · 真实代码路径全跑（pullAll / pumpNotifications / 界面渲染）
       · 只有服务端响应是受控的

   ## 怎么换进来

     mock-supabase.js 在 vendor/supabase.js **之前**加载，
     它定义 window.supabase = { createClient: ... }。
     真库加载后会覆盖它，所以测试页里跳过真库不加载。

   ## 支持的方法

     只实现 app 真正用到的那几个：
       from(table).select().eq().gt().order().limit()  -> Promise
       from(table).upsert(row, opts)                   -> Promise
       from(table).delete().eq()                       -> Promise
       rpc(name, args)                                 -> Promise
       auth.signInWithPassword / signOut / getSession
     ============================================================= */
(function () {
  "use strict";

  /*: 受控的"服务端数据"。测试页可以在跑之前改这个对象。 */
  var MOCK_DB = {
    tasks: [],
    worklogs: [],
    task_logs: [],
    task_events: [],
    profiles: [],
  };

  /*: 记录每次请求，方便断言"到底拉了哪张表"。 */
  var MOCK_LOG = [];

  function rowsFor(table) {
    var rows = MOCK_DB[table];
    return Array.isArray(rows) ? rows.slice() : [];
  }

  /* 一个查询构造器：链式调用只记条件，await 时才出结果。 */
  function makeQuery(table, mode) {
    var state = { table: table, mode: mode || "select", filters: [],
                  orderBy: null, asc: false, take: null, payload: null };
    var chain = {
      select: function () { return chain; },
      /* **`.single()` 必须实现。**

         adoptSession 用它读自己的 profile 行：
             cloudClient.from("profiles").select("*").eq("id", ...).single()
         缺这个方法的话 extra 是 undefined，而 profileFromUser 的
         兜底角色是 "boss"——**员工登录后会变成老板**，
         通知也就全错了。

         （这个兜底本身也值得注意：读不到资料时默认成老板，
          权限方向是"多给"而不是"少给"。真实环境里 RLS 保证
          只能读到自己的行，所以问题不大，但 mock 必须补全。） */
      single: function () {
        var result = run(state);
        var row = result.data && result.data.length ? result.data[0] : null;
        return Promise.resolve({
          data: row,
          error: row ? null : { message: "no rows returned" },
        });
      },
      eq: function (col, value) {
        state.filters.push({ op: "eq", col: col, value: value });
        return chain;
      },
      gt: function (col, value) {
        state.filters.push({ op: "gt", col: col, value: value });
        return chain;
      },
      is: function (col, value) {
        state.filters.push({ op: "is", col: col, value: value });
        return chain;
      },
      order: function (col, opts) {
        state.orderBy = col;
        state.asc = !!(opts && opts.ascending);
        return chain;
      },
      limit: function (n) { state.take = n; return chain; },
      /* await 这个对象时走这里 */
      then: function (resolve) {
        var result = run(state);
        MOCK_LOG.push({ table: table, mode: state.mode,
                        filters: state.filters, returned: result.data
                          ? result.data.length : 0 });
        return Promise.resolve(result).then(resolve);
      },
    };
    return chain;
  }

  function run(state) {
    /* upsert：写进受控数据里，好让后续拉取能看到 */
    if (state.mode === "upsert") {
      var list = MOCK_DB[state.table];
      if (!Array.isArray(list)) list = MOCK_DB[state.table] = [];
      var row = state.payload;
      var at = -1;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].id === row.id) { at = i; break; }
      }
      if (at >= 0) list[at] = Object.assign({}, list[at], row);
      else list.push(row);
      return { data: [row], error: null };
    }

    /* delete */
    if (state.mode === "delete") {
      var before = MOCK_DB[state.table] || [];
      var kept = before.filter(function (item) {
        return !state.filters.every(function (f) {
          return f.op === "eq" ? String(item[f.col]) === String(f.value) : true;
        });
      });
      MOCK_DB[state.table] = kept;
      return { data: null, error: null };
    }

    /* select */
    var rows = rowsFor(state.table);
    state.filters.forEach(function (f) {
      rows = rows.filter(function (item) {
        if (f.op === "eq") return String(item[f.col]) === String(f.value);
        if (f.op === "gt") return String(item[f.col]) > String(f.value);
        if (f.op === "is") {
          return f.value === null ? (item[f.col] === null
            || item[f.col] === undefined) : item[f.col] === f.value;
        }
        return true;
      });
    });
    if (state.orderBy) {
      var col = state.orderBy;
      rows.sort(function (a, b) {
        var x = String(a[col] || ""), y = String(b[col] || "");
        return state.asc ? x.localeCompare(y) : y.localeCompare(x);
      });
    }
    if (state.take) rows = rows.slice(0, state.take);
    return { data: rows, error: null };
  }

  /*: 假客户端。测试页通过它改数据、读请求日志。 */
  window.__mock = {
    db: MOCK_DB,
    log: MOCK_LOG,
    reset: function () {
      Object.keys(MOCK_DB).forEach(function (k) { MOCK_DB[k] = []; });
      MOCK_LOG.length = 0;
    },
    /* 让"表不存在"这件事可以被模拟 */
    missingTables: [],
  };

  window.supabase = {
    createClient: function () {
      return {
        from: function (table) {
          /* 模拟"表还没建"：sql/migrate-notify.sql 没跑的情况 */
          if (window.__mock.missingTables.indexOf(table) !== -1) {
            return {
              select: function () {
                var q = makeQuery(table, "select");
                var origThen = q.then;
                q.then = function (resolve) {
                  return Promise.resolve({
                    data: null,
                    error: { message: 'relation "' + table
                      + '" does not exist' },
                  }).then(resolve);
                };
                void origThen;
                return q;
              },
              upsert: function () {
                return Promise.resolve({
                  data: null,
                  error: { message: 'relation "' + table
                    + '" does not exist' },
                });
              },
            };
          }
          var query = makeQuery(table, "select");
          /* upsert / delete 挂在同一个对象上，和真 SDK 一样 */
          query.upsert = function (payload) {
            var s = { table: table, mode: "upsert", payload: payload };
            return Promise.resolve(run(s));
          };
          query.delete = function () {
            var s = { table: table, mode: "delete", filters: [] };
            var del = {
              eq: function (col, value) {
                s.filters.push({ op: "eq", col: col, value: value });
                return del;
              },
              then: function (resolve) {
                return Promise.resolve(run(s)).then(resolve);
              },
            };
            return del;
          };
          return query;
        },
        rpc: function (name, args) {
          MOCK_LOG.push({ rpc: name, args: args });
          if (name === "create_staff_account") {
            var id = "staff-uuid-0000-4000-8000-000000000001";
            var existing = (MOCK_DB.profiles || []).find(function (p) {
              return p.code === String(args.p_code).toLowerCase();
            });
            if (existing) {
              return Promise.resolve({
                data: { ok: true, id: existing.id, code: existing.code,
                        already_existed: true },
                error: null,
              });
            }
            MOCK_DB.profiles.push({
              id: id, code: String(args.p_code).toLowerCase(),
              name: args.p_name, role: "employee",
              boss_id: "boss-uuid-0000-4000-8000-000000000001",
            });
            return Promise.resolve({
              data: { ok: true, id: id, code: String(args.p_code).toLowerCase(),
                      already_existed: false },
              error: null,
            });
          }
          return Promise.resolve({ data: { ok: true }, error: null });
        },
        auth: {
          signInWithPassword: function (creds) {
            MOCK_LOG.push({ auth: "signIn", email: creds.email });
            var isBoss = creds.email.indexOf("@boss.pr") !== -1;
            var id = isBoss
              ? "boss-uuid-0000-4000-8000-000000000001"
              : "staff-uuid-0000-4000-8000-000000000001";
            var code = String(creds.email).split("@")[0];
            /* profiles 里有这一行的话 adoptSession 就能拿到正确的角色。
               没有的话它兜底成 boss —— 所以测试页要先铺好这一行。 */
            if (!MOCK_DB.profiles.some(function (p) { return p.id === id; })) {
              MOCK_DB.profiles.push({
                id: id, code: code, name: code,
                role: isBoss ? "boss" : "employee",
                boss_id: isBoss ? null
                  : "boss-uuid-0000-4000-8000-000000000001",
                weekly_hours: 40,
              });
            }
            return Promise.resolve({
              data: {
                user: {
                  id: id,
                  email: creds.email,
                  user_metadata: { name: code },
                  app_metadata: {},
                },
                session: { access_token: "mock-token", user: { id: id } },
              },
              error: null,
            });
          },
          signOut: function () { return Promise.resolve({ error: null }); },
          getSession: function () {
            return Promise.resolve({ data: { session: null }, error: null });
          },
          onAuthStateChange: function () {
            return { data: { subscription: { unsubscribe: function () {} } } };
          },
          setSession: function () { return Promise.resolve({ error: null }); },
        },
      };
    },
  };
})();
