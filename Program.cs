using MafiaWeb.Hubs;
using MafiaWeb.Services;

var builder = WebApplication.CreateBuilder(args);

// Поддержка порта от облачных провайдеров (Render / Koyeb передают переменную PORT)
var port = Environment.GetEnvironmentVariable("PORT");
if (!string.IsNullOrEmpty(port))
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
}

// Сервисы
builder.Services.AddSignalR(options =>
{
    // Подробные ошибки SignalR — только в Development, чтобы не палить исключения клиентам
    options.EnableDetailedErrors = builder.Environment.IsDevelopment();
});

builder.Services.AddSingleton<GameRoomService>();
builder.Services.AddHostedService<GameTimerBackgroundService>();

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.AllowAnyHeader()
              .AllowAnyMethod()
              .SetIsOriginAllowed(_ => true)
              .AllowCredentials();
    });
});

var app = builder.Build();

app.UseCors();
app.UseWebSockets();
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapHub<GameHub>("/gameHub");

// TURN credentials are delivered to browsers because WebRTC uses them directly.
// Use a dedicated, restricted TURN account (not your provider API key).
app.MapGet("/api/voice-config", (IConfiguration configuration, HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    var servers = new List<object>
    {
        new { urls = new[] { "stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478" } }
    };
    var urls = configuration["TURN_URLS"]?
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    var username = configuration["TURN_USERNAME"];
    var credential = configuration["TURN_CREDENTIAL"];
    bool hasTurn = urls is { Length: > 0 } && !string.IsNullOrWhiteSpace(username)
        && !string.IsNullOrWhiteSpace(credential);
    if (hasTurn)
        servers.Add(new { urls, username, credential });
    return Results.Ok(new { iceServers = servers, hasTurn });
});

app.MapGet("/api/health", () => Results.Ok(new { status = "ok", time = DateTime.UtcNow }));

// Гарантированная отдача index.html при заходе на главную страницу
app.MapFallbackToFile("index.html");

app.Run();
