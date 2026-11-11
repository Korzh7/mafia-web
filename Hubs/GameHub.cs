using MafiaWeb.Models;
using MafiaWeb.Services;
using Microsoft.AspNetCore.SignalR;

namespace MafiaWeb.Hubs;

public class GameHub : Hub
{
    private readonly GameRoomService _gameService;
    private readonly ILogger<GameHub> _logger;

    public GameHub(GameRoomService gameService, ILogger<GameHub> logger)
    {
        _gameService = gameService;
        _logger = logger;
    }

    public async Task GetMyState(string userId)
    {
        var state = _gameService.GetPublicStateForUser(userId);
        await Clients.Caller.SendAsync("OnStateUpdated", state);
    }

    public async Task TakeSlot(string userId, string nickname, int slotNumber)
    {
        var result = _gameService.TakeSlot(slotNumber, userId, nickname, Context.ConnectionId);
        if (!result.Success)
        {
            await Clients.Caller.SendAsync("OnErrorNotification", result.Message);
            return;
        }

        await BroadcastStateToAllAsync();
    }

    public async Task LeaveSlot(string userId)
    {
        _gameService.LeaveSlot(userId);
        await BroadcastStateToAllAsync();
    }

    public async Task ToggleReady(string userId)
    {
        _gameService.ToggleReady(userId);
        await BroadcastStateToAllAsync();
    }

    public async Task StartGame()
    {
        var res = _gameService.StartGame();
        if (!res.Success)
        {
            await Clients.Caller.SendAsync("OnErrorNotification", res.Message);
            return;
        }

        await BroadcastStateToAllAsync();
    }

    public async Task NominatePlayer(string userId, int targetSlotNumber)
    {
        var res = _gameService.NominatePlayer(userId, targetSlotNumber);
        if (!res.Success)
        {
            await Clients.Caller.SendAsync("OnErrorNotification", res.Message);
            return;
        }

        await BroadcastStateToAllAsync();
    }

    public async Task PassSpeech(string userId)
    {
        var res = _gameService.PassSpeech(userId);
        if (!res.Success)
        {
            await Clients.Caller.SendAsync("OnErrorNotification", res.Message);
            return;
        }

        await BroadcastStateToAllAsync();
    }

    public async Task Vote(string userId, int candidateSlotNumber)
    {
        var res = _gameService.Vote(userId, candidateSlotNumber);
        if (!res.Success)
        {
            await Clients.Caller.SendAsync("OnErrorNotification", res.Message);
            return;
        }

        // Обновляем состояние голосующего
        await GetMyState(userId);
    }

    public async Task NightAction(string userId, int targetSlotNumber)
    {
        var res = _gameService.NightAction(userId, targetSlotNumber);
        await Clients.Caller.SendAsync("OnActionNotification", res.Message);
        await GetMyState(userId);
    }

    public async Task ResetGame()
    {
        _gameService.ResetGame();
        await BroadcastStateToAllAsync();
    }

    private async Task BroadcastStateToAllAsync()
    {
        // Просим каждого подключенного клиента запросить свое персональное состояние
        await Clients.All.SendAsync("RequestStateRefresh");
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        // При дисконнекте не выкидываем из слота сразу (чтобы F5 не сбрасывал место)
        await base.OnDisconnectedAsync(exception);
    }
}
