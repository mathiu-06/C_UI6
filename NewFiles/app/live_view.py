import base64
import hmac
import json
import logging
import os
import time
import urllib.parse
from collections import OrderedDict
from io import BytesIO
from typing import Any, Optional

import aiohttp
from aiohttp import web
from PIL import Image, ImageOps

import folder_paths
from comfy.cli_args import args
from protocol import BinaryEventTypes


ASSETS_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "live_view_assets")
MAX_REPORT_BYTES = 4 * 1024 * 1024
MAX_CACHED_USERS = 200
MAX_PROMPT_MAP = 500
MAX_CLIENT_MAP = 1000
MAX_OUTPUT_NODES_PER_USER = 20
MAX_FILES_PER_NODE_OUTPUT = 12
MAX_SAVED_WORKFLOWS = 500
PREVIEW_MIN_INTERVAL = 0.15
PROGRESS_MIN_INTERVAL = 0.10


def get_live_view_token() -> Optional[str]:
    token = args.live_view_token
    if not token:
        token = os.environ.get("COMFYUI_LIVE_VIEW_TOKEN")
    if token is None:
        return None
    token = token.strip()
    return token if token else None


def redact_cli_argv(argv: list[str]) -> list[str]:
    redacted: list[str] = []
    skip_next = False
    for arg in argv:
        if skip_next:
            redacted.append("[REDACTED]")
            skip_next = False
            continue
        if arg == "--live-view-token":
            redacted.append(arg)
            skip_next = True
        elif arg.startswith("--live-view-token="):
            redacted.append("--live-view-token=[REDACTED]")
        else:
            redacted.append(arg)
    return redacted


def _now_ms() -> int:
    return int(time.time() * 1000)


def _set_bounded(mapping: OrderedDict, key: str, value: Any, max_size: int) -> None:
    if key in mapping:
        mapping.move_to_end(key)
    mapping[key] = value
    while len(mapping) > max_size:
        mapping.popitem(last=False)


def _sanitize_viewport(viewport: Any) -> Optional[dict]:
    if not isinstance(viewport, dict):
        return None
    scale = viewport.get("scale")
    offset = viewport.get("offset")
    if not isinstance(scale, (int, float)) or scale <= 0:
        return None
    if not isinstance(offset, (list, tuple)) or len(offset) < 2:
        return None
    if not isinstance(offset[0], (int, float)) or not isinstance(offset[1], (int, float)):
        return None
    return {"scale": float(scale), "offset": [float(offset[0]), float(offset[1])]}


def _sanitize_node_meta(raw: Any) -> dict:
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, dict] = {}
    for node_id, info in raw.items():
        if not isinstance(info, dict):
            continue
        entry: dict[str, Any] = {}
        title = info.get("title")
        if isinstance(title, str):
            entry["title"] = title[:200]
        widgets = info.get("widgets")
        if isinstance(widgets, list):
            clean_widgets = []
            for w in widgets[:64]:
                if not isinstance(w, dict):
                    continue
                name = w.get("name")
                if not isinstance(name, str):
                    continue
                val = w.get("value")
                if isinstance(val, str) and len(val) > 8000:
                    val = val[:8000] + "..."
                item = {
                    "name": name[:120],
                    "value": val,
                }
                label = w.get("label")
                if isinstance(label, str) and label and label != name:
                    item["label"] = label[:120]
                wtype = w.get("type")
                if isinstance(wtype, str):
                    item["type"] = wtype[:60]
                clean_widgets.append(item)
            entry["widgets"] = clean_widgets
        imgs = info.get("imgs")
        if isinstance(imgs, list):
            clean_imgs = [
                u for u in imgs[:8]
                if isinstance(u, str) and (u.startswith("/view?") or u.startswith("/api/view?"))
            ]
            if clean_imgs:
                entry["imgs"] = clean_imgs
        clean[str(node_id)] = entry
    return clean


def _workflow_counts(workflow: Any) -> tuple[int, int]:
    if not isinstance(workflow, dict):
        return 0, 0
    nodes = workflow.get("nodes")
    links = workflow.get("links")
    node_count = len(nodes) if isinstance(nodes, list) else 0
    link_count = len(links) if isinstance(links, list) else 0
    return node_count, link_count


def _extract_output_media(output: Any) -> list[dict]:
    if not isinstance(output, dict):
        return []
    items: list[dict] = []
    for key, media_kind in (("images", "image"), ("gifs", "video"), ("video", "video"), ("audio", "audio")):
        entries = output.get(key)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            filename = entry.get("filename")
            if not isinstance(filename, str) or not filename:
                continue
            subfolder = entry.get("subfolder", "")
            file_type = entry.get("type", "output")
            if not isinstance(subfolder, str) or not isinstance(file_type, str):
                continue
            if file_type not in ("output", "temp", "input"):
                continue
            items.append({
                "filename": filename,
                "subfolder": subfolder,
                "type": file_type,
                "media": media_kind,
            })
            if len(items) >= MAX_FILES_PER_NODE_OUTPUT:
                return items
    return items


class LiveViewManager:
    """Real-time, strictly read-only workflow monitor for multi-user ComfyUI."""

    def __init__(self, prompt_server):
        self.prompt_server = prompt_server
        self.user_manager = prompt_server.user_manager

        self.sessions: dict[str, dict] = {}
        self.last_user_snapshots: OrderedDict[str, dict] = OrderedDict()
        self.user_execution: dict[str, dict] = {}
        self.client_to_user: OrderedDict[str, str] = OrderedDict()
        self.prompt_to_user: OrderedDict[str, str] = OrderedDict()

        self.observers: dict[web.WebSocketResponse, dict] = {}
        self._last_preview_sent: dict[str, float] = {}
        self._last_progress_sent: dict[str, float] = {}

    def get_extension_urls(self) -> list[str]:
        return ["/extensions/live_view/reporter.js"]

    def requires_token(self) -> bool:
        return get_live_view_token() is not None

    def _extract_request_token(self, request: web.Request) -> Optional[str]:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            candidate = auth_header[7:].strip()
            if candidate:
                return candidate
        header_token = request.headers.get("X-Live-View-Token", "").strip()
        if header_token:
            return header_token
        query_token = request.rel_url.query.get("token", "").strip()
        if query_token:
            return query_token
        return None

    def is_authorized(self, request: web.Request) -> bool:
        expected = get_live_view_token()
        if expected is None:
            return True
        provided = self._extract_request_token(request)
        if not provided:
            return False
        return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))

    def _resolve_valid_user_id(self, candidate: Optional[str]) -> Optional[str]:
        if not args.multi_user:
            return "default"
        if not candidate or not isinstance(candidate, str):
            return None
        if candidate.startswith(folder_paths.SYSTEM_USER_PREFIX):
            return None
        if candidate in self.user_manager.users:
            return candidate
        return None

    def _get_username(self, user_id: str) -> str:
        if not args.multi_user:
            return "default"
        return self.user_manager.users.get(user_id, user_id)

    def _get_or_create_execution(self, user_id: str) -> dict:
        state = self.user_execution.get(user_id)
        if state is None:
            state = {
                "running": False,
                "prompt_id": None,
                "executing_node": None,
                "display_node": None,
                "progress": None,
                "error": None,
                "outputs": OrderedDict(),
                "preview": None,
                "updated_at": _now_ms(),
            }
            self.user_execution[user_id] = state
        return state

    def _serialize_execution(self, user_id: str) -> dict:
        state = self.user_execution.get(user_id)
        if state is None:
            return {
                "running": False,
                "prompt_id": None,
                "executing_node": None,
                "display_node": None,
                "progress": None,
                "error": None,
                "outputs": {},
                "preview": None,
                "updated_at": 0,
            }
        return {
            "running": state["running"],
            "prompt_id": state["prompt_id"],
            "executing_node": state["executing_node"],
            "display_node": state["display_node"],
            "progress": state["progress"],
            "error": state["error"],
            "outputs": dict(state["outputs"]),
            "preview": state["preview"],
            "updated_at": state["updated_at"],
        }

    def _get_user_sessions(self, user_id: str) -> list[dict]:
        matching = [s for s in self.sessions.values() if s["user_id"] == user_id]
        matching.sort(key=lambda s: s["updated_at"], reverse=True)
        return matching

    def _list_saved_workflows(self, user_id: str) -> list[dict]:
        valid_id = self._resolve_valid_user_id(user_id)
        if valid_id is None:
            return []
        user_root = folder_paths.get_public_user_directory(valid_id)
        if user_root is None:
            return []
        user_root_abs = os.path.abspath(user_root)
        workflows_dir = os.path.abspath(os.path.join(user_root_abs, "workflows"))
        if os.path.commonpath((user_root_abs, workflows_dir)) != user_root_abs:
            return []
        if not os.path.isdir(workflows_dir):
            return []

        results: list[dict] = []
        workflows_real = os.path.realpath(workflows_dir)
        try:
            for root, _dirs, files in os.walk(workflows_dir):
                for filename in files:
                    if not filename.lower().endswith(".json"):
                        continue
                    full_path = os.path.join(root, filename)
                    real_path = os.path.realpath(full_path)
                    if os.path.commonpath((workflows_real, real_path)) != workflows_real:
                        continue
                    rel_path = os.path.relpath(full_path, workflows_dir).replace(os.sep, "/")
                    try:
                        st = os.stat(full_path)
                        results.append({
                            "path": rel_path,
                            "name": filename,
                            "size": st.st_size,
                            "modified": int(st.st_mtime * 1000),
                        })
                    except OSError:
                        continue
                    if len(results) >= MAX_SAVED_WORKFLOWS:
                        break
                if len(results) >= MAX_SAVED_WORKFLOWS:
                    break
        except OSError as exc:
            logging.warning(f"[LiveView] Error scanning workflows for user {valid_id}: {exc}")
            return []

        results.sort(key=lambda item: item["modified"], reverse=True)
        return results

    def _read_saved_workflow(self, user_id: str, rel_path: str) -> Optional[dict]:
        valid_id = self._resolve_valid_user_id(user_id)
        if valid_id is None or not rel_path:
            return None
        if "%" in rel_path:
            rel_path = urllib.parse.unquote(rel_path)
        if not rel_path.lower().endswith(".json"):
            return None

        user_root = folder_paths.get_public_user_directory(valid_id)
        if user_root is None:
            return None
        user_root_abs = os.path.abspath(user_root)
        workflows_dir = os.path.abspath(os.path.join(user_root_abs, "workflows"))
        if os.path.commonpath((user_root_abs, workflows_dir)) != user_root_abs:
            return None
        if not os.path.isdir(workflows_dir):
            return None

        target = os.path.abspath(os.path.join(workflows_dir, rel_path))
        if os.path.commonpath((workflows_dir, target)) != workflows_dir:
            return None
        workflows_real = os.path.realpath(workflows_dir)
        target_real = os.path.realpath(target)
        if os.path.commonpath((workflows_real, target_real)) != workflows_real:
            return None
        if not os.path.isfile(target_real):
            return None

        try:
            if os.path.getsize(target_real) > MAX_REPORT_BYTES:
                return None
            with open(target_real, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else None
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return None

    def get_users_summary(self) -> list[dict]:
        user_ids: list[str] = []
        seen: set[str] = set()

        if args.multi_user:
            for uid in self.user_manager.users.keys():
                if uid.startswith(folder_paths.SYSTEM_USER_PREFIX):
                    continue
                if uid not in seen:
                    seen.add(uid)
                    user_ids.append(uid)
        else:
            seen.add("default")
            user_ids.append("default")

        for session in self.sessions.values():
            uid = session["user_id"]
            if uid not in seen and not uid.startswith(folder_paths.SYSTEM_USER_PREFIX):
                seen.add(uid)
                user_ids.append(uid)

        summaries: list[dict] = []
        for uid in user_ids:
            active_sessions = self._get_user_sessions(uid)
            primary = active_sessions[0] if active_sessions else None
            cached = self.last_user_snapshots.get(uid)
            exec_state = self.user_execution.get(uid)

            online = len(active_sessions) > 0
            running = bool(exec_state and exec_state["running"])
            workflow_name = (
                primary["workflow_name"] if primary
                else (cached["workflow_name"] if cached else None)
            )
            node_count = (
                primary["node_count"] if primary
                else (cached["node_count"] if cached else 0)
            )
            link_count = (
                primary["link_count"] if primary
                else (cached["link_count"] if cached else 0)
            )
            updated_at = (
                primary["updated_at"] if primary
                else (cached["updated_at"] if cached else 0)
            )
            has_workflow = bool(
                (primary and primary["workflow"] is not None)
                or (cached and cached["workflow"] is not None)
            )

            tabs = [
                {
                    "session_id": s["session_id"],
                    "tab_id": s["tab_id"],
                    "workflow_name": s["workflow_name"],
                    "node_count": s["node_count"],
                    "updated_at": s["updated_at"],
                }
                for s in active_sessions
            ]

            summaries.append({
                "user_id": uid,
                "username": self._get_username(uid),
                "online": online,
                "running": running,
                "executing_node": exec_state["display_node"] if running and exec_state else None,
                "progress": exec_state["progress"] if running and exec_state else None,
                "has_error": bool(exec_state and exec_state["error"]),
                "session_count": len(active_sessions),
                "tabs": tabs,
                "workflow_name": workflow_name,
                "node_count": node_count,
                "link_count": link_count,
                "updated_at": updated_at,
                "has_workflow": has_workflow,
            })

        summaries.sort(
            key=lambda u: (
                not u["running"],
                not u["online"],
                -u["updated_at"],
                u["username"].lower(),
            )
        )
        return summaries

    def get_user_snapshot(self, user_id: str, session_id: Optional[str] = None) -> Optional[dict]:
        valid_id = self._resolve_valid_user_id(user_id)
        if valid_id is None:
            return None

        active_sessions = self._get_user_sessions(valid_id)
        selected = None
        if session_id:
            for s in active_sessions:
                if s["session_id"] == session_id:
                    selected = s
                    break
        if selected is None and active_sessions:
            selected = active_sessions[0]

        if selected is not None:
            return {
                "user_id": valid_id,
                "username": self._get_username(valid_id),
                "session_id": selected["session_id"],
                "online": True,
                "workflow_name": selected["workflow_name"],
                "workflow": selected["workflow"],
                "node_meta": selected["node_meta"],
                "viewport": selected["viewport"],
                "node_count": selected["node_count"],
                "link_count": selected["link_count"],
                "updated_at": selected["updated_at"],
                "execution": self._serialize_execution(valid_id),
            }

        cached = self.last_user_snapshots.get(valid_id)
        if cached is not None:
            return {
                "user_id": valid_id,
                "username": self._get_username(valid_id),
                "session_id": None,
                "online": False,
                "workflow_name": cached["workflow_name"],
                "workflow": cached["workflow"],
                "node_meta": cached["node_meta"],
                "viewport": cached["viewport"],
                "node_count": cached["node_count"],
                "link_count": cached["link_count"],
                "updated_at": cached["updated_at"],
                "execution": self._serialize_execution(valid_id),
            }

        return {
            "user_id": valid_id,
            "username": self._get_username(valid_id),
            "session_id": None,
            "online": False,
            "workflow_name": None,
            "workflow": None,
            "node_meta": {},
            "viewport": None,
            "node_count": 0,
            "link_count": 0,
            "updated_at": 0,
            "execution": self._serialize_execution(valid_id),
        }

    def _observer_wants_user(self, sub: dict, user_id: str, session_id: Optional[str] = None) -> bool:
        mode = sub.get("mode", "focus")
        if mode == "grid":
            return True
        if sub.get("user_id") != user_id:
            return False
        wanted_session = sub.get("session_id")
        if wanted_session and session_id and wanted_session != session_id:
            return False
        return True

    def _has_observers_for_user(self, user_id: str) -> bool:
        for sub in self.observers.values():
            if self._observer_wants_user(sub, user_id):
                return True
        return False

    async def _send_observer_json(self, ws: web.WebSocketResponse, payload: dict) -> bool:
        try:
            if ws.closed:
                return False
            await ws.send_json(payload)
            return True
        except (aiohttp.ClientError, ConnectionResetError, BrokenPipeError, ConnectionError, RuntimeError):
            return False

    async def _broadcast_observers(self, event_type: str, data: Any, user_id: Optional[str] = None, session_id: Optional[str] = None) -> None:
        if not self.observers:
            return
        payload = {"type": event_type, "data": data}
        dead: list[web.WebSocketResponse] = []
        for ws, sub in list(self.observers.items()):
            if user_id is not None and not self._observer_wants_user(sub, user_id, session_id):
                continue
            ok = await self._send_observer_json(ws, payload)
            if not ok:
                dead.append(ws)
        for ws in dead:
            self.observers.pop(ws, None)

    async def _broadcast_users_summary(self) -> None:
        if not self.observers:
            return
        await self._broadcast_observers("users_summary", {
            "multi_user": bool(args.multi_user),
            "users": self.get_users_summary(),
            "queue_remaining": self.prompt_server.prompt_queue.get_tasks_remaining(),
        })

    def _update_cached_snapshot(self, user_id: str, workflow_name: str, workflow: dict, node_meta: dict, viewport: Optional[dict], updated_at: int) -> None:
        node_count, link_count = _workflow_counts(workflow)
        _set_bounded(
            self.last_user_snapshots,
            user_id,
            {
                "workflow_name": workflow_name,
                "workflow": workflow,
                "node_meta": node_meta,
                "viewport": viewport,
                "node_count": node_count,
                "link_count": link_count,
                "updated_at": updated_at,
            },
            MAX_CACHED_USERS,
        )

    def on_prompt_queued(self, request: web.Request, prompt_id: str, prompt: dict, extra_data: dict) -> None:
        client_id = extra_data.get("client_id")
        if not isinstance(client_id, str) or not client_id:
            client_id = None

        user_id: Optional[str] = None
        if args.multi_user:
            header_user = request.headers.get("comfy-user")
            user_id = self._resolve_valid_user_id(header_user)
            if user_id is None and client_id is not None:
                user_id = self._resolve_valid_user_id(self.client_to_user.get(client_id))
        else:
            user_id = "default"

        if user_id is None:
            return

        _set_bounded(self.prompt_to_user, prompt_id, user_id, MAX_PROMPT_MAP)
        if client_id is not None:
            _set_bounded(self.client_to_user, client_id, user_id, MAX_CLIENT_MAP)

        extra_pnginfo = extra_data.get("extra_pnginfo")
        if isinstance(extra_pnginfo, dict):
            workflow = extra_pnginfo.get("workflow")
            if isinstance(workflow, dict) and not self._get_user_sessions(user_id):
                now = _now_ms()
                wf_name = workflow.get("extra", {}).get("workflow_name") if isinstance(workflow.get("extra"), dict) else None
                self._update_cached_snapshot(
                    user_id=user_id,
                    workflow_name=wf_name if isinstance(wf_name, str) and wf_name else "Queued Workflow",
                    workflow=workflow,
                    node_meta={},
                    viewport=_sanitize_viewport(workflow.get("extra", {}).get("ds") if isinstance(workflow.get("extra"), dict) else None),
                    updated_at=now,
                )

    def _resolve_event_user_id(self, event: Any, data: Any, sid: Optional[str]) -> Optional[str]:
        prompt_id: Optional[str] = None
        if isinstance(data, dict):
            pid = data.get("prompt_id")
            if isinstance(pid, str):
                prompt_id = pid
        elif (
            event == BinaryEventTypes.PREVIEW_IMAGE_WITH_METADATA
            and isinstance(data, tuple)
            and len(data) == 2
            and isinstance(data[1], dict)
        ):
            pid = data[1].get("prompt_id")
            if isinstance(pid, str):
                prompt_id = pid

        if prompt_id and prompt_id in self.prompt_to_user:
            return self.prompt_to_user[prompt_id]
        if sid and sid in self.client_to_user:
            return self.client_to_user[sid]
        last_pid = getattr(self.prompt_server, "last_prompt_id", None)
        if isinstance(last_pid, str) and last_pid in self.prompt_to_user:
            return self.prompt_to_user[last_pid]
        if not args.multi_user:
            return "default"
        return None

    def _encode_preview_data_url(self, image_data: Any) -> Optional[str]:
        if not isinstance(image_data, (list, tuple)) or len(image_data) < 2:
            return None
        image_type = image_data[0]
        pil_img = image_data[1]
        if not isinstance(pil_img, Image.Image):
            return None
        try:
            resampling = Image.Resampling.BILINEAR if hasattr(Image, "Resampling") else Image.BILINEAR
            thumb = ImageOps.contain(pil_img, (384, 384), resampling)
            buf = BytesIO()
            if image_type == "PNG" and thumb.mode in ("RGBA", "LA"):
                thumb.save(buf, format="PNG", compress_level=1)
                mime = "image/png"
            else:
                if thumb.mode != "RGB":
                    thumb = thumb.convert("RGB")
                thumb.save(buf, format="JPEG", quality=75)
                mime = "image/jpeg"
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            return f"data:{mime};base64,{b64}"
        except Exception:
            return None

    async def on_server_event(self, event: Any, data: Any, sid: Optional[str] = None) -> None:
        if event == "status":
            if self.observers:
                await self._broadcast_users_summary()
            return

        if event in (BinaryEventTypes.UNENCODED_PREVIEW_IMAGE, BinaryEventTypes.PREVIEW_IMAGE_WITH_METADATA):
            user_id = self._resolve_event_user_id(event, data, sid)
            if not user_id or not self._has_observers_for_user(user_id):
                return
            now_mono = time.monotonic()
            if now_mono - self._last_preview_sent.get(user_id, 0.0) < PREVIEW_MIN_INTERVAL:
                return

            exec_state = self._get_or_create_execution(user_id)
            if event == BinaryEventTypes.PREVIEW_IMAGE_WITH_METADATA and isinstance(data, tuple) and len(data) == 2:
                image_data, meta = data
                raw_node = meta.get("display_node_id") or meta.get("node_id") if isinstance(meta, dict) else None
                node_id = str(raw_node) if raw_node is not None else exec_state["display_node"]
            else:
                image_data = data
                node_id = exec_state["display_node"]

            data_url = self._encode_preview_data_url(image_data)
            if not data_url:
                return
            self._last_preview_sent[user_id] = now_mono
            preview = {
                "node_id": node_id,
                "data_url": data_url,
                "updated_at": _now_ms(),
            }
            exec_state["preview"] = preview
            exec_state["updated_at"] = preview["updated_at"]
            await self._broadcast_observers(
                "preview_update",
                {"user_id": user_id, "preview": preview},
                user_id=user_id,
            )
            return

        if not isinstance(event, str) or not isinstance(data, dict):
            return

        if event not in (
            "execution_start",
            "executing",
            "progress",
            "progress_state",
            "executed",
            "execution_error",
            "execution_interrupted",
            "execution_success",
        ):
            return

        user_id = self._resolve_event_user_id(event, data, sid)
        if not user_id:
            return

        exec_state = self._get_or_create_execution(user_id)
        now = _now_ms()
        summary_changed = False

        if event == "execution_start":
            exec_state["running"] = True
            exec_state["prompt_id"] = data.get("prompt_id")
            exec_state["executing_node"] = None
            exec_state["display_node"] = None
            exec_state["progress"] = None
            exec_state["error"] = None
            exec_state["preview"] = None
            exec_state["updated_at"] = now
            summary_changed = True
        elif event == "executing":
            node = data.get("node")
            display_node = data.get("display_node") or node
            if node is None:
                exec_state["running"] = False
                exec_state["executing_node"] = None
                exec_state["display_node"] = None
                exec_state["progress"] = None
                exec_state["preview"] = None
                summary_changed = True
            else:
                was_running = exec_state["running"]
                exec_state["running"] = True
                exec_state["executing_node"] = str(node)
                exec_state["display_node"] = str(display_node)
                exec_state["progress"] = None
                if not was_running:
                    summary_changed = True
            exec_state["updated_at"] = now
        elif event == "progress":
            val = data.get("value", 0)
            mx = data.get("max", 0)
            node = data.get("node")
            node_str = str(node) if node is not None else exec_state["display_node"]
            exec_state["progress"] = {"value": val, "max": mx, "node": node_str}
            exec_state["updated_at"] = now
            now_mono = time.monotonic()
            if val < mx and val > 1 and (now_mono - self._last_progress_sent.get(user_id, 0.0) < PROGRESS_MIN_INTERVAL):
                return
            self._last_progress_sent[user_id] = now_mono
        elif event == "progress_state":
            nodes_map = data.get("nodes")
            if isinstance(nodes_map, dict):
                for nid, nstate in nodes_map.items():
                    if isinstance(nstate, dict) and nstate.get("state") == "running":
                        dnode = str(nstate.get("display_node_id") or nid)
                        exec_state["running"] = True
                        exec_state["executing_node"] = str(nid)
                        exec_state["display_node"] = dnode
                        exec_state["progress"] = {
                            "value": nstate.get("value", 0),
                            "max": nstate.get("max", 0),
                            "node": dnode,
                        }
                        exec_state["updated_at"] = now
                        break
        elif event == "executed":
            node = data.get("display_node") or data.get("node")
            media = _extract_output_media(data.get("output"))
            if node is not None and media:
                _set_bounded(exec_state["outputs"], str(node), media, MAX_OUTPUT_NODES_PER_USER)
            exec_state["updated_at"] = now
        elif event == "execution_error":
            exec_state["running"] = False
            exec_state["executing_node"] = None
            exec_state["display_node"] = None
            exec_state["progress"] = None
            exec_state["preview"] = None
            exec_state["error"] = {
                "node_id": str(data["node_id"]) if data.get("node_id") is not None else None,
                "node_type": str(data.get("node_type") or ""),
                "message": str(data.get("exception_message") or "Execution error")[:500],
            }
            exec_state["updated_at"] = now
            summary_changed = True
        elif event in ("execution_interrupted", "execution_success"):
            exec_state["running"] = False
            exec_state["executing_node"] = None
            exec_state["display_node"] = None
            exec_state["progress"] = None
            exec_state["preview"] = None
            exec_state["updated_at"] = now
            summary_changed = True

        if self.observers:
            await self._broadcast_observers(
                "execution_update",
                {"user_id": user_id, "execution": self._serialize_execution(user_id)},
                user_id=user_id,
            )
            if summary_changed:
                await self._broadcast_users_summary()

    def add_routes(self, app: web.Application) -> None:
        async def serve_index(request: web.Request) -> web.StreamResponse:
            response = web.FileResponse(os.path.join(ASSETS_DIR, "index.html"))
            response.headers["Cache-Control"] = "no-store, must-revalidate"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        async def serve_asset(request: web.Request) -> web.StreamResponse:
            filename = request.match_info.get("filename", "")
            if filename not in ("viewer.js", "viewer.css"):
                return web.Response(status=404)
            path = os.path.join(ASSETS_DIR, filename)
            content_type = "application/javascript; charset=utf-8" if filename.endswith(".js") else "text/css; charset=utf-8"
            response = web.FileResponse(path, headers={
                "Content-Type": content_type,
                "Cache-Control": "no-cache",
                "X-Content-Type-Options": "nosniff",
            })
            return response

        async def serve_reporter_extension(request: web.Request) -> web.StreamResponse:
            path = os.path.join(ASSETS_DIR, "reporter.js")
            return web.FileResponse(path, headers={
                "Content-Type": "application/javascript; charset=utf-8",
                "Cache-Control": "no-cache",
                "X-Content-Type-Options": "nosniff",
            })

        async def get_auth_status(request: web.Request) -> web.Response:
            return web.json_response({
                "requires_token": self.requires_token(),
                "authenticated": self.is_authorized(request),
                "multi_user": bool(args.multi_user),
            })

        async def get_users(request: web.Request) -> web.Response:
            if not self.is_authorized(request):
                return web.json_response({"error": "Unauthorized"}, status=401)
            return web.json_response({
                "multi_user": bool(args.multi_user),
                "users": self.get_users_summary(),
                "queue_remaining": self.prompt_server.prompt_queue.get_tasks_remaining(),
            })

        async def get_user_live_state(request: web.Request) -> web.Response:
            if not self.is_authorized(request):
                return web.json_response({"error": "Unauthorized"}, status=401)
            user_id = request.match_info.get("user_id", "")
            session_id = request.rel_url.query.get("session_id")
            snapshot = self.get_user_snapshot(user_id, session_id=session_id)
            if snapshot is None:
                return web.json_response({"error": "User not found"}, status=404)
            return web.json_response(snapshot)

        async def get_user_saved_workflows(request: web.Request) -> web.Response:
            if not self.is_authorized(request):
                return web.json_response({"error": "Unauthorized"}, status=401)
            user_id = request.match_info.get("user_id", "")
            if self._resolve_valid_user_id(user_id) is None:
                return web.json_response({"error": "User not found"}, status=404)
            return web.json_response({
                "user_id": user_id,
                "workflows": self._list_saved_workflows(user_id),
            })

        async def get_user_saved_workflow_file(request: web.Request) -> web.Response:
            if not self.is_authorized(request):
                return web.json_response({"error": "Unauthorized"}, status=401)
            user_id = request.match_info.get("user_id", "")
            rel_path = request.match_info.get("file", "")
            workflow = self._read_saved_workflow(user_id, rel_path)
            if workflow is None:
                return web.json_response({"error": "Workflow not found"}, status=404)
            return web.json_response({
                "user_id": user_id,
                "path": rel_path,
                "workflow": workflow,
            })

        async def observer_ws_handler(request: web.Request) -> web.StreamResponse:
            if not self.is_authorized(request):
                return web.Response(status=401, text="Unauthorized")

            ws = web.WebSocketResponse(heartbeat=30.0)
            await ws.prepare(request)
            sub: dict[str, Any] = {"mode": "focus", "user_id": None, "session_id": None}
            self.observers[ws] = sub

            try:
                await self._send_observer_json(ws, {
                    "type": "init",
                    "data": {
                        "multi_user": bool(args.multi_user),
                        "users": self.get_users_summary(),
                        "queue_remaining": self.prompt_server.prompt_queue.get_tasks_remaining(),
                    },
                })

                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.ERROR:
                        break
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    try:
                        payload = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(payload, dict):
                        continue

                    # Observers are strictly read-only: only view subscription changes are accepted.
                    if payload.get("type") == "subscribe":
                        mode = payload.get("mode", "focus")
                        if mode == "grid":
                            sub["mode"] = "grid"
                            sub["user_id"] = None
                            sub["session_id"] = None
                            snapshots = []
                            for user in self.get_users_summary():
                                if user["online"] or user["has_workflow"]:
                                    snap = self.get_user_snapshot(user["user_id"])
                                    if snap is not None:
                                        snapshots.append(snap)
                            await self._send_observer_json(ws, {
                                "type": "grid_snapshots",
                                "data": {"snapshots": snapshots},
                            })
                        else:
                            target_uid = self._resolve_valid_user_id(payload.get("user_id"))
                            target_sid = payload.get("session_id")
                            if not isinstance(target_sid, str):
                                target_sid = None
                            sub["mode"] = "focus"
                            sub["user_id"] = target_uid
                            sub["session_id"] = target_sid
                            if target_uid is not None:
                                snap = self.get_user_snapshot(target_uid, session_id=target_sid)
                                if snap is not None:
                                    await self._send_observer_json(ws, {
                                        "type": "workflow_snapshot",
                                        "data": snap,
                                    })
            finally:
                self.observers.pop(ws, None)

            return ws

        async def reporter_ws_handler(request: web.Request) -> web.StreamResponse:
            # Write-only reporting socket for regular ComfyUI tabs.
            # Never emits any other user's data back to the reporter.
            ws = web.WebSocketResponse(max_msg_size=MAX_REPORT_BYTES, heartbeat=30.0)
            await ws.prepare(request)

            session_id: Optional[str] = None
            user_id: Optional[str] = None

            try:
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.ERROR:
                        break
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    try:
                        payload = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(payload, dict):
                        continue

                    msg_type = payload.get("type")
                    if msg_type == "ping":
                        if session_id and session_id in self.sessions:
                            self.sessions[session_id]["last_seen"] = _now_ms()
                        continue

                    if msg_type == "viewport":
                        if session_id and session_id in self.sessions and user_id:
                            vp = _sanitize_viewport(payload.get("viewport"))
                            if vp is not None:
                                self.sessions[session_id]["viewport"] = vp
                                self.sessions[session_id]["last_seen"] = _now_ms()
                                cached = self.last_user_snapshots.get(user_id)
                                if cached is not None:
                                    cached["viewport"] = vp
                                if self.observers:
                                    await self._broadcast_observers(
                                        "viewport_update",
                                        {
                                            "user_id": user_id,
                                            "session_id": session_id,
                                            "viewport": vp,
                                        },
                                        user_id=user_id,
                                        session_id=session_id,
                                    )
                        continue

                    if msg_type != "state":
                        continue

                    raw_user = payload.get("user_id")
                    resolved_user = self._resolve_valid_user_id(raw_user)
                    if resolved_user is None:
                        continue

                    tab_id = payload.get("tab_id")
                    if not isinstance(tab_id, str) or not tab_id or len(tab_id) > 80:
                        continue

                    client_id = payload.get("client_id")
                    if not isinstance(client_id, str) or not client_id or len(client_id) > 128:
                        client_id = None

                    new_session_id = f"{resolved_user}:{tab_id}"
                    if session_id and session_id != new_session_id:
                        self.sessions.pop(session_id, None)

                    session_id = new_session_id
                    user_id = resolved_user
                    if client_id is not None:
                        _set_bounded(self.client_to_user, client_id, resolved_user, MAX_CLIENT_MAP)

                    now = _now_ms()
                    workflow = payload.get("workflow")
                    existing = self.sessions.get(session_id)
                    if not isinstance(workflow, dict):
                        workflow = existing["workflow"] if existing else None

                    workflow_name = payload.get("workflow_name")
                    if not isinstance(workflow_name, str) or not workflow_name.strip():
                        workflow_name = existing["workflow_name"] if existing else "Unsaved Workflow"
                    else:
                        workflow_name = workflow_name.strip()[:200]

                    node_meta = _sanitize_node_meta(payload.get("node_meta")) if "node_meta" in payload else (existing["node_meta"] if existing else {})
                    viewport = _sanitize_viewport(payload.get("viewport")) if "viewport" in payload else (existing["viewport"] if existing else None)
                    node_count, link_count = _workflow_counts(workflow)
                    is_new_session = existing is None
                    counts_or_name_changed = (
                        is_new_session
                        or existing["workflow_name"] != workflow_name
                        or existing["node_count"] != node_count
                        or existing["link_count"] != link_count
                    )

                    session_record = {
                        "session_id": session_id,
                        "user_id": resolved_user,
                        "username": self._get_username(resolved_user),
                        "client_id": client_id,
                        "tab_id": tab_id,
                        "workflow_name": workflow_name,
                        "workflow": workflow,
                        "node_meta": node_meta,
                        "viewport": viewport,
                        "node_count": node_count,
                        "link_count": link_count,
                        "connected_at": existing["connected_at"] if existing else now,
                        "updated_at": now,
                        "last_seen": now,
                        "online": True,
                    }
                    self.sessions[session_id] = session_record

                    if workflow is not None:
                        self._update_cached_snapshot(
                            user_id=resolved_user,
                            workflow_name=workflow_name,
                            workflow=workflow,
                            node_meta=node_meta,
                            viewport=viewport,
                            updated_at=now,
                        )

                    if self.observers:
                        await self._broadcast_observers(
                            "workflow_update",
                            {
                                "user_id": resolved_user,
                                "username": self._get_username(resolved_user),
                                "session_id": session_id,
                                "online": True,
                                "workflow_name": workflow_name,
                                "workflow": workflow,
                                "node_meta": node_meta,
                                "viewport": viewport,
                                "node_count": node_count,
                                "link_count": link_count,
                                "updated_at": now,
                            },
                            user_id=resolved_user,
                            session_id=session_id,
                        )
                        if counts_or_name_changed:
                            await self._broadcast_users_summary()
            finally:
                if session_id and session_id in self.sessions:
                    self.sessions.pop(session_id, None)
                    if self.observers:
                        await self._broadcast_users_summary()
                        if user_id:
                            snap = self.get_user_snapshot(user_id)
                            if snap is not None:
                                await self._broadcast_observers(
                                    "workflow_snapshot",
                                    snap,
                                    user_id=user_id,
                                )

            return ws

        app.router.add_get("/live-view", serve_index)
        app.router.add_get("/live-view/", serve_index)
        app.router.add_get("/live-view/assets/{filename}", serve_asset)
        app.router.add_get("/extensions/live_view/reporter.js", serve_reporter_extension)
        app.router.add_get("/live-view/api/auth-status", get_auth_status)
        app.router.add_get("/live-view/api/users", get_users)
        app.router.add_get("/live-view/api/users/{user_id}/state", get_user_live_state)
        app.router.add_get("/live-view/api/users/{user_id}/workflows", get_user_saved_workflows)
        app.router.add_get("/live-view/api/users/{user_id}/workflow/{file:.*}", get_user_saved_workflow_file)
        app.router.add_get("/live-view/ws", observer_ws_handler)
        app.router.add_get("/live-view/report", reporter_ws_handler)
