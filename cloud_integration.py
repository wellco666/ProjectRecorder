"""Cloud integration client shared by the desktop collaboration UI."""
import datetime
import uuid

from community_client import CommunityError, _request

__all__ = ["CloudIntegrationClient", "CloudIntegrationError"]

CloudIntegrationError = CommunityError

_SELECTABLE = {
    "profiles", "projects", "project_steps", "tasks", "task_logs",
    "worklogs", "work_sessions", "merit_ledger", "rewards",
    "redemptions", "leave_requests", "knowledge_items",
    "knowledge_links", "knowledge_reflections",
}


class CloudIntegrationClient:
    def __init__(self, session):
        if session is None:
            raise CloudIntegrationError("请先登录手机版账号")
        self.session = session

    def _token(self):
        return self.session.access_token

    def list(self, table, params=None):
        if table not in _SELECTABLE:
            raise CloudIntegrationError(f"unsupported table: {table}")
        rows = _request(
            "GET", f"/rest/v1/{table}", token=self._token(),
            params=params or {"select": "*"},
        )
        return rows if isinstance(rows, list) else []

    def rpc(self, name, body=None):
        return _request(
            "POST", f"/rest/v1/rpc/{name}", token=self._token(),
            body=body or {},
        )

    def snapshot(self):
        try:
            self.rpc("settle_due_grades")
        except CommunityError:
            pass
        tables = [
            "projects", "project_steps", "tasks", "task_logs", "worklogs",
            "work_sessions", "merit_ledger", "rewards", "redemptions",
            "leave_requests", "profiles", "knowledge_items",
            "knowledge_links", "knowledge_reflections",
        ]
        result = {}
        for table in tables:
            order = "updated_at.desc" if table in (
                "projects", "project_steps", "tasks", "task_logs",
                "knowledge_items"
            ) else "created_at.desc"
            result[table] = self.list(table, {
                "select": "*", "order": order, "limit": 500,
            })
        return result

    def create_task(self, data):
        task_id = str(uuid.uuid4())
        row = {
            "id": task_id,
            "boss_id": self.session.user_id,
            "employee_id": data["employee_id"],
            "title": str(data.get("title") or "").strip(),
            "detail": str(data.get("detail") or "").strip(),
            "plan_date": data.get("plan_date") or datetime.date.today().isoformat(),
            "est_hours": max(0, float(data.get("est_hours") or 0)),
            "project_id": data.get("project_id") or None,
            "step_id": data.get("step_id") or None,
            "accept_status": "pending",
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        rows = _request(
            "POST", "/rest/v1/tasks", token=self._token(), body=row,
            params={"select": "*"},
        )
        return rows[0] if isinstance(rows, list) and rows else row

    def start_work(self, task_id=None):
        return self.rpc("start_work", {"p_task": task_id})

    def end_work(self):
        return self.rpc("end_work")

    def grade_task(self, task_id, grade):
        return self.rpc("grade_task", {"p_task": task_id, "p_grade": grade})

    def approve_worklog(self, worklog_id):
        return self.rpc("approve_worklog", {"p_worklog": worklog_id})

    def decide_redemption(self, redemption_id, given, note=""):
        return self.rpc("decide_redemption", {
            "p_redemption": redemption_id, "p_given": bool(given),
        })

    def decide_leave(self, leave_id, approved, note=""):
        return self.rpc("decide_leave", {
            "p_leave": leave_id, "p_approved": bool(approved),
            "p_note": str(note or ""),
        })

    def redeem_reward(self, reward_id):
        return self.rpc("redeem_reward", {"p_reward": reward_id})

    def save_project(self, project_id, version, data):
        return self.rpc("save_project", {
            "p_id": project_id, "p_version": version, "p_data": data,
        })

    def save_step(self, step_id, project_id, version, data):
        return self.rpc("save_project_step", {
            "p_id": step_id, "p_project": project_id,
            "p_version": version, "p_data": data,
        })

    def save_knowledge(self, knowledge_id, version, data):
        return self.rpc("save_knowledge_item", {
            "p_id": knowledge_id, "p_version": version, "p_data": data,
        })

    def sync_local_baseline(self, store):
        """Push local projects/steps/knowledge and map them to cloud UUIDs."""
        profiles = self.list("profiles", {"select": "*"})
        by_name = {}
        for profile in profiles:
            by_name.setdefault(profile.get("name", ""), []).append(profile)
        for employee in store.employees():
            if employee["cloud_profile_id"]:
                continue
            matches = by_name.get(employee["name"], [])
            if len(matches) == 1:
                store.execute(
                    "UPDATE employee SET cloud_profile_id=? WHERE id=?",
                    (matches[0]["id"], employee["id"]),
                )

        project_map = {
            row["id"]: row["cloud_id"] for row in store.projects()
            if row["cloud_id"]
        }
        for project in store.projects():
            if project["cloud_id"]:
                continue
            data = {
                "name": project["name"], "owner": project["owner"],
                "client": project["client"], "status": project["status"],
                "priority": project["priority"],
                "start_date": project["start_date"], "due_date": project["due_date"],
                "budget": project["budget"], "cost": project["cost"],
                "progress": project["progress"], "note": project["note"],
            }
            cloud = self.save_project(None, None, data)
            cloud_id = cloud.get("id")
            if cloud_id:
                store.execute(
                    "UPDATE project SET cloud_id=?, version=? WHERE id=?",
                    (cloud_id, int(cloud.get("version") or 1), project["id"]),
                )
                project_map[project["id"]] = cloud_id

        for step in store.query("SELECT * FROM step ORDER BY project_id, seq"):
            if step["cloud_id"]:
                continue
            project_cloud = project_map.get(step["project_id"])
            if not project_cloud:
                continue
            data = {
                "seq": step["seq"], "name": step["name"], "owner": step["owner"],
                "status": step["status"], "start_date": step["start_date"],
                "due_date": step["due_date"], "progress": step["progress"],
                "note": step["note"],
            }
            cloud = self.save_step(None, project_cloud, None, data)
            if cloud.get("id"):
                store.execute(
                    "UPDATE step SET cloud_id=?, version=? WHERE id=?",
                    (cloud["id"], int(cloud.get("version") or 1), step["id"]),
                )

        for item in store.knowledge_items():
            if item["cloud_id"]:
                continue
            data = {
                "title": item["title"], "content": item["content"],
                "zone": item["zone"], "kind": item["kind"],
                "source": item["source"], "tags": item["tags"],
                "project_id": project_map.get(item["project_id"]),
                "importance": item["importance"], "status": item["status"],
                "next_review": item["next_review"],
            }
            cloud = self.save_knowledge(None, None, data)
            if cloud.get("id"):
                store.execute(
                    "UPDATE knowledge SET cloud_id=?, version=? WHERE id=?",
                    (cloud["id"], int(cloud.get("version") or 1), item["id"]),
                )

    def merge_cloud_projects(self, store):
        project_map = {}
        for cloud in self.list("projects", {"select": "*", "order": "updated_at.desc"}):
            local = store.one("SELECT * FROM project WHERE cloud_id=?", (cloud["id"],))
            if local is None:
                project_id = store.add_project(cloud)
                store.execute(
                    "UPDATE project SET cloud_id=?, version=? WHERE id=?",
                    (cloud["id"], int(cloud.get("version") or 1), project_id),
                )
            else:
                project_id = local["id"]
                if int(cloud.get("version") or 1) > int(local["version"] or 1):
                    store.update_project(project_id, {
                        "name": cloud["name"], "owner": cloud.get("owner", ""),
                        "client": cloud.get("client", ""), "status": cloud.get("status", ""),
                        "priority": cloud.get("priority", ""),
                        "start_date": cloud.get("start_date") or "",
                        "due_date": cloud.get("due_date") or "",
                        "budget": cloud.get("budget", 0), "cost": cloud.get("cost", 0),
                        "progress": cloud.get("progress", 0), "note": cloud.get("note", ""),
                    })
                    store.execute("UPDATE project SET version=? WHERE id=?",
                                  (int(cloud.get("version") or 1), project_id))
            project_map[cloud["id"]] = project_id

        for cloud in self.list("project_steps", {"select": "*", "order": "seq"}):
            local = store.one("SELECT * FROM step WHERE cloud_id=?", (cloud["id"],))
            if local is None and cloud.get("project_id") in project_map:
                step_id = store.add_step(project_map[cloud["project_id"]], cloud)
                store.execute("UPDATE step SET cloud_id=?, version=? WHERE id=?",
                              (cloud["id"], int(cloud.get("version") or 1), step_id))
        return project_map

    def merge_cloud_worklogs(self, store, project_map):
        employee_map = {
            row["cloud_profile_id"]: row["id"] for row in store.employees()
            if row["cloud_profile_id"]
        }
        for log in self.list("worklogs", {"select": "*", "order": "work_date.desc", "limit": 500}):
            if store.one("SELECT id FROM worklog WHERE cloud_id=?", (log["id"],)):
                continue
            employee_id = employee_map.get(log.get("employee_id"))
            if not employee_id:
                continue
            project_id = project_map.get(log.get("project_id"))
            step_id = store.scalar(
                "SELECT id FROM step WHERE cloud_id=?", (log.get("step_id"),), None
            ) if log.get("step_id") else None
            store.execute(
                """INSERT OR IGNORE INTO worklog(
                    employee_id, project_id, step_id, work_date, hours, content,
                    source, source_key, cloud_id, cloud_project_id, cloud_step_id,
                    approval_status
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (employee_id, project_id, step_id, log["work_date"],
                 log.get("hours", 0), log.get("content", ""),
                 log.get("source", "manual"), "cloud:" + log["id"],
                 log["id"], log.get("project_id") or "", log.get("step_id") or "",
                 log.get("approval_status", "pending")),
            )

    def sync_all(self, store):
        self.sync_local_baseline(store)
        project_map = self.merge_cloud_projects(store)
        self.merge_cloud_worklogs(store, project_map)
        return self.snapshot()
