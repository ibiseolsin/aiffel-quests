"""작업 폴더 안의 Python 파일을 제한된 시간 안에 실행한다.

프로세스 제어이지 OS 샌드박스가 아니다. 표준출력·표준오류는 상한까지만 모으고,
시간이 지나면 프로세스를 죽인다. POSIX 는 프로세스 그룹째, Windows 는 직접 프로세스만.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import signal
import sys

STREAM_LIMIT = 200_000
# 실행되는 스크립트가 작업 폴더의 형제 모듈을 import 할 수 있어야 한다(과제 코드가 그렇게 쓴다).
DRIVER = """import os, runpy, sys
workspace, script = sys.argv[1], sys.argv[2]
# -I 는 cwd 를 sys.path 에 넣지 않는다. 과제 코드가 같은 폴더의 모듈을 import 하므로
# 시작 폴더와 작업 폴더 루트를 직접 넣어 준다.
sys.path.insert(0, workspace)
sys.path.insert(0, os.getcwd())
sys.argv = [script] + sys.argv[3:]
runpy.run_path(script, run_name='__main__')
"""
# 실행 환경은 화이트리스트로만 넘긴다 — API 키가 자식 프로세스로 새지 않게.
ENV_KEEP = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
            "PATHEXT", "COMSPEC", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
            "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH"}


async def run_argv(argv: list[str], cwd: Path, timeout: float) -> dict:
    # -I (isolated) 는 PYTHON* 환경변수를 전부 무시한다 — 인코딩은 -X utf8=1 로 준다.
    env = {key: value for key, value in os.environ.items() if key.upper() in ENV_KEEP}
    process = await asyncio.create_subprocess_exec(
        *argv, cwd=str(cwd), env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        start_new_session=os.name != "nt",
    )
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    truncated = False

    async def drain(stream, name: str) -> None:
        nonlocal truncated
        while chunk := await stream.read(8192):
            room = max(0, STREAM_LIMIT - len(buffers[name]))
            buffers[name].extend(chunk[:room])
            if len(chunk) > room:
                truncated = True

    readers = [asyncio.create_task(drain(process.stdout, "stdout")),
               asyncio.create_task(drain(process.stderr, "stderr"))]
    finish = asyncio.create_task(_wait(process, readers))
    timed_out = False
    try:
        done, _ = await asyncio.wait({finish}, timeout=timeout)
        timed_out = not done
        if finish in done:
            finish.result()
    finally:
        if timed_out:
            _kill(process)
            # 죽인 뒤에도 파이프를 비워 줘야 wait() 가 끝난다. 그 자체에 기한을 둔다.
            completed, _ = await asyncio.wait({finish}, timeout=2)
            if not completed:
                finish.cancel()
                for reader in readers:
                    reader.cancel()
            await asyncio.gather(finish, *readers, return_exceptions=True)
        # asyncio 는 서브프로세스 파이프 전송을 닫는 공개 API 를 주지 않는다.
        # Windows proactor 에서 GC 때까지 파이프가 남아 경고가 나므로 여기서 닫는다.
        transport = getattr(process, "_transport", None)
        if transport is not None:
            transport.close()
    return {"exit_code": process.returncode,
            "stdout": bytes(buffers["stdout"]).decode("utf-8", errors="replace"),
            "stderr": bytes(buffers["stderr"]).decode("utf-8", errors="replace"),
            "timed_out": timed_out, "truncated": truncated}


async def _wait(process, readers) -> None:
    await asyncio.gather(*readers)
    await process.wait()


def _kill(process) -> None:
    if os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGKILL)
            return
        except (ProcessLookupError, PermissionError):
            return
    if process.returncode is None:
        try:
            process.kill()
        except (ProcessLookupError, OSError):
            pass


async def run_python_file(workspace: Path, script: Path, args: list[str], cwd: Path,
                          timeout: float) -> dict:
    argv = [sys.executable, "-I", "-u", "-X", "utf8=1", "-c", DRIVER,
            str(workspace), str(script), *args]
    return await run_argv(argv, cwd, timeout)


async def run_unittest(workspace: Path, target_args: list[str], timeout: float) -> dict:
    argv = [sys.executable, "-I", "-u", "-X", "utf8=1", "-m", "unittest", "discover", *target_args]
    return await run_argv(argv, workspace, timeout)
