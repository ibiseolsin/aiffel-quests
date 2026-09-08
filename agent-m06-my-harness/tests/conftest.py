from pathlib import Path
import shutil
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture
def work(tmp_path: Path) -> Path:
    """fixtures/ 를 일회용 작업 폴더로 복사한다. 원본은 건드리지 않는다."""
    target = tmp_path / "work"
    shutil.copytree(ROOT / "fixtures", target)
    return target


@pytest.fixture
def outside(tmp_path: Path) -> Path:
    secret = tmp_path / "outside" / "secret.txt"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text("작업 폴더 밖의 파일\n", encoding="utf-8")
    return secret
