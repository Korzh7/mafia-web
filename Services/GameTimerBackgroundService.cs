using MafiaWeb.Hubs;
using MafiaWeb.Services;
using Microsoft.AspNetCore.SignalR;

namespace MafiaWeb.Services;

public class GameTimerBackgroundService : BackgroundService
{
    private readonly GameRoomService _gameService;
    private readonly IHubContext<GameHub> _hubContext;
    private readonly ILogger<GameTimerBackgroundService> _logger;

    public GameTimerBackgroundService(
        GameRoomService gameService,
        IHubContext<GameHub> hubContext,
        ILogger<GameTimerBackgroundService> logger)
    {
        _gameService = gameService;
        _hubContext = hubContext;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (!stoppingToken.IsCancellationRequested && await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                // TickSecond возвращает true, если изменилась фаза, спикер или активный выкрик —
                // клиентам нужен полный рефреш, а не только значение таймера
                var stateChanged = _gameService.TickSecond();

                // Если игра идет, рассылаем таймер и состояние
                if (_gameService.Phase is not (Models.GamePhase.Lobby or Models.GamePhase.GameOver))
                {
                    // Оповещаем клиентов
                    await _hubContext.Clients.All.SendAsync("OnTimerTick", _gameService.SecondsLeft, stoppingToken);

                    if (stateChanged)
                    {
                        await BroadcastGameStateAsync(stoppingToken);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Штатная остановка сервиса — просто выходим
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Ошибка в таймере игры");
            }
        }
    }

    private async Task BroadcastGameStateAsync(CancellationToken ct)
    {
        // Каждому клиенту нужно прислать состояние с его перспективы (роли других скрыты!)
        await _hubContext.Clients.All.SendAsync("RequestStateRefresh", ct);
    }
}
