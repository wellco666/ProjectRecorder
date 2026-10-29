"""清空数据库：把 ~/ProjectRecorder/projects.db 里的数据全删掉。

用法：
    py clear_data.py           # 列出当前内容，问你要不要清
    py clear_data.py --yes     # 不问，直接清

项目、员工、工时、分配、评估、指标全部删除。
**只删数据库内容，不删文件本身**——表结构会保留，清完可以直接用。

什么时候用得上：想把库清干净从零开始，又不想手动去删 sqlite 文件。
"""
import os
import sys

from db import DB_PATH, Store

TABLES = [
    ("project", "项目"),
    ("step", "步骤"),
    ("employee", "员工"),
    ("worklog", "工时记录"),
    ("assignment", "任务分配"),
    ("assessment", "能力与资源评估"),
    ("metric", "指标数据"),
]


def summarise(store):
    lines = []
    for table, label in TABLES:
        count = store.scalar(f"SELECT COUNT(*) FROM {table}", (), 0)
        lines.append(f"　{label}：{count}")
    return lines


def main():
    if not os.path.isfile(DB_PATH):
        print(f"还没有数据库文件：{DB_PATH}")
        print("启动一次程序会自动创建。")
        return 0

    store = Store()
    try:
        print(f"数据库：{DB_PATH}")
        print("当前内容：")
        for line in summarise(store):
            print(line)

        total = sum(store.scalar(f"SELECT COUNT(*) FROM {t}", (), 0)
                    for t, _ in TABLES if t != "project")
        projects = store.scalar("SELECT COUNT(*) FROM project", (), 0)
        if not projects and not total:
            print("\n已经是空的，不用清。")
            return 0

        if "--yes" not in sys.argv:
            print("\n这些数据会被全部删除，无法撤销。")
            answer = input("确认清空？输入 yes 继续：").strip().lower()
            if answer != "yes":
                print("已取消，什么都没动。")
                return 0

        # 按依赖倒序删，外键约束下顺序错了会报错
        for table, label in reversed(TABLES):
            store.execute(f"DELETE FROM {table}")
        # 重置自增序号，新建的项目从 1 开始
        store.execute(
            "DELETE FROM sqlite_sequence WHERE name IN "
            "('project','step','employee','worklog','assignment','assessment','metric')"
        )
        print("\n已清空。")
        print("当前内容：")
        for line in summarise(store):
            print(line)
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
