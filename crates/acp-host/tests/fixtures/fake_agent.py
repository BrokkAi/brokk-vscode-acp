import json
import os
import sys


MODE = sys.argv[1] if len(sys.argv) > 1 else "normal"
SESSION_ID = "session-new"
pending_new = None
pending_prompt = None
terminal_id = None

if MODE == "exit":
    sys.stderr.write("fake agent exited before initialization\n")
    sys.stderr.flush()
    raise SystemExit(7)


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def result(request_id, value):
    send({"jsonrpc": "2.0", "id": request_id, "result": value})


def error(request_id, code, message):
    send(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": message},
        }
    )


def request(request_id, method, params):
    send(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }
    )


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}

    if method is None and MODE == "clientio":
        if request_id == 100:
            request(
                101,
                "fs/read_text_file",
                {
                    "sessionId": SESSION_ID,
                    "path": os.path.join(os.getcwd(), "agent-created.txt"),
                },
            )
        elif request_id == 101:
            request(
                109,
                "fs/read_text_file",
                {"sessionId": SESSION_ID, "path": "/definitely/outside/workspace"},
            )
        elif request_id == 109:
            request(
                102,
                "terminal/create",
                {
                    "sessionId": SESSION_ID,
                    "command": "python3",
                    "args": ["-c", "print('terminal output')"],
                },
            )
        elif request_id == 102:
            terminal_id = message["result"]["terminalId"]
            request(
                103,
                "terminal/wait_for_exit",
                {"sessionId": SESSION_ID, "terminalId": terminal_id},
            )
        elif request_id == 103:
            request(
                104,
                "terminal/output",
                {"sessionId": SESSION_ID, "terminalId": terminal_id},
            )
        elif request_id == 104:
            request(
                105,
                "terminal/release",
                {"sessionId": SESSION_ID, "terminalId": terminal_id},
            )
        elif request_id == 105:
            request(
                106,
                "terminal/create",
                {
                    "sessionId": SESSION_ID,
                    "command": "python3",
                    "args": ["-c", "import time; time.sleep(30)"],
                },
            )
        elif request_id == 106:
            terminal_id = message["result"]["terminalId"]
            request(
                107,
                "terminal/kill",
                {"sessionId": SESSION_ID, "terminalId": terminal_id},
            )
        elif request_id == 107:
            request(
                108,
                "terminal/release",
                {"sessionId": SESSION_ID, "terminalId": terminal_id},
            )
        elif request_id == 108:
            result(pending_new, {"sessionId": SESSION_ID})
            pending_new = None
        elif request_id == 200:
            result(pending_prompt, {"stopReason": "end_turn"})
            pending_prompt = None
    elif method == "initialize":
        if MODE == "unsupported":
            capabilities = {"loadSession": False, "sessionCapabilities": {}}
        else:
            capabilities = {
                "loadSession": MODE != "resume",
                "sessionCapabilities": {"list": {}, "delete": {}, "resume": {}},
            }
        result(
            request_id,
            {
                "protocolVersion": 1,
                "agentCapabilities": capabilities,
                "authMethods": [],
                "agentInfo": {"name": "Brokk test agent", "version": "1.0"},
            },
        )
    elif method == "session/list":
        result(
            request_id,
            {
                "sessions": [
                    {
                        "sessionId": "saved-session",
                        "cwd": os.getcwd(),
                        "title": "Saved session",
                    }
                ]
            },
        )
    elif method == "session/new":
        if MODE == "reject":
            error(request_id, -32603, "new session rejected")
        elif MODE == "clientio":
            pending_new = request_id
            request(
                100,
                "fs/write_text_file",
                {
                    "sessionId": SESSION_ID,
                    "path": os.path.join(os.getcwd(), "agent-created.txt"),
                    "content": "written by fake agent",
                },
            )
        else:
            result(request_id, {"sessionId": SESSION_ID})
    elif method in ("session/load", "session/resume"):
        result(request_id, {})
    elif method == "session/prompt":
        if MODE == "clientio":
            pending_prompt = request_id
            request(
                200,
                "session/request_permission",
                {
                    "sessionId": params.get("sessionId", SESSION_ID),
                    "toolCall": {"toolCallId": "tool-1", "title": "Write file"},
                    "options": [
                        {
                            "optionId": "allow_once",
                            "name": "Allow",
                            "kind": "allow_once",
                        }
                    ],
                },
            )
        else:
            send(
                {
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": params.get("sessionId", SESSION_ID),
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "test response"},
                        },
                    },
                }
            )
            result(request_id, {"stopReason": "end_turn"})
    elif method == "session/set_config_option":
        result(request_id, {"configOptions": []})
    elif method == "session/delete":
        result(request_id, {})
    elif method == "authenticate":
        result(request_id, {})
    elif request_id is not None:
        error(request_id, -32601, f"unsupported method {method}")
