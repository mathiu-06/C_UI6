import asyncio
import ipaddress
import logging
import os
import socket
import time
import urllib.parse
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

import aiohttp
from aiohttp import web

import folder_paths
from comfy.cli_args import args

ASSETS_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "model_downloader_assets")

EXCLUDED_MODEL_FOLDERS = frozenset({"configs", "custom_nodes", "datasets"})
LEGACY_FOLDER_ALIASES = {
    "unet": "diffusion_models",
    "clip": "text_encoders",
    "t2i_adapter": "controlnet",
}
ALLOWED_MODEL_EXTENSIONS = frozenset(
    set(folder_paths.supported_pt_extensions)
    | {".gguf", ".onnx", ".json", ".model", ".txt", ".yaml"}
)

MAX_REDIRECTS = 10
MAX_CONCURRENT_DOWNLOADS = 2
CHUNK_SIZE = 1024 * 1024  # 1 MiB
PROGRESS_BROADCAST_INTERVAL = 0.25
MAX_TRACKED_TASKS = 50


def get_allowed_model_folders() -> list[str]:
    return sorted(
        folder
        for folder in folder_paths.folder_names_and_paths.keys()
        if folder not in EXCLUDED_MODEL_FOLDERS
    )


def resolve_target_path(directory: str, filename: str) -> tuple[str, str, str, str]:
    """Validate and resolve (directory, filename) inside ComfyUI's configured models dir.

    Returns (canonical_directory, rel_filename, base_dir, abs_target_path).
    Raises ValueError if the folder, filename, extension, or resolved path is invalid.
    """
    if not isinstance(directory, str) or not directory.strip():
        raise ValueError("Missing model directory.")
    if not isinstance(filename, str) or not filename.strip():
        raise ValueError("Missing model filename.")

    raw_dir = directory.strip().strip("/\\")
    if raw_dir.startswith("models/"):
        raw_dir = raw_dir[len("models/"):]
    canonical_dir = LEGACY_FOLDER_ALIASES.get(raw_dir, folder_paths.map_legacy(raw_dir))

    if canonical_dir in EXCLUDED_MODEL_FOLDERS or canonical_dir not in folder_paths.folder_names_and_paths:
        raise ValueError(f"Unsupported model directory: {directory!r}")

    folder_list = folder_paths.get_folder_paths(canonical_dir)
    if not folder_list:
        raise ValueError(f"No filesystem path configured for model directory: {canonical_dir!r}")

    # Prefer the path whose basename matches the requested folder name (e.g. models/diffusion_models
    # over models/unet when "diffusion_models" is requested), falling back to the primary path.
    base_dir = folder_list[0]
    for candidate in folder_list:
        if os.path.basename(os.path.normpath(candidate)) == canonical_dir:
            base_dir = candidate
            break
    base_dir = os.path.abspath(base_dir)

    raw_name = filename.strip().replace("\\", "/")
    if "\x00" in raw_name or raw_name.startswith("/") or ":" in raw_name:
        raise ValueError(f"Invalid model filename: {filename!r}")

    parts = [p for p in raw_name.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        raise ValueError(f"Invalid model filename: {filename!r}")

    rel_filename = os.path.join(*parts)
    ext = os.path.splitext(parts[-1])[1].lower()
    if ext not in ALLOWED_MODEL_EXTENSIONS:
        raise ValueError(f"Unsupported model file extension: {ext or '(none)'}")

    target_path = os.path.abspath(os.path.join(base_dir, rel_filename))
    if not folder_paths.is_within_directory(base_dir, target_path):
        raise ValueError(f"Target path escapes model directory: {filename!r}")
    if os.path.realpath(target_path) == os.path.realpath(base_dir):
        raise ValueError(f"Invalid model filename: {filename!r}")

    return canonical_dir, rel_filename.replace("\\", "/"), base_dir, target_path


def _is_public_ip(ip_str: str) -> bool:
    ip = ipaddress.ip_address(ip_str)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_url_syntax(url: str) -> urllib.parse.SplitResult:
    if not isinstance(url, str):
        raise ValueError("Missing download URL.")
    cleaned = url.strip()
    if not cleaned or len(cleaned) > 4096 or any(ch.isspace() or ord(ch) < 32 for ch in cleaned):
        raise ValueError("Invalid download URL.")

    parsed = urllib.parse.urlsplit(cleaned)
    if parsed.scheme not in ("https", "http"):
        raise ValueError("Only http and https download URLs are supported.")
    if not parsed.hostname:
        raise ValueError("Download URL must include a hostname.")
    if parsed.username or parsed.password:
        raise ValueError("Download URL must not embed credentials.")
    return parsed


def validate_url_host_sync(url: str) -> urllib.parse.SplitResult:
    parsed = validate_url_syntax(url)
    host = parsed.hostname
    assert host is not None
    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None

    if ip is not None:
        if not _is_public_ip(str(ip)):
            raise ValueError(f"Refusing download from non-public address: {host}")
        return parsed

    try:
        addrinfos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve host {host!r}: {exc}") from exc

    if not addrinfos:
        raise ValueError(f"Host {host!r} resolved to no addresses.")

    for _, _, _, _, sockaddr in addrinfos:
        if not _is_public_ip(sockaddr[0]):
            raise ValueError(f"Refusing download from non-public host: {host}")

    return parsed


def _is_huggingface_host(hostname: Optional[str]) -> bool:
    if not hostname:
        return False
    lowered = hostname.lower()
    return lowered == "huggingface.co" or lowered.endswith(".huggingface.co")


def _extract_filename_from_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    basename = os.path.basename(urllib.parse.unquote(parsed.path or ""))
    return basename.strip()


@dataclass
class DownloadTaskState:
    id: str
    url: str
    directory: str
    filename: str
    target_path: str
    saved_path: str
    status: str = "queued"  # queued | downloading | completed | error | cancelled
    downloaded_bytes: int = 0
    total_bytes: int = 0
    speed_bps: float = 0.0
    error: Optional[str] = None
    already_exists: bool = False
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    async_task: Optional[asyncio.Task] = field(default=None, repr=False)

    def to_dict(self) -> dict[str, Any]:
        percent = (
            round((self.downloaded_bytes / self.total_bytes) * 100.0, 1)
            if self.total_bytes > 0
            else (100.0 if self.status == "completed" else 0.0)
        )
        return {
            "id": self.id,
            "url": self.url,
            "directory": self.directory,
            "filename": self.filename,
            "saved_path": self.saved_path,
            "status": self.status,
            "downloaded_bytes": self.downloaded_bytes,
            "total_bytes": self.total_bytes,
            "percent": min(100.0, percent),
            "speed_bps": round(self.speed_bps, 1),
            "error": self.error,
            "already_exists": self.already_exists,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class ModelDownloadManager:
    """Downloads missing workflow models directly onto the ComfyUI server filesystem."""

    def __init__(self, prompt_server):
        self.server = prompt_server
        self._tasks: dict[str, DownloadTaskState] = {}
        self._active_by_key: dict[tuple[str, str], str] = {}
        self._semaphore = asyncio.Semaphore(MAX_CONCURRENT_DOWNLOADS)

    def get_extension_urls(self) -> list[str]:
        return ["/extensions/model_downloader/downloader.js"]

    def _emit_progress(self, task: DownloadTaskState) -> None:
        task.updated_at = time.time()
        try:
            self.server.send_sync("model_download_progress", task.to_dict())
        except Exception as exc:
            logging.debug("[ModelDownloader] Failed to broadcast progress: %s", exc)

    def _prune_old_tasks(self) -> None:
        if len(self._tasks) <= MAX_TRACKED_TASKS:
            return
        finished = sorted(
            (t for t in self._tasks.values() if t.status in ("completed", "error", "cancelled")),
            key=lambda t: t.updated_at,
        )
        while len(self._tasks) > MAX_TRACKED_TASKS and finished:
            old = finished.pop(0)
            self._tasks.pop(old.id, None)

    def _refresh_model_caches(self, directory: str, raw_directory: Optional[str] = None) -> None:
        folder_paths.filename_list_cache.pop(directory, None)
        if raw_directory and raw_directory != directory:
            folder_paths.filename_list_cache.pop(raw_directory, None)
        for alias, target in LEGACY_FOLDER_ALIASES.items():
            if target == directory:
                folder_paths.filename_list_cache.pop(alias, None)

        model_file_manager = getattr(self.server, "model_file_manager", None)
        if model_file_manager is not None:
            model_file_manager.clear_cache()

        asset_manager = getattr(self.server, "asset_manager", None)
        if asset_manager is not None and getattr(asset_manager, "enabled", False):
            try:
                from app.assets.seeder import ScanPhase, asset_seeder

                if not asset_seeder.is_disabled():
                    asset_seeder.enqueue_scan(
                        roots=("models",),
                        phase=ScanPhase.FULL,
                        compute_hashes=args.enable_asset_hashing,
                    )
            except Exception as exc:
                logging.debug("[ModelDownloader] Asset rescan skipped: %s", exc)

    async def start_download(
        self,
        url: str,
        directory: str,
        filename: Optional[str] = None,
    ) -> DownloadTaskState:
        if args.offline:
            raise PermissionError("Model downloads are disabled in --offline mode.")

        validate_url_syntax(url)
        effective_filename = (filename or "").strip() or _extract_filename_from_url(url)
        canonical_dir, rel_filename, base_dir, target_path = resolve_target_path(
            directory, effective_filename
        )
        saved_path = f"models/{canonical_dir}/{rel_filename}"
        key = (canonical_dir, rel_filename)

        existing_id = self._active_by_key.get(key)
        if existing_id and existing_id in self._tasks:
            existing = self._tasks[existing_id]
            if existing.status in ("queued", "downloading"):
                return existing

        existing_full = folder_paths.get_full_path(canonical_dir, rel_filename)
        existing_file = target_path if (os.path.isfile(target_path) and os.path.getsize(target_path) > 0) else (
            existing_full if (existing_full and os.path.isfile(existing_full) and os.path.getsize(existing_full) > 0) else None
        )
        if existing_file is not None:
            size = os.path.getsize(existing_file)
            task = DownloadTaskState(
                id=uuid.uuid4().hex[:12],
                url=url.strip(),
                directory=canonical_dir,
                filename=rel_filename,
                target_path=existing_file,
                saved_path=saved_path,
                status="completed",
                downloaded_bytes=size,
                total_bytes=size,
                already_exists=True,
            )
            self._tasks[task.id] = task
            self._prune_old_tasks()
            self._refresh_model_caches(canonical_dir, directory.strip())
            self._emit_progress(task)
            return task

        task = DownloadTaskState(
            id=uuid.uuid4().hex[:12],
            url=url.strip(),
            directory=canonical_dir,
            filename=rel_filename,
            target_path=target_path,
            saved_path=saved_path,
            status="queued",
        )
        self._tasks[task.id] = task
        self._active_by_key[key] = task.id
        self._prune_old_tasks()
        self._emit_progress(task)

        task.async_task = asyncio.create_task(
            self._run_download(task, base_dir, directory.strip(), key)
        )
        return task

    async def _run_download(
        self,
        task: DownloadTaskState,
        base_dir: str,
        raw_directory: str,
        key: tuple[str, str],
    ) -> None:
        part_path = f"{task.target_path}.{task.id}.part"
        try:
            async with self._semaphore:
                if task.status == "cancelled":
                    return

                task.status = "downloading"
                self._emit_progress(task)

                target_parent = os.path.dirname(task.target_path)
                os.makedirs(target_parent, exist_ok=True)
                if not folder_paths.is_within_directory(base_dir, target_parent):
                    raise ValueError("Target parent escapes model directory.")

                logging.info(
                    "[ModelDownloader] Starting download: %s -> %s",
                    task.url,
                    task.target_path,
                )

                await self._stream_to_file(task, part_path)

                os.replace(part_path, task.target_path)
                final_size = os.path.getsize(task.target_path)
                task.downloaded_bytes = final_size
                if task.total_bytes <= 0:
                    task.total_bytes = final_size
                task.speed_bps = 0.0
                task.status = "completed"
                self._refresh_model_caches(task.directory, raw_directory)
                self._emit_progress(task)
                logging.info(
                    "[ModelDownloader] Completed download (%d bytes): %s",
                    final_size,
                    task.target_path,
                )
        except asyncio.CancelledError:
            task.status = "cancelled"
            task.speed_bps = 0.0
            self._cleanup_part(part_path)
            self._emit_progress(task)
            logging.info("[ModelDownloader] Cancelled download: %s", task.saved_path)
        except Exception as exc:
            task.status = "error"
            task.speed_bps = 0.0
            task.error = str(exc) or exc.__class__.__name__
            self._cleanup_part(part_path)
            self._emit_progress(task)
            logging.warning("[ModelDownloader] Failed %s: %s", task.saved_path, task.error)
        finally:
            if self._active_by_key.get(key) == task.id:
                self._active_by_key.pop(key, None)

    async def _stream_to_file(self, task: DownloadTaskState, part_path: str) -> None:
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=120)
        hf_token = (
            os.environ.get("HF_TOKEN")
            or os.environ.get("HUGGING_FACE_HUB_TOKEN")
            or ""
        ).strip()

        current_url = task.url
        async with aiohttp.ClientSession(timeout=timeout) as session:
            response: Optional[aiohttp.ClientResponse] = None
            try:
                for _ in range(MAX_REDIRECTS + 1):
                    parsed = await asyncio.to_thread(validate_url_host_sync, current_url)
                    headers = {"User-Agent": "ComfyUI-ModelDownloader/1.0"}
                    if hf_token and _is_huggingface_host(parsed.hostname):
                        headers["Authorization"] = f"Bearer {hf_token}"

                    resp = await session.get(
                        current_url,
                        headers=headers,
                        allow_redirects=False,
                    )
                    if resp.status in (301, 302, 303, 307, 308):
                        location = resp.headers.get("Location")
                        await resp.release()
                        if not location:
                            raise RuntimeError(f"Redirect response ({resp.status}) missing Location header.")
                        current_url = urllib.parse.urljoin(current_url, location)
                        continue

                    response = resp
                    break

                if response is None:
                    raise RuntimeError("Too many redirects while downloading model.")

                if response.status in (401, 403):
                    host = urllib.parse.urlsplit(current_url).hostname or ""
                    if _is_huggingface_host(host):
                        raise RuntimeError(
                            f"HTTP {response.status}: Gated Hugging Face model — accept the model license and set HF_TOKEN in Colab."
                        )
                    raise RuntimeError(f"HTTP {response.status}: Access denied by remote server.")
                if response.status >= 400:
                    raise RuntimeError(f"HTTP {response.status}: {response.reason or 'Download failed'}")

                content_length = response.headers.get("Content-Length")
                if content_length and content_length.isdigit():
                    task.total_bytes = int(content_length)

                started_at = time.monotonic()
                last_emit = started_at
                downloaded = 0

                with open(part_path, "wb") as fp:
                    async for chunk in response.content.iter_chunked(CHUNK_SIZE):
                        if not chunk:
                            continue
                        await asyncio.to_thread(fp.write, chunk)
                        downloaded += len(chunk)
                        now = time.monotonic()
                        if now - last_emit >= PROGRESS_BROADCAST_INTERVAL:
                            elapsed = max(now - started_at, 0.001)
                            task.downloaded_bytes = downloaded
                            task.speed_bps = downloaded / elapsed
                            self._emit_progress(task)
                            last_emit = now

                task.downloaded_bytes = downloaded
            finally:
                if response is not None:
                    await response.release()

    @staticmethod
    def _cleanup_part(part_path: str) -> None:
        try:
            if os.path.exists(part_path):
                os.remove(part_path)
        except OSError:
            pass

    def cancel_download(self, task_id: str) -> Optional[DownloadTaskState]:
        task = self._tasks.get(task_id)
        if task is None:
            return None
        if task.status in ("queued", "downloading"):
            task.status = "cancelled"
            if task.async_task is not None and not task.async_task.done():
                task.async_task.cancel()
            else:
                self._emit_progress(task)
        return task

    def clear_finished(self) -> int:
        to_remove = [
            tid
            for tid, task in self._tasks.items()
            if task.status in ("completed", "error", "cancelled")
        ]
        for tid in to_remove:
            self._tasks.pop(tid, None)
        return len(to_remove)

    def list_downloads(self) -> list[dict[str, Any]]:
        return [
            t.to_dict()
            for t in sorted(self._tasks.values(), key=lambda t: t.created_at, reverse=True)
        ]

    async def handle_download_request(self, request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body."}, status=400)

        if not isinstance(payload, dict):
            return web.json_response({"error": "Request body must be a JSON object."}, status=400)

        url = payload.get("url")
        directory = (
            payload.get("directory")
            or payload.get("folder")
            or payload.get("model_type")
            or payload.get("save_path")
            or ""
        )
        filename = payload.get("filename") or payload.get("name") or ""

        try:
            task = await self.start_download(url=url, directory=directory, filename=filename)
        except PermissionError as exc:
            return web.json_response({"error": str(exc)}, status=403)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        status_code = 200 if task.already_exists else 202
        return web.json_response(task.to_dict(), status=status_code)

    def add_routes(self, app: web.Application) -> None:
        async def get_folders(request: web.Request) -> web.Response:
            return web.json_response(
                {
                    "folders": get_allowed_model_folders(),
                    "aliases": LEGACY_FOLDER_ALIASES,
                    "offline": bool(args.offline),
                }
            )

        async def get_status(request: web.Request) -> web.Response:
            return web.json_response(
                {
                    "downloads": self.list_downloads(),
                    "offline": bool(args.offline),
                }
            )

        async def post_cancel(request: web.Request) -> web.Response:
            try:
                payload = await request.json()
            except Exception:
                return web.json_response({"error": "Invalid JSON body."}, status=400)
            task_id = payload.get("id") if isinstance(payload, dict) else None
            if not isinstance(task_id, str) or not task_id:
                return web.json_response({"error": "Missing download id."}, status=400)
            task = self.cancel_download(task_id)
            if task is None:
                return web.json_response({"error": "Download not found."}, status=404)
            return web.json_response(task.to_dict())

        async def post_clear(request: web.Request) -> web.Response:
            removed = self.clear_finished()
            return web.json_response({"removed": removed, "downloads": self.list_downloads()})

        async def serve_extension(request: web.Request) -> web.StreamResponse:
            ext_path = os.path.join(ASSETS_DIR, "downloader.js")
            return web.FileResponse(
                ext_path,
                headers={"Cache-Control": "no-store"},
            )

        app.router.add_get("/api/model-downloader/folders", get_folders)
        app.router.add_get("/api/model-downloader/status", get_status)
        app.router.add_post("/api/model-downloader/download", self.handle_download_request)
        app.router.add_post("/api/model-downloader/cancel", post_cancel)
        app.router.add_post("/api/model-downloader/clear", post_clear)
        app.router.add_get("/extensions/model_downloader/downloader.js", serve_extension)
