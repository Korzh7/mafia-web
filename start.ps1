# Скрипт запуска сервера Мафии и создания ссылки для друзей
$ErrorActionPreference = "Continue"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Запуск сервера «Мафия Онлайн»        " -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan

# 1. Запуск .NET сервера
Write-Host "`n[1/3] Запуск локального сервера .NET 10..." -ForegroundColor Green
$dotnetProcess = Start-Process -FilePath "dotnet" -ArgumentList "run --project `"$PSScriptRoot\MafiaWeb.csproj`" --launch-profile http" -PassThru -NoNewWindow

Start-Sleep -Seconds 3

# 2. Запуск защищенного туннеля через SSH (без блокировок)
Write-Host "[2/3] Создание публичной ссылки для друзей через SSH..." -ForegroundColor Green
$logFile = "$PSScriptRoot\tunnel.log"
if (Test-Path $logFile) { Remove-Item $logFile -Force }

$tunnelProcess = Start-Process -FilePath "ssh" -ArgumentList "-o StrictHostKeyChecking=no -R 80:127.0.0.1:5232 nokey@localhost.run" -RedirectStandardOutput $logFile -RedirectStandardError "$PSScriptRoot\tunnel_err.log" -PassThru -NoNewWindow

# 3. Ожидание генерации ссылки
$tunnelUrl = ""
$attempts = 0
while ($attempts -lt 25 -and [string]::IsNullOrEmpty($tunnelUrl)) {
    Start-Sleep -Seconds 1
    $attempts++
    if (Test-Path $logFile) {
        try {
            $stream = [System.IO.File]::Open($logFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $reader = New-Object System.IO.StreamReader($stream)
            $content = $reader.ReadToEnd()
            $reader.Close()
            $stream.Close()
            if ($content -match '(https://[-a-zA-Z0-9]+\.lhr\.life)') {
                $tunnelUrl = $matches[1]
            }
        } catch {}
    }
}

Clear-Host
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   МАФИЯ ОНЛАЙН УСПЕШНО ЗАПУЩЕНА!                               " -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""
if ($tunnelUrl) {
    Write-Host " ССЫЛКА ДЛЯ ДРУЗЕЙ (отправь им в Telegram / WhatsApp / Discord):" -ForegroundColor Yellow
    Write-Host " >>> $tunnelUrl <<<" -ForegroundColor White -BackgroundColor DarkRed
    Write-Host ""
    Write-Host "   (Ссылка скопирована в буфер обмена!)" -ForegroundColor Gray
    try { Set-Clipboard -Value $tunnelUrl } catch {}
} else {
    Write-Host " [!] Ссылка еще создается, подождите несколько секунд..." -ForegroundColor Yellow
}

Write-Host " ТВОЯ ЛОКАЛЬНАЯ ССЫЛКА: http://localhost:5232" -ForegroundColor Cyan
Write-Host ""
Write-Host " Для остановки сервера просто закрой это окно." -ForegroundColor Gray
Write-Host "================================================================" -ForegroundColor Cyan

# Открываем браузер у хоста
Start-Process "http://localhost:5232"

# Держим процесс активным
try {
    Wait-Process -Id $dotnetProcess.Id
} finally {
    Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $dotnetProcess.Id -Force -ErrorAction SilentlyContinue
}
