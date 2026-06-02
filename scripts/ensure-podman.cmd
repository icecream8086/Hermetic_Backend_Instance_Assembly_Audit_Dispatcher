@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-podman.ps1"
if %errorlevel% neq 0 (
  echo [WARN] Podman API startup failed — app will use stub provider
)
