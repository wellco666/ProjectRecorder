"""局域网服务：员工用浏览器提交工时，直接写进老板的数据库。

为什么选这个方案（而不是让员工也装程序）：
    · 员工**零安装**——发一个网址就行。发 exe 要过杀软、SmartScreen、
      还得手动更新，而网址永远不会过期。
    · 老板端不用改数据层，服务只是往现有的 SQLite 里写。
    · 只在局域网内，不碰公网。

安全边界（说清楚，别让人误以为很安全）：
    **没有任何认证。** 同一个局域网内、知道地址的人都能提交。
    这是有意为之——员工名单在公司内部本来就不是秘密，
    加密码反而会让「今天忘带密码」变成不交工时的理由。
    如果哪天需要更强的隔离，应该在网络层做（VLAN / 只开特定端口），
    而不是在这里塞一个自己写的登录框。

线程模型：
    HTTPServer 跑在后台线程，用**独立的 Store 连接**写库
    （sqlite3 连接不能跨线程共用），并与界面共用一把写锁。
    写完之后通知界面刷新——因为界面是 Qt 的，不能直接从别的线程碰控件，
    所以用 Qt 信号转到主线程。
"""
import datetime
import hmac
import html
import json
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

from PyQt6.QtCore import QObject, pyqtSignal

import server_pages
from metrics import parse_date

DEFAULT_PORT = 8765
MAX_BODY = 64 * 1024        # 表单不该有 64KB 以上，防一下超大请求


def local_ip():
    """猜出本机在局域网里的地址。

    办法是「连一个外网地址但不真的发包」——UDP socket 的 connect
    不会产生流量，只是让系统选出到外网会走哪张网卡，那个网卡的地址
    就是同事能访问到的地址。比遍历网卡再挑一个靠谱。
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("223.5.5.5", 80))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


class _Bridge(QObject):
    """把「有人提交了」从服务线程转成 Qt 信号，供界面安全刷新"""

    submitted = pyqtSignal(str, str)     # (谁, 做了什么)


class SubmitServer:
    """局域网提交服务。start() 后一直跑，stop() 干净退出。"""

    def __init__(self, store, port=DEFAULT_PORT, on_submit=None, token=""):
        self.store = store
        self.port = port
        self.on_submit = on_submit
        #: 老板看板的访问口令。**老板版才有**——
        #: 员工提交页不需要，那是给员工用的，不该让员工记额外的东西。
        #: 口令由主窗口生成并存在设置里，所以手机上的网址可以一直用。
        self.token = token
        self.bridge = _Bridge()
        self._server = None
        self._thread = None
        self._running = False
        self.last_error = ""

    # ------------------------------------------------------------ 口令
    def check_token(self, value):
        """口令是否对。没设置口令时视为不需要（不该发生，兜底用）。"""
        if not self.token:
            return True
        return hmac.compare_digest(str(value or ""), str(self.token))

    # ------------------------------------------------------------ 生命周期
    @property
    def running(self):
        return self._running

    def url(self):
        return f"http://{local_ip()}:{self.port}/"

    def start(self):
        """启动服务。返回 (成功?, 提示文本)。"""
        if self._running:
            return True, f"服务已经在运行：{self.url()}"
        try:
            handler = _make_handler(self)
            # ThreadingHTTPServer：每个人的请求各占一个线程，
            # 一个人提交慢不会把别人卡住
            self._server = ThreadingHTTPServer(("0.0.0.0", self.port), handler)
        except OSError as error:
            self.last_error = str(error)
            if getattr(error, "errno", None) in (48, 98, 10048):
                return False, (f"端口 {self.port} 被占用了。"
                               "可能是程序已经开过一次，或者别的软件在用这个端口。"
                               "换个端口再试。")
            return False, f"启动失败：{error}"

        self._server.daemon_threads = True
        self._running = True
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="submit-server", daemon=True
        )
        self._thread.start()
        return True, f"服务已启动：{self.url()}"

    def stop(self):
        if not self._running:
            return
        self._running = False
        if self._server is not None:
            # shutdown() 会等当前请求处理完，所以不能在服务线程里调
            threading.Thread(target=self._server.shutdown, daemon=True).start()
            self._server = None
        self._thread = None

    # ------------------------------------------------------------ 处理提交
    def submit_worklog(self, form):
        """处理一次工时提交。返回 (成功?, 给用户看的话)。

        校验全部在这里做：浏览器端校验只是体验，
        绕过它是很容易的，所以服务端必须自己再验一遍。
        """
        employee_id = _to_int(form.get("employee_id"))
        project_id = _to_int(form.get("project_id"))
        step_id = _to_int(form.get("step_id"))
        # 文字字段也必须先拆包：parse_qs 的结果每个值都是列表，
        # 直接 .strip() 会 AttributeError——这个坑让首次提交必崩。
        work_date = _to_text(form.get("work_date")).strip()
        content = _to_text(form.get("content")).strip()
        hours = _to_float(form.get("hours"))

        if employee_id is None:
            return False, "请先选择你是谁。"
        employee = self.store.employee(employee_id)
        if employee is None:
            return False, "这个人不在员工名单里，可能已经被删掉了。"

        if hours is None or hours <= 0:
            return False, "工时要填一个大于 0 的数字。"
        if hours > 24:
            return False, "一天不可能超过 24 小时，请检查一下。"

        date = _parse_date(work_date)
        if date is None:
            return False, "日期格式不对。"
        # 允许补报前几天，但不允许填未来——未来工时没有意义
        if date > datetime.date.today():
            return False, "不能填未来的日期。"

        # 项目必填。故意不把空项目当成「非项目事务」——
        # 那样员工漏选时工时会静悄悄地归到「非项目」，
        # 事后分不清是「真的非项目工作」还是「漏选了」。
        # 非项目事务留给老板在桌面端记。
        if project_id is None:
            return False, "请选择项目。"
        project = self.store.project(project_id)
        if project is None:
            return False, "这个项目不存在了，刷新页面重新选一个。"
        if project["status"] in ("已交付", "已取消"):
            return False, (f"《{project['name']}》已经"
                           f"{project['status']}，不能再报工时。")

        # 步骤必须属于所选项目，否则就是前端被改过
        if step_id is not None:
            step = self.store.one("SELECT * FROM step WHERE id = ?", (step_id,))
            if step is None or step["project_id"] != project_id:
                step_id = None

        # 去重：员工连点两下提交、或者网络慢重复提交，
        # 指纹一样就是同一次汇报，不该变成两条记录。
        # 真在下午又干了同样时长、写了同样说明的话，
        # 说明里加一句区分就行——那比静默丢记录好。
        existing = self.store.find_duplicate_worklog({
            "employee_id": employee_id,
            "project_id": project_id,
            "work_date": date.isoformat(),
            "hours": hours,
            "content": content,
        })
        if existing is not None:
            return False, ("这条已经提交过了（同样的日期、项目和工时）。"
                           "如果是下午又干了活，把「做了什么」写具体一点再提交。")

        self.store.add_worklog({
            "employee_id": employee_id,
            "project_id": project_id,
            "step_id": step_id,
            "work_date": date.isoformat(),
            "hours": hours,
            "content": content,
            "source": "lan",
        }, dedupe=True)

        # 勾了「已完成」的步骤一并标记。
        # getlist 拿到的是一组步骤 id（复选框可以勾多个）
        done_names = []
        for raw in form.get("done_step") or []:
            done_id = _to_int(raw)
            if done_id is None:
                continue
            step = self.store.one("SELECT * FROM step WHERE id = ?", (done_id,))
            if step is None or step["project_id"] != project_id:
                continue
            # 只在没完成时才改，避免把别人刚改的状态覆盖回去
            if step["status"] != "已完成":
                self.store.update_step(done_id, {"status": "已完成", "progress": 100})
                done_names.append(step["name"])

        message = f"已记录 {employee['name']} {date.strftime('%m月%d日')} {hours:g} 小时。"
        if done_names:
            message += "同时标记完成：" + "、".join(done_names) + "。"

        # 通知界面刷新（跨线程，走 Qt 信号）
        self.bridge.submitted.emit(employee["name"], message)
        return True, message


def _make_handler(owner):
    """生成请求处理器。放在函数里是为了让它拿到 owner 的引用。"""

    class Handler(BaseHTTPRequestHandler):
        server_version = "ProjectRecorder"

        # 默认的日志会往 stderr 打一堆东西，打包成 exe 后没人看得到，
        # 关掉避免污染控制台
        def log_message(self, fmt, *args):
            return

        # ---------------------------------------------------- 输出
        def _send_html(self, text, status=200):
            payload = text.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            # 局域网内部工具，禁止缓存免得同事看到旧页面
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def _send_json(self, data, status=200):
            payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def _need_token_page(self):
            return server_pages.error_page(
                "需要访问口令",
                "手机版能看到预算和工时，所以加了道口令。\n"
                "在电脑上点「员工提交 → 显示手机版地址」，"
                "用那里给出的完整网址打开（网址里带了口令）。",
            )

        def _redirect(self, location):
            self.send_response(303)
            self.send_header("Location", location)
            self.end_headers()

        # ---------------------------------------------------- 路由
        def do_GET(self):
            try:
                path, _, query = self.path.partition("?")
                params = parse_qs(query)
                token = (_first(params.get("t")) or "").strip()

                if path in ("/", "/index.html"):
                    self._send_html(self._submit_page())
                elif path.startswith("/records"):
                    self._send_html(self._records_page())
                # 以前这里还有一条 "/mobile" 路由，伺服一个已经废弃的
                # 单文件手机页面。手机版现在是 mobile/ 里的 Capacitor
                # 工程（装 apk），那个页面和它的菜单入口都删了，
                # 所以这条路由也一起删掉——留着只会让人以为还有个
                # 网页版手机端。
                elif path.rstrip("/") == "/api/snapshot":
                    # 手机版取数据。返回和「导出手机快照」完全一样的结构，
                    # 所以手机端两条路径（联网取 / 导文件）共用同一套解析。
                    if not owner.check_token(token):
                        self._send_json({"error": "token"}, 403)
                        return
                    import submit
                    self._send_json(submit.export_snapshot(owner.store))
                else:
                    self._send_html(
                        server_pages.error_page("页面不存在", "检查一下地址。"), 404
                    )
            except BrokenPipeError:
                # 用户提交完就关了页面，正常现象
                pass

        def do_POST(self):
            if self.path != "/submit":
                self._send_html(
                    server_pages.error_page("地址不对", "提交请用汇报页的表单。"), 404
                )
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_BODY:
                self._send_html(
                    server_pages.error_page("提交内容异常", "内容为空或者太大了。"), 400
                )
                return

            raw = self.rfile.read(length).decode("utf-8", errors="replace")
            form = parse_qs(raw, keep_blank_values=True)

            try:
                ok, message = owner.submit_worklog(form)
            except Exception as error:      # noqa: BLE001 —— 服务不能因为一次提交崩掉
                ok = False
                message = f"服务器处理出错：{type(error).__name__}: {error}"

            if ok:
                flash = f'<div class="flash ok">{html.escape(message)}</div>'
                self._send_html(self._submit_page(flash=flash))
            else:
                flash = f'<div class="flash bad">{html.escape(message)}</div>'
                self._send_html(self._submit_page(flash=flash), 400)

        # ---------------------------------------------------- 页面数据
        def _submit_page(self, flash=""):
            store = owner.store
            employees = [row for row in store.employees(only_active=True)]
            projects = [row for row in store.projects()
                        if row["status"] not in ("已交付", "已取消")]

            if not employees:
                return server_pages.error_page(
                    "还没有员工",
                    "老板那边还没建员工名单，暂时没法提交。跟他说一声。",
                )
            if not projects:
                return server_pages.error_page(
                    "还没有进行中的项目",
                    "老板那边没有可以报工时的项目，跟他说一声。",
                )

            employee_options = "".join(
                f'<option value="{row["id"]}">{html.escape(row["name"])}'
                + (f'（{html.escape(row["role"])}）' if row["role"] else "")
                + "</option>"
                for row in employees
            )
            project_options = "".join(
                f'<option value="{row["id"]}">{html.escape(row["name"])}</option>'
                for row in projects
            )

            # 步骤下拉的数据一次性注入页面，切换项目时不用再请求
            steps_map = {}
            for row in projects:
                steps_map[str(row["id"])] = [
                    {"id": str(step["id"]), "name": step["name"]}
                    for step in store.steps(row["id"])
                    if step["status"] != "已完成"
                ]

            # 「顺手勾完成」只列未完成的步骤，已完成的没必要再勾
            boxes = []
            for row in projects:
                pending = [step for step in store.steps(row["id"])
                           if step["status"] != "已完成"]
                if not pending:
                    continue
                boxes.append(
                    f'<div style="padding:8px 12px 4px;font-size:12.5px;'
                    f'color:{server_pages.COLORS["fg_dim"]}">'
                    f'{html.escape(row["name"])}</div>'
                )
                for step in pending:
                    owner_name = step["owner"] or "未指定"
                    boxes.append(
                        '<label class="step">'
                        f'<input type="checkbox" name="done_step" '
                        f'value="{step["id"]}">'
                        f'<span class="name">{html.escape(step["name"])}</span>'
                        f'<span class="who">{html.escape(owner_name)}</span>'
                        f'<span class="tag {html.escape(step["status"])}">'
                        f'{html.escape(step["status"])}</span>'
                        "</label>"
                    )
            step_checkboxes = "".join(boxes) or (
                '<div class="empty">所有步骤都完成了，没有要勾的。</div>'
            )

            return server_pages.submit_page(
                employee_options=employee_options,
                project_options=project_options,
                step_checkboxes=step_checkboxes,
                steps_json=json.dumps(steps_map, ensure_ascii=False),
                today=datetime.date.today().isoformat(),
                flash=flash,
            )

        def _records_page(self, flash=""):
            store = owner.store
            rows = store.query(
                """SELECT w.work_date, w.hours, w.content,
                          e.name AS employee_name, p.name AS project_name
                   FROM worklog w
                   LEFT JOIN employee e ON e.id = w.employee_id
                   LEFT JOIN project p ON p.id = w.project_id
                   ORDER BY w.id DESC LIMIT 40"""
            )
            if not rows:
                return server_pages.records_page(
                    '<div class="empty">还没有任何记录。</div>'
                )
            body = ["<table><tr><th>日期</th><th>谁</th><th>项目</th>"
                    "<th style='text-align:right'>工时</th></tr>"]
            for row in rows:
                body.append(
                    "<tr>"
                    f'<td>{html.escape(row["work_date"] or "")}</td>'
                    f'<td>{html.escape(row["employee_name"] or "—")}</td>'
                    f'<td>{html.escape(row["project_name"] or "非项目")}'
                    + (f'<div style="font-size:12.5px;color:'
                       f'{server_pages.COLORS["fg_dim"]}">'
                       f'{html.escape((row["content"] or "")[:40])}</div>'
                       if row["content"] else "")
                    + "</td>"
                    f'<td class="num">{float(row["hours"] or 0):g}</td>'
                    "</tr>"
                )
            body.append("</table>")
            return server_pages.records_page("".join(body), flash=flash)

    return Handler


# ---------------------------------------------------------------- 小工具
def _first(value):
    """parse_qs 的结果统一是列表，这里取出单个值。

    这是最容易写错的地方：`form.get("employee_id")` 拿到的是
    `['3']` 而不是 `'3'`，直接 int() 会抛异常。
    """
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _to_text(value):
    """取表单里的文字字段，保证返回 str（永远不是列表）。

    所有从 form 里取的值都要过这层——
    parse_qs 把每个字段都包成列表，
    忘了拆包的下场就是 `'list' object has no attribute 'strip'`。
    """
    value = _first(value)
    if value is None:
        return ""
    return str(value)


def _to_int(value):
    value = _first(value)
    if value is None or value == "":
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _to_float(value):
    value = _first(value)
    if value is None or value == "":
        return None
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _parse_date(value):
    return parse_date(_first(value))
