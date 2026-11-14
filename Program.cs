using MafiaWeb.Hubs;
using MafiaWeb.Services;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using System.Security.Claims;

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

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name = "MafiaWeb.Session";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Strict;
        options.Cookie.SecurePolicy = builder.Environment.IsDevelopment()
            ? CookieSecurePolicy.SameAsRequest : CookieSecurePolicy.Always;
        options.ExpireTimeSpan = TimeSpan.FromDays(30);
        options.SlidingExpiration = true;
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
    });
builder.Services.AddAuthorization();

var app = builder.Build();

// Reject cross-site session creation and WebSocket handshakes. CORS is not
// enabled: the browser client and server intentionally share the same origin.
app.Use(async (context, next) =>
{
    if (context.Request.Path.StartsWithSegments("/gameHub") || context.Request.Path == "/api/session")
    {
        var origin = context.Request.Headers.Origin.ToString();
        if (!string.IsNullOrEmpty(origin) &&
            (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) ||
             !string.Equals(uri.Authority, context.Request.Host.Value, StringComparison.OrdinalIgnoreCase)))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
    }
    await next();
});
app.UseAuthentication();
app.UseAuthorization();
app.UseWebSockets();
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapPost("/api/session", async (HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
    if (string.IsNullOrEmpty(userId))
    {
        userId = "usr_" + Guid.NewGuid().ToString("N");
        var identity = new ClaimsIdentity(new[] { new Claim(ClaimTypes.NameIdentifier, userId) },
            CookieAuthenticationDefaults.AuthenticationScheme);
        await context.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme,
            new ClaimsPrincipal(identity), new AuthenticationProperties { IsPersistent = true });
    }
    return Results.Ok(new { userId });
});

app.MapHub<GameHub>("/gameHub").RequireAuthorization();

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
}).RequireAuthorization();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok", time = DateTime.UtcNow }));

// Гарантированная отдача index.html при заходе на главную страницу
app.MapFallbackToFile("index.html");

app.Run();
