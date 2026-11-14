using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using MafiaWeb.Hubs;
using MafiaWeb.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Connections.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging.Abstractions;

int passed = 0, failed = 0;
async Task Test(string name, Func<Task> test)
{
    try { await test(); Console.WriteLine($"PASS {name}"); passed++; }
    catch (Exception e) { Console.WriteLine($"FAIL {name}: {e}"); failed++; }
}
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
GameRoomService Room()
{
    var room = new GameRoomService();
    Check(room.TakeSlot(1, "host", "Host", "old-host").Success, "host setup failed");
    Check(room.TakeSlot(2, "victim", "Victim", "old-victim").Success, "victim setup failed");
    return room;
}
GameHub Hub(GameRoomService room, string? identity, RecordingClients? clients = null) => new(room, NullLogger<GameHub>.Instance)
{
    Context = new FakeContext(identity), Clients = clients!
};
string Snapshot(GameRoomService room) => JsonSerializer.Serialize(new
{
    Views = new[] { room.GetPublicStateForUser("host"), room.GetPublicStateForUser("victim") },
    Slots = room.GetSlots(), room.HostUserId, room.Phase, room.DayNumber, room.SecondsLeft,
    HostConnection = room.GetConnectionIdByUserId("host"),
    VictimConnection = room.GetConnectionIdByUserId("victim")
});
async Task Forbidden(GameRoomService room, Func<Task> action)
{
    var before = Snapshot(room);
    try { await action(); throw new Exception("Expected HubException"); }
    catch (HubException) { }
    Check(before == Snapshot(room), "Forbidden request mutated state");
}
var identityCalls = new Dictionary<string, Func<GameHub, string, Task>>
{
    ["GetMyState"] = (h,u) => h.GetMyState(u),
    ["TakeSlot"] = (h,u) => h.TakeSlot(u,"Forged",3),
    ["Vote"] = (h,u) => h.Vote(u,1),
    ["NightAction"] = (h,u) => h.NightAction(u,1),
    ["SendWebRtcSignal"] = (h,u) => h.SendWebRtcSignal(u,"host","signal"),
    ["VoteGroup"] = (h,u) => h.VoteGroup(u,true),
    ["SendVoiceActivity"] = (h,u) => h.SendVoiceActivity(u,true),
    ["UpdateNickname"] = (h,u) => h.UpdateNickname(u,"Forged"),
    ["LeaveSlot"] = (h,u) => h.LeaveSlot(u),
    ["ToggleReady"] = (h,u) => h.ToggleReady(u),
    ["NominatePlayer"] = (h,u) => h.NominatePlayer(u,1),
    ["PassSpeech"] = (h,u) => h.PassSpeech(u),
    ["DonCheck"] = (h,u) => h.DonCheck(u,1),
    ["Shout"] = (h,u) => h.Shout(u)
};
foreach (var (name, call) in identityCalls)
foreach (var identity in new string?[] { "attacker", null })
    await Test($"{name}: reject {(identity is null ? "missing identity" : "spoofing")} before mutation/network", async () =>
    {
        var room = Room();
        await Forbidden(room, () => call(Hub(room,identity),"victim"));
    });
var hostCalls = new Dictionary<string, Func<GameHub,Task>>
{
    ["StartGame"] = h => h.StartGame(), ["ResetGame"] = h => h.ResetGame(),
    ["ConfigureTable"] = h => h.ConfigureTable("4"), ["AddFoul"] = h => h.AddFoul(2),
    ["SetTableSize"] = h => h.SetTableSize(4)
};
foreach (var (name, call) in hostCalls)
foreach (var identity in new string?[] { "victim", null })
    await Test($"{name}: reject non-host {identity ?? "anonymous"}", async () =>
    {
        var room = Room(); await Forbidden(room, () => call(Hub(room,identity)));
    });
foreach (var (name, call) in hostCalls)
    await Test($"{name}: authenticated host reaches service and clients", async () =>
    {
        var room = Room();
        if (name is "StartGame" or "AddFoul")
        {
            Check(room.ConfigureTable("2_mafia").Success,"configure setup");
            room.ToggleReady("host"); room.ToggleReady("victim");
        }
        if (name == "AddFoul") Check(room.StartGame().Success,"start setup for foul");
        if (name == "ResetGame") Check(room.ConfigureTable("4").Success,"reset setup");
        var before = Snapshot(room);
        var clients = new RecordingClients();
        await call(Hub(room,"host",clients));
        Check(clients.Messages.Contains("RequestStateRefresh"),"No successful state broadcast (service may have rejected request)");
        Check(before != Snapshot(room),"Authorized host had no observable effect");
    });
await Test("All public claimed-user methods begin with RequireIdentity", () =>
{
    var root = new DirectoryInfo(AppContext.BaseDirectory);
    while (root != null && !File.Exists(Path.Combine(root.FullName,"Hubs","GameHub.cs"))) root = root.Parent;
    Check(root != null,"Cannot find source root");
    var source = File.ReadAllText(Path.Combine(root!.FullName,"Hubs","GameHub.cs"));
    var methods = typeof(GameHub).GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
        .Where(m => m.GetParameters().Any(p => p.Name is "userId" or "senderUserId"));
    foreach (var method in methods)
    {
        var parameter = method.GetParameters().First(p => p.Name is "userId" or "senderUserId").Name;
        Check(identityCalls.ContainsKey(method.Name),$"Missing runtime test for {method.Name}");
        Check(Regex.IsMatch(source, $@"public\s+async\s+Task\s+{method.Name}\s*\([^)]*\)\s*\{{\s*RequireIdentity\({parameter}\);"), $"{method.Name} lacks first-statement identity guard");
    }
    Check(typeof(GameHub).IsDefined(typeof(AuthorizeAttribute)),"Hub missing Authorize");
    var program = File.ReadAllText(Path.Combine(root.FullName,"Program.cs"));
    Check(program.Contains("app.MapHub<GameHub>(\"/gameHub\").RequireAuthorization()"),"Hub endpoint unprotected");
    Check(Regex.IsMatch(program,@"MapGet\(""/api/voice-config""[\s\S]*?\}\)\.RequireAuthorization\(\)"),"Voice configuration endpoint unprotected");
    Check(program.IndexOf("app.UseAuthentication()",StringComparison.Ordinal) < program.IndexOf("app.UseAuthorization()",StringComparison.Ordinal),"Middleware order");
    return Task.CompletedTask;
});
Console.WriteLine($"RESULT: {passed} passed; {failed} failed");
return failed == 0 ? 0 : 1;

sealed class FakeContext : HubCallerContext
{
    public FakeContext(string? userId) => User = new ClaimsPrincipal(userId is null
        ? new ClaimsIdentity()
        : new ClaimsIdentity(new[] { new Claim(ClaimTypes.NameIdentifier,userId) },"TestCookie"));
    public override string ConnectionId => "new-connection";
    public override string? UserIdentifier => User.FindFirstValue(ClaimTypes.NameIdentifier);
    public override ClaimsPrincipal User { get; }
    public override IDictionary<object,object?> Items { get; } = new Dictionary<object,object?>();
    public override IFeatureCollection Features { get; } = new FeatureCollection();
    public override CancellationToken ConnectionAborted => CancellationToken.None;
    public override void Abort() { }
}
sealed class RecordingClients : IHubCallerClients, IClientProxy
{
    public List<string> Messages { get; } = new();
    public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default)
    { Messages.Add(method); return Task.CompletedTask; }
    public IClientProxy All => this;
    public IClientProxy Caller => this;
    public IClientProxy Others => this;
    public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) => this;
    public IClientProxy Client(string connectionId) => this;
    public IClientProxy Clients(IReadOnlyList<string> connectionIds) => this;
    public IClientProxy Group(string groupName) => this;
    public IClientProxy GroupExcept(string groupName,IReadOnlyList<string> excludedConnectionIds) => this;
    public IClientProxy Groups(IReadOnlyList<string> groupNames) => this;
    public IClientProxy OthersInGroup(string groupName) => this;
    public IClientProxy User(string userId) => this;
    public IClientProxy Users(IReadOnlyList<string> userIds) => this;
}
