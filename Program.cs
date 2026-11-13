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

app.MapGet("/api/health", () => Results.Ok(new { status = "ok", time = DateTime.UtcNow }));

// Гарантированная отдача index.html при заходе на главную страницу
app.MapFallbackToFile("index.html");

app.Run();
