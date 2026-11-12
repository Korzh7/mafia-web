# Скрипт запуска сервера Мафии и создания ссылки для друзей без VPN
$ErrorActionPreference = "Continue"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Запуск сервера «Мафия Онлайн»        " -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan

# 0. Останавливаем старые застрявшие процессы, если были
Stop-Process -Name "cloudflared" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "MafiaWeb" -Force -ErrorAction SilentlyContinue

# 1. Запуск .NET сервера
Write-Host "`n[1/3] Запуск игрового сервера MafiaWeb..." -ForegroundColor Green

$exePath = "$PSScriptRoot\bin\Release\net8.0\MafiaWeb.exe"
if (-not (Test-Path $exePath)) {
    $exePath = "$PSScriptRoot\bin\Release\net10.0\MafiaWeb.exe"
}
if (-not (Test-Path $exePath)) {
    $exePath = "$PSScriptRoot\bin\Debug\net8.0\MafiaWeb.exe"
}
if (-not (Test-Path $exePath)) {
    $exePath = "$PSScriptRoot\bin\Debug\net10.0\MafiaWeb.exe"
}

if (-not (Test-Path $exePath)) {
    Write-Host "[!] Исполняемый файл не найден. Выполняем компиляцию..." -ForegroundColor Yellow
    dotnet build "$PSScriptRoot\MafiaWeb.csproj" -c Release
}

$dotnetProcess = Start-Process -FilePath $exePath -ArgumentList "--urls http://127.0.0.1:5232" -WorkingDirectory $PSScriptRoot -PassThru

Start-Sleep -Seconds 2

if ($dotnetProcess.HasExited) {
    Write-Host "[X] Ошибка запуска сервера MafiaWeb! Код: $($dotnetProcess.ExitCode)" -ForegroundColor Red
    pause
    exit
}

# 2. Запуск защищенного тоннеля Cloudflare через HTTP/2 (работает в РФ без VPN)
Write-Host "[2/3] Подключение защищенного тоннеля Cloudflare (HTTP/2)..." -ForegroundColor Green
$logFile = "$PSScriptRoot\tunnel.log"
if (Test-Path $logFile) { Remove-Item $logFile -Force }

$cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cloudflaredPath)) {
    $cloudflaredPath = (Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source
}

if (-not (Test-Path $cloudflaredPath)) {
    Write-Host "[X] Не найден cloudflared.exe!" -ForegroundColor Red
    pause
    exit
}

$tunnelProcess = Start-Process -FilePath $cloudflaredPath -ArgumentList "tunnel --protocol http2 --url http://127.0.0.1:5232" -RedirectStandardError $logFile -RedirectStandardOutput "$PSScriptRoot\tunnel_out.log" -PassThru -NoNewWindow

# 3. Ожидание генерации ссылки и регистрации на серверах Cloudflare
Write-Host "[3/3] Ожидание всемирной DNS-регистрации ссылки..." -ForegroundColor Green
$tunnelUrl = ""
$registered = $false
$attempts = 0

while ($attempts -lt 35 -and -not $registered) {
    Start-Sleep -Seconds 1
    $attempts++
    if (Test-Path $logFile) {
        try {
            $stream = [System.IO.File]::Open($logFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $reader = New-Object System.IO.StreamReader($stream)
            $content = $reader.ReadToEnd()
            $reader.Close()
            $stream.Close()

            if ([string]::IsNullOrEmpty($tunnelUrl) -and $content -match '(https://[-a-zA-Z0-9]+\.trycloudflare\.com)') {
                $tunnelUrl = $matches[1]
                Write-Host " [OK] Ссылка сгенерирована: $tunnelUrl" -ForegroundColor Cyan
            }
            if ($content -match 'Registered tunnel connection') {
                $registered = $true
                Write-Host " [OK] Тоннель успешно зарегистрирован на узлах Cloudflare!" -ForegroundColor Green
            }
        } catch {}
    }
}

# Проверка готовности DNS, чтобы в браузере не было ошибки ERR_NAME_NOT_RESOLVED
if ($tunnelUrl) {
    $domain = $tunnelUrl -replace 'https://',''
    Write-Host " [..] Проверка доступности домена $domain..." -ForegroundColor Gray
    for ($i = 0; $i -lt 10; $i++) {
        try {
            $ips = [System.Net.Dns]::GetHostAddresses($domain)
            if ($ips.Count -gt 0) {
                Write-Host " [OK] DNS готов: $($ips[0].IPAddressToString)" -ForegroundColor Green
                break
            }
        } catch {
            Start-Sleep -Seconds 1
        }
    }
}

Clear-Host
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   МАФИЯ ОНЛАЙН УСПЕШНО ЗАПУЩЕНА! (БЕЗ VPN В РФ)                " -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""
if ($tunnelUrl) {
    Write-Host " ССЫЛКА ДЛЯ ДРУЗЕЙ (отправь им в Telegram / WhatsApp / Discord):" -ForegroundColor Yellow
    Write-Host " >>> $tunnelUrl <<<" -ForegroundColor White -BackgroundColor DarkGreen
    Write-Host ""
    Write-Host "   (Ссылка автоматически скопирована в буфер обмена!)" -ForegroundColor Gray
    try { Set-Clipboard -Value $tunnelUrl } catch {}
} else {
    Write-Host " [!] Ссылка еще создается, подождите пару секунд..." -ForegroundColor Yellow
}

Write-Host ""
Write-Host " ТВОЯ ЛОКАЛЬНАЯ ССЫЛКА: http://localhost:5232" -ForegroundColor Cyan
Write-Host ""
Write-Host " Для остановки сервера нажмите любую клавишу в этом окне." -ForegroundColor DarkGray
Write-Host "================================================================" -ForegroundColor Cyan

# Открываем браузер у хоста
if ($tunnelUrl) {
    Start-Process $tunnelUrl
} else {
    Start-Process "http://localhost:5232"
}

# Держим процесс активным и слушаем нажатие клавиши
try {
    while (-not $dotnetProcess.HasExited -and -not $tunnelProcess.HasExited) {
        try {
            if ([System.Console]::KeyAvailable) {
                $null = [System.Console]::ReadKey($true)
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
} finally {
    Write-Host "`nОстановка сервера и тоннеля..." -ForegroundColor Yellow
    if ($dotnetProcess -and -not $dotnetProcess.HasExited) {
        Stop-Process -Id $dotnetProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
        Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Name "cloudflared" -Force -ErrorAction SilentlyContinue
    Stop-Process -Name "MafiaWeb" -Force -ErrorAction SilentlyContinue
    Write-Host "Сервер остановлен." -ForegroundColor Green
}
