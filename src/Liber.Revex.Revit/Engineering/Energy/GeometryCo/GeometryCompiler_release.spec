# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

ROOT = Path(SPECPATH)

a = Analysis(
    [str(ROOT / "OpenStudio_Energy_Model_Geometry_Compiler.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[
        (str(ROOT / "local_ai_model"), "local_ai_model"),
        (str(ROOT / "GeometryCompiler.ico"), "."),
    ],
    hiddenimports=[
        "local_space_ai",
        "numpy",
        "onnxruntime",
        "shapely",
        "shapely.geometry",
        "shapely.ops",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="OpenStudio_Energy_Model_Geometry_Compiler",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / "GeometryCompiler.ico"),
)
