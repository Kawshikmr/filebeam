@echo off
cd /d "%~dp0"
python filebeam.py
if errorlevel 1 pause
