@echo off
chcp 65001 > nul
title Мафия Онлайн (Сервер)
cd /d "C:\dev\csharp\MafiaWeb"
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\dev\csharp\MafiaWeb\start.ps1"
pause
