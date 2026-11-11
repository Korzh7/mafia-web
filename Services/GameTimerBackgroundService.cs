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
                var prevPhase = _gameService.Phase;
                var prevSpeaker = _gameService.CurrentSpeakerSlot;

                _gameService.TickSecond();

                // Если игра идет, рассылаем таймер и состояние
                if (_gameService.Phase != Models.GamePhase.Lobby)
                {
                    // Оповещаем клиентов
                    await _hubContext.Clients.All.SendAsync("OnTimerTick", _gameService.SecondsLeft, stoppingToken);

                    // Если сменилась фаза или спикер — отправляем полный апдейт
                    if (prevPhase != _gameService.Phase || prevSpeaker != _gameService.CurrentSpeakerSlot)
                    {
                        await BroadcastGameStateAsync(stoppingToken);
                    }
                }
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
        // Для простоты отправляем персональное состояние через вызов на клиенте или запрос
        await _hubContext.Clients.All.SendAsync("RequestStateRefresh", ct);
    }
}
