# 将 Narrative Bridge 与 LightRAG 的动态资源冻结为单目录 Sidecar。
from pathlib import Path

from PyInstaller.utils.hooks import collect_all

project_root = Path(SPECPATH).parent
lightrag_datas, lightrag_binaries, lightrag_hiddenimports = collect_all("lightrag")

analysis = Analysis(
    [str(project_root / "packaging" / "sidecarEntry.py")],
    pathex=[str(project_root)],
    binaries=lightrag_binaries,
    datas=lightrag_datas,
    hiddenimports=lightrag_hiddenimports,
    noarchive=False,
)
pyz = PYZ(analysis.pure)
executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="ema-narrative-bridge",
    console=True,
)
collect = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    name="ema-narrative-bridge",
)
