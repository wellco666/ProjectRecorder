# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['E:/miniSoftware/ProjectRecorder/main.py'],
    pathex=['E:/miniSoftware/ProjectRecorder'],
    binaries=[],
    datas=[('E:/miniSoftware/ProjectRecorder/schema.sql', '.'), ('E:/miniSoftware/ProjectRecorder/style.qss', '.'), ('E:/miniSoftware/ProjectRecorder/README.md', '.'), ('E:/miniSoftware/ProjectRecorder/preview.html', '.')],
    hiddenimports=['db', 'rules', 'theme', 'widgets', 'chart', 'detail', 'export'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'unittest', 'pydoc_data', 'test', 'matplotlib', 'numpy', 'scipy', 'pandas', 'PyQt6.QtNetwork', 'PyQt6.QtQml', 'PyQt6.QtQuick', 'PyQt6.QtQuick3D', 'PyQt6.QtWebEngineCore', 'PyQt6.QtWebEngineWidgets', 'PyQt6.QtMultimedia', 'PyQt6.QtBluetooth', 'PyQt6.QtPositioning', 'PyQt6.QtSerialPort', 'PyQt6.QtDesigner', 'PyQt6.QtTest', 'PyQt6.QtHelp'],
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
    name='项目记录器',
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
)
