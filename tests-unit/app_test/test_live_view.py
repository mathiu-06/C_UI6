"""Tests for real-time read-only Live View workflow monitor (app/live_view.py)."""

import asyncio
import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest

import folder_paths
from app.live_view import LiveViewManager, redact_cli_argv


class FakePromptQueue:
    def __init__(self, remaining=0):
        self._remaining = remaining

    def get_tasks_remaining(self):
        return self._remaining


class FakeUserManager:
    def __init__(self, users=None):
        self.users = dict(users or {})


class FakePromptServer:
    def __init__(self, users=None):
        self.user_manager = FakeUserManager(users)
        self.prompt_queue = FakePromptQueue()
        self.last_prompt_id = None


class FakeWebSocket:
    def __init__(self):
        self.closed = False
        self.sent = []

    async def send_json(self, payload):
        self.sent.append(payload)


def make_request(headers=None, query=None):
    req = MagicMock()
    req.headers = headers or {}
    req.rel_url = MagicMock()
    req.rel_url.query = query or {}
    return req


@pytest.fixture
def temp_user_dir():
    with tempfile.TemporaryDirectory() as tmp:
        orig = folder_paths.get_user_directory()
        folder_paths.set_user_directory(tmp)
        yield tmp
        folder_paths.set_user_directory(orig)


class TestRedactCliArgv:
    def test_redacts_separate_token_arg(self):
        argv = ["main.py", "--multi-user", "--live-view-token", "s3cr3t", "--port", "8188"]
        assert redact_cli_argv(argv) == [
            "main.py",
            "--multi-user",
            "--live-view-token",
            "[REDACTED]",
            "--port",
            "8188",
        ]

    def test_redacts_equals_token_arg(self):
        argv = ["main.py", "--live-view-token=my-pass", "--listen", "0.0.0.0"]
        assert redact_cli_argv(argv) == [
            "main.py",
            "--live-view-token=[REDACTED]",
            "--listen",
            "0.0.0.0",
        ]

    def test_leaves_unrelated_args_unchanged(self):
        argv = ["main.py", "--multi-user", "--port", "8188"]
        assert redact_cli_argv(argv) == argv


class TestTokenAuthorization:
    def test_open_when_no_token_configured(self, monkeypatch):
        monkeypatch.delenv("COMFYUI_LIVE_VIEW_TOKEN", raising=False)
        server = FakePromptServer({"alice_1": "Alice"})
        with patch("app.live_view.args") as mock_args:
            mock_args.live_view_token = None
            mock_args.multi_user = True
            mgr = LiveViewManager(server)
            assert mgr.requires_token() is False
            assert mgr.is_authorized(make_request()) is True

    def test_cli_token_enforced_across_header_bearer_and_query(self, monkeypatch):
        monkeypatch.delenv("COMFYUI_LIVE_VIEW_TOKEN", raising=False)
        server = FakePromptServer({"alice_1": "Alice"})
        with patch("app.live_view.args") as mock_args:
            mock_args.live_view_token = "top-secret"
            mock_args.multi_user = True
            mgr = LiveViewManager(server)

            assert mgr.requires_token() is True
            assert mgr.is_authorized(make_request()) is False
            assert mgr.is_authorized(make_request(headers={"Authorization": "Bearer wrong"})) is False
            assert mgr.is_authorized(make_request(headers={"Authorization": "Bearer top-secret"})) is True
            assert mgr.is_authorized(make_request(headers={"X-Live-View-Token": "top-secret"})) is True
            assert mgr.is_authorized(make_request(query={"token": "top-secret"})) is True

    def test_env_token_supported(self, monkeypatch):
        monkeypatch.setenv("COMFYUI_LIVE_VIEW_TOKEN", "colab-secret")
        server = FakePromptServer({"alice_1": "Alice"})
        with patch("app.live_view.args") as mock_args:
            mock_args.live_view_token = None
            mock_args.multi_user = True
            mgr = LiveViewManager(server)

            assert mgr.requires_token() is True
            assert mgr.is_authorized(make_request(query={"token": "colab-secret"})) is True
            assert mgr.is_authorized(make_request(query={"token": "other"})) is False


class TestUserAndSavedWorkflowSafety:
    def test_blocks_system_users_and_path_traversal(self, temp_user_dir):
        alice_wf_dir = os.path.join(temp_user_dir, "alice_1", "workflows")
        os.makedirs(alice_wf_dir, exist_ok=True)
        with open(os.path.join(alice_wf_dir, "demo.json"), "w", encoding="utf-8") as f:
            json.dump({"nodes": [{"id": 1, "type": "KSampler"}], "links": []}, f)
        with open(os.path.join(temp_user_dir, "alice_1", "comfy.settings.json"), "w", encoding="utf-8") as f:
            json.dump({"secret": True}, f)

        server = FakePromptServer({"alice_1": "Alice", "__system": "System"})
        with patch("app.live_view.args") as mock_args:
            mock_args.live_view_token = None
            mock_args.multi_user = True
            mgr = LiveViewManager(server)

            summary = mgr.get_users_summary()
            assert [u["user_id"] for u in summary] == ["alice_1"]

            saved = mgr._list_saved_workflows("alice_1")
            assert len(saved) == 1
            assert saved[0]["path"] == "demo.json"

            # Valid workflow file loads read-only
            wf = mgr._read_saved_workflow("alice_1", "demo.json")
            assert wf is not None
            assert wf["nodes"][0]["type"] == "KSampler"

            # Path traversal and non-workflow files are blocked
            assert mgr._read_saved_workflow("alice_1", "../comfy.settings.json") is None
            assert mgr._read_saved_workflow("alice_1", "..%2Fcomfy.settings.json") is None
            assert mgr._read_saved_workflow("__system", "demo.json") is None
            assert mgr._read_saved_workflow("unknown_user", "demo.json") is None


class TestRealTimeExecutionTracking:
    def test_prompt_and_execution_events_stream_to_subscribed_observer(self):
        server = FakePromptServer({"alice_1": "Alice", "bob_2": "Bob"})
        with patch("app.live_view.args") as mock_args:
            mock_args.live_view_token = None
            mock_args.multi_user = True
            mgr = LiveViewManager(server)

            ws_alice = FakeWebSocket()
            ws_bob = FakeWebSocket()
            mgr.observers[ws_alice] = {"mode": "focus", "user_id": "alice_1", "session_id": None}
            mgr.observers[ws_bob] = {"mode": "focus", "user_id": "bob_2", "session_id": None}

            req = make_request(headers={"comfy-user": "alice_1"})
            workflow = {"nodes": [{"id": 3, "type": "KSampler"}], "links": []}
            mgr.on_prompt_queued(
                req,
                prompt_id="prompt-1",
                prompt={},
                extra_data={"client_id": "cid-alice", "extra_pnginfo": {"workflow": workflow}},
            )

            snap = mgr.get_user_snapshot("alice_1")
            assert snap is not None
            assert snap["workflow"]["nodes"][0]["id"] == 3

            async def run_events():
                await mgr.on_server_event("execution_start", {"prompt_id": "prompt-1"}, "cid-alice")
                await mgr.on_server_event("executing", {"node": "3", "display_node": "3", "prompt_id": "prompt-1"}, "cid-alice")
                await mgr.on_server_event("progress", {"value": 5, "max": 20, "node": "3", "prompt_id": "prompt-1"}, "cid-alice")
                await mgr.on_server_event(
                    "executed",
                    {
                        "node": "9",
                        "display_node": "9",
                        "prompt_id": "prompt-1",
                        "output": {"images": [{"filename": "out.png", "subfolder": "", "type": "output"}]},
                    },
                    "cid-alice",
                )
                await mgr.on_server_event("execution_success", {"prompt_id": "prompt-1"}, "cid-alice")

            asyncio.run(run_events())

            alice_exec_msgs = [m for m in ws_alice.sent if m["type"] == "execution_update"]
            bob_exec_msgs = [m for m in ws_bob.sent if m["type"] == "execution_update"]
            assert len(alice_exec_msgs) >= 4
            assert len(bob_exec_msgs) == 0

            final_snap = mgr.get_user_snapshot("alice_1")
            assert final_snap["execution"]["running"] is False
            assert final_snap["execution"]["outputs"]["9"][0]["filename"] == "out.png"
