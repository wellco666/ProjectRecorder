"""Preview and migrate desktop SQLite data into the unified cloud platform.

Usage:
  python cloud_migration.py --dry-run
  python cloud_migration.py --apply --yes

Login once in the desktop app before running --apply. The saved refresh token
is reused; passwords are never written by this script.
"""
import argparse
import datetime
import json
import os
import shutil
import sys

from cloud_integration import CloudIntegrationClient
from community_client import CommunityClient, CommunitySession, CommunityError
from db import DB_DIR, DB_PATH, Store

SESSION_KEY = "community_session"
BOSS_CODE = "19155037002"


def load_session():
    path = os.path.join(DB_DIR, "settings.json")
    try:
        with open(path, "r", encoding="utf-8") as file:
            raw = json.load(file).get(SESSION_KEY, {})
    except (OSError, ValueError):
        raw = {}
    return CommunitySession.from_dict(raw)


def ensure_session(session):
    if session is None:
        raise RuntimeError("电脑端还没有登录。请先在软件右上角登录手机版账号。")
    if session.is_expired():
        session = CommunityClient().refresh(session)
    if session.profile.get("code") != BOSS_CODE:
        raise RuntimeError(
            f"当前登录账号是 {session.profile.get('code') or '未知'}，"
            f"预期主老板账号是 {BOSS_CODE}。"
        )
    return session


def build_preview(store, client):
    profiles = client.list("profiles", {"select": "*"})
    projects = client.list("projects", {"select": "id,name,boss_id"})
    profile_by_name = {}
    for profile in profiles:
        profile_by_name.setdefault(profile.get("name", ""), []).append(profile)
    cloud_names = {row.get("name", "") for row in projects}
    unmapped = [
        row["name"] for row in store.employees()
        if len(profile_by_name.get(row["name"], [])) != 1
    ]
    duplicate_projects = [
        row["name"] for row in store.projects()
        if row["name"] in cloud_names
    ]
    return {
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "boss_code": BOSS_CODE,
        "local": {
            "projects": len(store.projects()),
            "steps": store.scalar("SELECT COUNT(*) FROM step", (), 0),
            "employees": len(store.employees()),
            "worklogs": store.scalar("SELECT COUNT(*) FROM worklog", (), 0),
            "assignments": store.scalar("SELECT COUNT(*) FROM assignment", (), 0),
            "assessments": store.scalar("SELECT COUNT(*) FROM assessment", (), 0),
            "metrics": store.scalar("SELECT COUNT(*) FROM metric", (), 0),
            "knowledge": store.scalar("SELECT COUNT(*) FROM knowledge", (), 0),
            "reflections": store.scalar(
                "SELECT COUNT(*) FROM knowledge_reflection", (), 0
            ),
        },
        "cloud": {
            "profiles": len(profiles),
            "projects": len(projects),
        },
        "warnings": {
            "employees_without_unique_cloud_profile": unmapped,
            "local_projects_with_same_cloud_name": duplicate_projects,
        },
    }


def backup_database():
    folder = os.path.join(DB_DIR, "backups")
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    target = os.path.join(folder, f"projects-before-unified-{stamp}.db")
    shutil.copy2(DB_PATH, target)
    return target


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="write to cloud")
    parser.add_argument("--dry-run", action="store_true", help="preview only (default)")
    parser.add_argument("--yes", action="store_true", help="skip confirmation")
    parser.add_argument("--report", default="", help="preview report JSON path")
    args = parser.parse_args(argv)
    if args.apply and args.dry_run:
        parser.error("--apply and --dry-run cannot be used together")

    session = ensure_session(load_session())
    store = Store()
    try:
        client = CloudIntegrationClient(session)
        preview = build_preview(store, client)
        report_path = args.report or os.path.join(
            DB_DIR,
            f"integration-preview-{datetime.datetime.now():%Y%m%d-%H%M%S}.json",
        )
        with open(report_path, "w", encoding="utf-8") as file:
            json.dump(preview, file, ensure_ascii=False, indent=2)
        print(json.dumps(preview, ensure_ascii=False, indent=2))
        print(f"\n预览报告：{report_path}")
        if not args.apply:
            print("当前是 dry-run，没有写入云端。确认后使用 --apply。")
            return 0

        warnings = preview["warnings"]
        if warnings["employees_without_unique_cloud_profile"]:
            raise RuntimeError(
                "有员工无法唯一匹配云端账号，请先处理："
                + "、".join(warnings["employees_without_unique_cloud_profile"])
            )
        if not args.yes:
            answer = input("确认迁移到云端？输入 yes 继续：").strip().lower()
            if answer != "yes":
                print("已取消。")
                return 0

        backup = backup_database()
        print(f"已备份本地数据库：{backup}")
        client.sync_all(store)
        print("迁移完成：项目、步骤、知识和云端业务数据已同步。")
        return 0
    except (RuntimeError, CommunityError, OSError) as error:
        print(f"迁移失败：{error}", file=sys.stderr)
        return 1
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
