using MafiaWeb.Models;
using System.Security.Claims;
using MafiaWeb.Services;
using Microsoft.AspNetCore.SignalR;

namespace MafiaWeb.Hubs;

[Microsoft.AspNetCore.Authorization.Authorize]
public class GameHub : Hub
{
    private readonly GameRoomService _gameService;
    private readonly ILogger<GameHub> _logger;

    public GameHub(GameRoomService gameService, ILogger<GameHub> logger)
    {
        _gameService = gameService;
        _logger = logger;
    }

    private string RequireIdentity(string claimedUserId)
    {
        var actual = Context.User?.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(actual) || actual != claimedUserId)
            throw new HubException("Недопустимый идентификатор игрока.");
        return actual;
    }

    private void RequireHost()
    {
        var actual = Context.User?.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(actual) || actual != _gameService.HostUserId)
            throw new HubException("Это действие доступно только хозяину стола.");
    }

    public async Task VoteGroup(string userId, bool support)
    {
        RequireIdentity(userId);
        var result = _gameService.VoteGroup(userId, support);
        if (!result.Success)
            await Clients.Caller.SendAsync("OnErrorNotification", result.Message);
        else
            await BroadcastStateToAllAsync();
    }

    public async Task GetMyState(string userId)
    {
        RequireIdentity(userId);
        var previousConnection = _gameService.GetConnectionIdByUserId(userId);
        _gameService.UpdateConnectionId(userId, Context.ConnectionId);
        if (previousConnection != Context.ConnectionId)
        {
            await Clients.Others.SendAsync("OnVoicePeerReconnected", userId);
        }
        var state = _gameService.GetPublicStateForUser(userId);
        await Clients.Caller.SendAsync("OnStateUpdated", state);
    }

    public async Task SendWebRtcSignal(string senderUserId, string targetUserId, string signalData)
    {
        RequireIdentity(senderUserId);
        if (signalData.Length > 32768 || !_gameService.GetSlots().Any(s => s.UserId == senderUserId) || !_gameService.GetSlots().Any(s => s.UserId == targetUserId)) return;
        var targetConnId = _gameService.GetConnectionIdByUserId(targetUserId);
        if (!string.IsNullOrEmpty(targetConnId))
        {
            await Clients.Client(targetConnId).SendAsync("OnWebRtcSignal", senderUserId, signalData);
        }
    }

    public async Task SendVoiceActivity(string userId, bool isSpeaking)
    {
        RequireIdentity(userId);
        if (isSpeaking && !_gameService.CanUserSpeakNow(userId))
        {
            return;
        }

        var recipients = _gameService.GetAudibleConnectionIdsForSpeaker(userId);
        if (recipients.Count > 0)
        {
            await Clients.Clients(recipients).SendAsync("OnVoiceActivity", userId, isSpeaking);
        }
    }

    public async Task UpdateNickname(string userId, string nickname)
    {
        RequireIdentity(userId);
        _gameService.UpdateNickname(userId, nickname);
        await BroadcastStateToAllAsync();
    }

    public async Task TakeSlot(string userId, string nickname, int slotNumber)
    {
        RequireIdentity(userId);
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
        RequireIdentity(userId);
        _gameService.LeaveSlot(userId);
        await BroadcastStateToAllAsync();
    }

    public async Task ToggleReady(string userId)
    {
        RequireIdentity(userId);
        _gameService.ToggleReady(userId);
        await BroadcastStateToAllAsync();
    }

    public async Task StartGame()
    {
        RequireHost();
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
        RequireIdentity(userId);
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
        RequireIdentity(userId);
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
        RequireIdentity(userId);
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
        RequireIdentity(userId);
        var res = _gameService.NightAction(userId, targetSlotNumber);
        await Clients.Caller.SendAsync("OnNightActionResult", res.Message);
        await BroadcastStateToAllAsync();
    }

    public async Task DonCheck(string userId, int targetSlotNumber)
    {
        RequireIdentity(userId);
        var res = _gameService.DonCheck(userId, targetSlotNumber);
        await Clients.Caller.SendAsync("OnNightActionResult", res.Message);
        await BroadcastStateToAllAsync();
    }

    public async Task AddFoul(int targetSlotNumber)
    {
        await Clients.Caller.SendAsync("OnErrorNotification", "Ручная выдача фолов игроками отключена. Фолы начисляются автоматически по правилам игры (за выкрики).");
    }

    public async Task Shout(string userId)
    {
        RequireIdentity(userId);
        var res = _gameService.Shout(userId);
        if (!res.Success)
        {
            await Clients.Caller.SendAsync("OnErrorNotification", res.Message);
            return;
        }

        await BroadcastStateToAllAsync();
    }

    public async Task ConfigureTable(string configCode)
    {
        RequireHost();
        var res = _gameService.ConfigureTable(configCode);
        if (!res.Success)
        {
            await Clients.Caller.SendAsync("OnErrorNotification", res.Message);
            return;
        }

        await BroadcastStateToAllAsync();
    }

    public async Task SetTableSize(int size)
    {
        await ConfigureTable(size.ToString());
    }

    public async Task ResetGame()
    {
        RequireHost();
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
