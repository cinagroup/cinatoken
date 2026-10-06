"""Bound one Linux fixture process group; retain its complete output on failure."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("the executor requires Linux")
    repo = Path(args.repo).resolve(strict=True)
    output = Path(args.out).resolve()
    output.mkdir(exist_ok=False)
    node = shutil.which("node")
    if not node:
        parser.error("Node is unavailable")
    command = [node, str(repo / "scripts/smoke/test-workerd-product-sse-cancel.mjs"),
               "--execute-linux", "--out", str(output / "fixture"),
               "--source-sha", args.source_sha]
    began = time.time()
    timed_out = False
    fallback = []
    errors = []
    child = None
    actual_exit = None
    remaining = False
    with (output / "stdout.log").open("xb") as stdout, (output / "stderr.log").open("xb") as stderr:
        def group_exists():
            if child is None:
                return False
            try:
                os.killpg(child.pid, 0)
                return True
            except ProcessLookupError:
                return False

        def stop_group(sig):
            if child is None:
                return
            try:
                os.killpg(child.pid, sig)
                fallback.append(signal.Signals(sig).name)
            except ProcessLookupError:
                pass

        try:
            child = subprocess.Popen(command, cwd=repo, stdout=stdout, stderr=stderr,
                                     stdin=subprocess.DEVNULL, start_new_session=True)
            try:
                actual_exit = child.wait(timeout=120)
            except subprocess.TimeoutExpired:
                timed_out = True
                stop_group(signal.SIGTERM)
                try:
                    actual_exit = child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    stop_group(signal.SIGKILL)
                    actual_exit = child.wait(timeout=5)
        except BaseException as error:
            errors.append({"type": type(error).__name__, "message": str(error)})
        finally:
            # A successful parent alone does not prove its native child stopped.
            try:
                deadline = time.monotonic() + 2
                while group_exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                if group_exists():
                    stop_group(signal.SIGKILL)
                if child is not None and child.returncode is None:
                    child.wait(timeout=5)
                deadline = time.monotonic() + 3
                while group_exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                remaining = group_exists()
            except BaseException as error:
                errors.append({"type": type(error).__name__, "message": str(error)})
                remaining = None
            if child is not None:
                actual_exit = child.returncode
    logs = {}
    for name in ["stdout.log", "stderr.log"]:
        data = (output / name).read_bytes()
        logs[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    terminal_closed = child is not None and child.returncode is not None
    passed = terminal_closed and actual_exit == 0 and not timed_out and not fallback and remaining is False and not errors
    record = {"command": command, "startedAtUnix": began, "endedAtUnix": time.time(),
              "childPid": child.pid if child else None, "ownedProcessGroup": child.pid if child else None, "actualExit": actual_exit,
              "timedOut": timed_out, "fallbackSignals": fallback, "ownedGroupRemaining": remaining,
              "terminalClosed": terminal_closed, "errors": errors,
              "passed": passed, "logs": logs, "gracefulWorkerdExitProven": False}
    (output / "executor.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(record))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
