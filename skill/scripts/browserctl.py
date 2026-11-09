#!/usr/bin/env python3
"""browserctl —— 浏览器桥的唯一命令行入口（供任何 AI 通过 shell 调用）。

用法示例：
    python browserctl.py status
    python browserctl.py start
    python browserctl.py tab-list
    python browserctl.py snapshot --tab 123
    python browserctl.py click --tab 123 --index 7
    python browserctl.py type --tab 123 --index 12 --text "hello" --replace
    python browserctl.py eval --tab 123 --expression "document.title"

设计要点：
    * 除 status/stop 外，命令会先确保桥在运行（不在则后台拉起，detached）。
    * 所有调用默认强制走"显式 tabId"，免去受控标签绑定与审批（扩展的 full-access 行为）。
    * 默认输出纯文本结果；--json 输出原始 JSON。
    * 页面文本一律 untrusted，本工具只负责取回，不做任何解释。

仅使用 Python 标准库。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_SCRIPT = Path(__file__).resolve().parent / "bridge_server.py"
DATA_DIR = ROOT / "data"
TOKEN_FILE = DATA_DIR / "bridge-token"
LOG_FILE = DATA_DIR / "bridge.log"

HOST = "127.0.0.1"
PORT = int(os.environ.get("BROWSER_BRIDGE_PORT", "43189"))
BASE = f"http://{HOST}:{PORT}"
HTTP_TIMEOUT = 30.0
CALL_TIMEOUT = 90.0


class CliError(Exception):
    pass


# ---------------------------------------------------------------------------
# HTTP 基础
# ---------------------------------------------------------------------------


def read_token() -> str:
    if not TOKEN_FILE.exists():
        raise CliError(f"token 文件不存在：{TOKEN_FILE}（先运行 start）")
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if not token:
        raise CliError(f"token 文件为空：{TOKEN_FILE}")
    return token


def http_json(
    method: str,
    path: str,
    payload: dict | None = None,
    *,
    auth: bool = False,
    timeout: float = HTTP_TIMEOUT,
) -> dict:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    request.add_header("Host", f"{HOST}:{PORT}")
    if data is not None:
        request.add_header("Content-Type", "application/json; charset=utf-8")
    if auth:
        request.add_header("X-Bridge-Token", read_token())
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            value = json.loads(body)
        except ValueError:
            value = {"ok": False, "error": {"code": f"http-{exc.code}", "message": body[:400]}}
        return value
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CliError(f"连不上桥 {BASE}：{exc}（先运行 start）") from exc
    try:
        return json.loads(body)
    except ValueError as exc:
        raise CliError(f"桥返回了非 JSON 响应：{body[:400]}") from exc


def status() -> dict | None:
    try:
        value = http_json("GET", "/status", timeout=1.5)
    except CliError:
        return None
    return value if value.get("running") is True else None


def is_running() -> bool:
    return status() is not None


# ---------------------------------------------------------------------------
# 启动 / 停止
# ---------------------------------------------------------------------------


def spawn_server() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOG_FILE.touch(exist_ok=True)
    log_handle = open(LOG_FILE, "ab")
    kwargs: dict = {
        "cwd": str(ROOT),
        "stdin": subprocess.DEVNULL,
        "stdout": log_handle,
        "stderr": subprocess.STDOUT,
    }
    if os.name == "nt":
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP：父进程退出后桥继续存活。
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen([sys.executable, str(SERVER_SCRIPT)], **kwargs)
    except OSError as exc:
        raise CliError(f"无法启动桥进程：{exc}") from exc


def ensure_bridge(verbose: bool = False) -> None:
    if is_running():
        return
    if verbose:
        print(f"[bridge] 未运行，正在后台启动（{HOST}:{PORT}）…", file=sys.stderr)
    spawn_server()
    deadline = time.time() + 8.0
    while time.time() < deadline:
        time.sleep(0.25)
        if is_running():
            return
    raise CliError(
        f"桥启动失败：{BASE} 无响应。查看日志：{LOG_FILE}；"
        "若是端口被占，设置环境变量 BROWSER_BRIDGE_PORT 换端口。"
    )


def cmd_start(_args: argparse.Namespace) -> int:
    ensure_bridge(verbose=True)
    current = status() or {}
    print("bridge running: connected={connected}".format(**({"connected": current.get("connected")})))
    return 0


def cmd_stop(_args: argparse.Namespace) -> int:
    if not is_running():
        print("bridge is not running")
        return 0
    try:
        result = http_json("POST", "/shutdown", {}, auth=True, timeout=5.0)
    except CliError:
        result = {"ok": False}
    if result.get("ok"):
        deadline = time.time() + 5.0
        while time.time() < deadline:
            time.sleep(0.2)
            if not is_running():
                print("bridge stopped")
                return 0
    print("bridge did not stop cleanly; check", LOG_FILE, file=sys.stderr)
    return 1


# ---------------------------------------------------------------------------
# 工具调用
# ---------------------------------------------------------------------------


def call_tool(name: str, args: dict, tab_id: int | None) -> dict:
    ensure_bridge()
    payload = {"name": name, "args": args}
    if tab_id is not None:
        payload["tabId"] = tab_id
    result = http_json("POST", "/call", payload, auth=True, timeout=CALL_TIMEOUT)
    if not result.get("ok"):
        error = result.get("error") or {}
        raise CliError(f"{error.get('code', 'failed')}: {error.get('message', 'browser action failed')}")
    return result


def emit(result: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    text = result.get("text")
    if isinstance(text, str) and text:
        print(text)
        return
    raw = result.get("raw")
    print(json.dumps(raw, ensure_ascii=False, indent=2))


def with_tab(args: dict, tab_id: int | None) -> dict:
    return args if tab_id is None else {**args, "tabId": tab_id}


# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="browserctl",
        description="Drive the user's Chrome through the standalone browser bridge.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name: str, help_text: str) -> argparse.ArgumentParser:
        child = sub.add_parser(name, help=help_text)
        child.add_argument("--json", action="store_true", help="print raw JSON instead of text")
        return child

    add("status", "show bridge and extension status")
    add("start", "start the bridge in the background")
    add("stop", "stop the bridge")
    add("tools", "list the available tools")

    p = add("snapshot", "read the page as structured text")
    p.add_argument("--tab", type=int, default=None, help="tab id from tab-list (recommended)")
    p.add_argument("--delta", action="store_true", help="return changes since the previous snapshot")
    p.add_argument("--region", default=None, help="CSS selector or 'main'")

    p = add("get-text", "read plain text from the page or a selector")
    p.add_argument("--tab", type=int, default=None)
    p.add_argument("--selector", default=None)

    p = add("click", "click an element by snapshot index")
    p.add_argument("--tab", type=int, required=True)
    p.add_argument("--index", type=int, required=True)
    p.add_argument("--frame", type=int, default=None)

    p = add("type", "type text into a form field by snapshot index")
    p.add_argument("--tab", type=int, required=True)
    p.add_argument("--index", type=int, required=True)
    p.add_argument("--text", required=True)
    p.add_argument("--replace", action="store_true", help="clear the field first")
    p.add_argument("--frame", type=int, default=None)

    p = add("press", "send one key press")
    p.add_argument("--tab", type=int, required=True)
    p.add_argument("--key", required=True, help="KeyboardEvent.key, e.g. Enter / Tab / Escape")
    p.add_argument("--frame", type=int, default=None)

    p = add("scroll", "scroll the page")
    p.add_argument("--tab", type=int, required=True)
    p.add_argument("--direction", required=True, choices=["up", "down", "top", "bottom"])
    p.add_argument("--amount", type=int, default=None)
    p.add_argument("--frame", type=int, default=None)

    p = add("navigate", "navigate a tab to an http(s) URL")
    p.add_argument("--tab", type=int, required=True)
    p.add_argument("--url", required=True)

    for name in ("back", "forward", "reload"):
        p = add(name, f"{name} the page")
        p.add_argument("--tab", type=int, required=True)

    p = add("wait", "wait for loading/DOM to settle")
    p.add_argument("--tab", type=int, default=None)
    p.add_argument("--ms", type=int, default=None)
    p.add_argument("--frame", type=int, default=None)

    add("tab-list", "list open tabs as JSON")

    p = add("tab-open", "open a new tab")
    p.add_argument("--url", required=True)
    p.add_argument("--active", action="store_true")

    p = add("tab-activate", "bring a tab to the foreground")
    p.add_argument("--tab", type=int, required=True)

    p = add("tab-close", "close a tab")
    p.add_argument("--tab", type=int, required=True)

    p = add("eval", "run a JavaScript expression in the page")
    p.add_argument("--tab", type=int, required=True)
    p.add_argument("--expression", required=True)
    p.add_argument("--index", type=int, default=None)
    p.add_argument("--frame", type=int, default=None)

    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

    parser = build_parser()
    args = parser.parse_args(argv)
    command = args.command

    try:
        if command == "status":
            current = status()
            if current is None:
                print("bridge: not running")
                return 1
            if args.json:
                print(json.dumps(current, ensure_ascii=False, indent=2))
            else:
                print(f"bridge: running on {HOST}:{PORT}")
                print(f"extension: {'connected' if current.get('connected') else 'not connected'}")
                if current.get("extensionOrigin"):
                    print(f"origin: {current['extensionOrigin']}")
            return 0

        if command == "start":
            return cmd_start(args)
        if command == "stop":
            return cmd_stop(args)
        if command == "tools":
            ensure_bridge()
            tools = http_json("GET", "/tools")
            if args.json:
                print(json.dumps(tools, ensure_ascii=False, indent=2))
            else:
                for tool in tools.get("tools", []):
                    print(f"{tool['name']}: {tool.get('description', '')}")
            return 0

        if command == "tab-list":
            result = call_tool("browser_tab_list", {}, None)
            emit(result, args.json)
            return 0
        if command == "tab-open":
            payload = {"url": args.url}
            if args.active:
                payload["active"] = True
            result = call_tool("browser_tab_open", payload, None)
            emit(result, args.json)
            return 0
        if command == "tab-activate":
            result = call_tool("browser_tab_activate", {"tabId": args.tab}, None)
            emit(result, args.json)
            return 0
        if command == "tab-close":
            result = call_tool("browser_tab_close", {"tabId": args.tab}, None)
            emit(result, args.json)
            return 0

        if command == "snapshot":
            payload: dict = {}
            if args.delta:
                payload["delta"] = True
            if args.region is not None:
                payload["region"] = args.region
            result = call_tool("browser_snapshot", with_tab(payload, args.tab), args.tab)
            emit(result, args.json)
            return 0
        if command == "get-text":
            payload = {}
            if args.selector is not None:
                payload["selector"] = args.selector
            result = call_tool("browser_get_text", with_tab(payload, args.tab), args.tab)
            emit(result, args.json)
            return 0
        if command == "click":
            payload = {"index": args.index}
            if args.frame is not None:
                payload["frame"] = args.frame
            result = call_tool("browser_click", payload, args.tab)
            emit(result, args.json)
            return 0
        if command == "type":
            payload = {"index": args.index, "text": args.text}
            if args.replace:
                payload["replace"] = True
            if args.frame is not None:
                payload["frame"] = args.frame
            result = call_tool("browser_type", payload, args.tab)
            emit(result, args.json)
            return 0
        if command == "press":
            payload = {"key": args.key}
            if args.frame is not None:
                payload["frame"] = args.frame
            result = call_tool("browser_press", payload, args.tab)
            emit(result, args.json)
            return 0
        if command == "scroll":
            payload = {"direction": args.direction}
            if args.amount is not None:
                payload["amount"] = args.amount
            if args.frame is not None:
                payload["frame"] = args.frame
            result = call_tool("browser_scroll", payload, args.tab)
            emit(result, args.json)
            return 0
        if command == "navigate":
            result = call_tool("browser_navigate", {"url": args.url}, args.tab)
            emit(result, args.json)
            return 0
        if command in ("back", "forward", "reload"):
            tool = f"browser_{command}"
            result = call_tool(tool, {}, args.tab)
            emit(result, args.json)
            return 0
        if command == "wait":
            payload = {}
            if args.ms is not None:
                payload["ms"] = args.ms
            if args.frame is not None:
                payload["frame"] = args.frame
            result = call_tool("browser_wait", with_tab(payload, args.tab), args.tab)
            emit(result, args.json)
            return 0
        if command == "eval":
            payload = {"expression": args.expression}
            if args.index is not None:
                payload["index"] = args.index
            if args.frame is not None:
                payload["frame"] = args.frame
            result = call_tool("browser_eval", payload, args.tab)
            emit(result, args.json)
            return 0

        parser.error(f"unknown command: {command}")
        return 2
    except CliError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
