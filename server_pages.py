"""局域网服务页面的 HTML。

单独放一个文件，因为它是**给浏览器看的**，和界面的 QSS 完全两套东西。
写在这里的好处是模板和逻辑分开：改样子不用碰 server.py。

配色跟桌面端一致（冷灰蓝 + 低饱和强调），员工打开时不会觉得是两个系统。
页面用原生 HTML + 一点点内联 CSS，没有外部依赖——
员工的浏览器可能很旧，也不一定连得上外网。
"""
from string import Template

#: 颜色 token 和 theme.py 保持一致，改配色时两边一起改
COLORS = {
    "bg": "#f4f5f7",
    "panel": "#ffffff",
    "line": "#e3e6ea",
    "line_soft": "#eceef1",
    "fg": "#2f3540",
    "fg_soft": "#4d5563",
    "fg_dim": "#78828f",
    "accent": "#7c93ad",
    "accent_dim": "#5f7893",
    "accent_wash": "#e9eef4",
    "accent_edge": "#b6c5d4",
    "ok": "#6f9a78",
    "warn": "#c0a860",
    "risk": "#c08457",
    "severe": "#a8606a",
}

BASE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>$title</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 16px 40px;
    background: $bg; color: $fg;
    font-family: "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
    font-size: 15px; line-height: 1.7;
  }
  .wrap { max-width: 560px; margin: 0 auto; }
  .head { margin-bottom: 18px; }
  .head h1 { font-size: 17px; margin: 0 0 3px; color: $fg; }
  .head p { margin: 0; font-size: 13px; color: $fg_dim; }
  .card {
    background: $panel; border: 1px solid $line; border-radius: 10px;
    padding: 18px 20px; margin-bottom: 16px;
  }
  label { display: block; font-size: 13px; color: $fg_soft;
          margin: 14px 0 6px; font-weight: 600; }
  label:first-child { margin-top: 0; }
  select, input, textarea {
    width: 100%; padding: 10px 12px; font-size: 15px;
    font-family: inherit; color: $fg;
    background: #fff; border: 1px solid $line; border-radius: 8px;
  }
  select:focus, input:focus, textarea:focus {
    outline: none; border-color: $accent_edge;
  }
  textarea { resize: vertical; min-height: 74px; }
  .row2 { display: flex; gap: 12px; }
  .row2 > div { flex: 1; }
  .hint { font-size: 12.5px; color: $fg_dim; margin-top: 6px; }
  button {
    margin-top: 20px; width: 100%; padding: 13px;
    font-size: 15px; font-family: inherit; font-weight: 600;
    color: #fff; background: $accent; border: none; border-radius: 9px;
    cursor: pointer;
  }
  button:hover { background: $accent_dim; }
  button:disabled { background: #c6ccd4; cursor: default; }
  .steps { max-height: 320px; overflow-y: auto;
           border: 1px solid $line_soft; border-radius: 8px; }
  .step {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-bottom: 1px solid $line_soft;
  }
  .step:last-child { border-bottom: none; }
  .step input[type=checkbox] { width: 18px; height: 18px; flex: 0 0 auto;
                               accent-color: $accent; }
  .step .name { flex: 1; font-size: 14px; }
  .step .who { font-size: 12px; color: $fg_dim; flex: 0 0 auto; }
  .step.done .name { color: $fg_dim; text-decoration: line-through; }
  .tag {
    display: inline-block; padding: 1px 8px; border-radius: 9px;
    font-size: 11.5px; font-weight: 600; color: #fff;
  }
  .tag.进行中 { background: $accent_dim; }
  .tag.已阻塞 { background: $severe; }
  .tag.未开始 { background: $fg_dim; }
  .tag.已完成 { background: $ok; }
  .flash {
    padding: 12px 16px; border-radius: 9px; margin-bottom: 16px;
    font-size: 14px;
  }
  .flash.ok { background: #e8f0ea; border: 1px solid #bcd4c2; color: #3f6b4a; }
  .flash.bad { background: #f6e9e9; border: 1px solid #ddbfbf; color: #8a4a4a; }
  .empty { padding: 26px; text-align: center; color: $fg_dim; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-size: 12.5px; color: $fg_dim; font-weight: 600;
       padding: 6px 8px 8px; border-bottom: 1px solid $line; }
  td { padding: 9px 8px; border-bottom: 1px solid $line_soft; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; white-space: nowrap; }
  .foot { text-align: center; font-size: 12px; color: $fg_dim; margin-top: 22px; }
  @media (max-width: 480px) { .row2 { flex-direction: column; gap: 0; } }
</style>
</head>
<body>
<div class="wrap">
$body
<div class="foot">数据直接写入老板电脑的项目记录器，不需要安装任何东西。</div>
</div>
</body>
</html>
"""


def render(title, body):
    """渲染整页。$ 占位符只做一次替换，避免模板里的 $ 被误吃。"""
    colors = {key: value for key, value in COLORS.items()}
    colors["title"] = title
    colors["body"] = body
    return Template(BASE).safe_substitute(colors)


# ---------------------------------------------------------------- 提交页
SUBMIT_BODY = """
<div class="head">
  <h1>汇报工作</h1>
  <p>填今天做了什么，提交后老板那边立刻能看到。</p>
</div>

$flash

<form method="post" action="/submit" id="form">
  <div class="card">
    <label for="employee">你是谁</label>
    <select name="employee_id" id="employee" required>
      $employee_options
    </select>

    <div class="row2">
      <div>
        <label for="date">日期</label>
        <input type="date" name="work_date" id="date" value="$today" required>
      </div>
      <div>
        <label for="hours">工时（小时）</label>
        <input type="number" name="hours" id="hours" value="8"
               min="0.5" max="24" step="0.5" required>
      </div>
    </div>

    <label for="project">项目</label>
    <select name="project_id" id="project" required>
      <option value="">请选择项目</option>
      $project_options
    </select>
    <div class="hint">必须选一个——忘了选的话，工时会变成「非项目」，事后分不清。</div>

    <div id="step_box" style="display:none">
      <label for="step">具体是哪一步（可选）</label>
      <select name="step_id" id="step">
        <option value="">不指定步骤</option>
      </select>
    </div>

    <label for="content">做了什么</label>
    <textarea name="content" id="content"
              placeholder="例：调通了订单接口的鉴权，顺手补了两个用例"></textarea>
  </div>

  <div class="card">
    <label>顺手勾一下完成情况（可选）</label>
    <div class="hint" style="margin:0 0 10px">
      勾上并提交，就把这一步标记为「已完成」。不是你的步骤就别勾。
    </div>
    <div class="steps">
      $step_checkboxes
    </div>
  </div>

  <button type="submit" id="submit">提交</button>
</form>

<script>
// 项目变了，下面的步骤下拉跟着变。步骤数据由服务端注入，不用再请求一次。
var STEPS = $steps_json;

function refreshSteps() {
  var projectId = document.getElementById('project').value;
  var box = document.getElementById('step_box');
  var select = document.getElementById('step');
  var list = STEPS[projectId] || [];
  select.innerHTML = '<option value="">不指定步骤</option>';
  list.forEach(function (item) {
    var option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    select.appendChild(option);
  });
  box.style.display = list.length ? 'block' : 'none';
}

document.getElementById('project').addEventListener('change', refreshSteps);
refreshSteps();

// 防重复提交：点一次就禁用按钮，避免网络慢时连点造成两条记录
document.getElementById('form').addEventListener('submit', function () {
  var button = document.getElementById('submit');
  button.disabled = true;
  button.textContent = '正在提交…';
});
</script>
"""


def submit_page(employee_options, project_options, step_checkboxes,
                steps_json, today, flash=""):
    body = Template(SUBMIT_BODY).safe_substitute(
        flash=flash,
        employee_options=employee_options,
        project_options=project_options,
        step_checkboxes=step_checkboxes,
        steps_json=steps_json,
        today=today,
    )
    return render("汇报工作", body)


# ---------------------------------------------------------------- 老板看的记录
RECORDS_BODY = """
<div class="head">
  <h1>最近提交</h1>
  <p>这是所有人通过网页报上来的记录。</p>
</div>
$flash
<div class="card">
  $rows
</div>
<p style="text-align:center">
  <a href="/" style="color:$accent_dim">继续汇报</a>
</p>
"""


def records_page(rows_html, flash=""):
    body = Template(RECORDS_BODY).safe_substitute(rows=rows_html, flash=flash)
    return render("最近提交", body)


# ---------------------------------------------------------------- 出错页
ERROR_BODY = """
<div class="head">
  <h1>$heading</h1>
</div>
<div class="card">
  <p style="margin:0; color:$fg_soft">$message</p>
</div>
<p style="text-align:center">
  <a href="/" style="color:$accent_dim">返回汇报页</a>
</p>
"""


def error_page(heading, message):
    body = Template(ERROR_BODY).safe_substitute(heading=heading, message=message)
    return render(heading, body)
