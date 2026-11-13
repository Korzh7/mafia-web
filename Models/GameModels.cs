namespace MafiaWeb.Models;

public enum PlayerRole
{
    Unknown,
    Peaceful,   // Мирный житель
    Mafia,      // Мафия
    Don,        // Дон мафии
    Sheriff     // Шериф
}

public enum GamePhase
{
    Lobby,          // Ожидание игроков
    NightZero,      // Ночь знакомства и договорки (голос у мафии)
    DayDiscussion,  // Дневная речь по очереди
    Voting,         // Голосование по кандидатам
    Night,          // Обычная ночь (стрельба и проверки)
    GameOver        // Окончание игры
}

public enum GameWinner
{
    None,
    Peacefuls,
    Mafia
}

public enum RoomMode
{
    Standard = 0,
    TestTwoPeacefuls = 1,
    TestTwoMafia = 2
}

public class PlayerSlot
{
    public int SlotNumber { get; set; } // 1..12
    public string? UserId { get; set; }
    public string? ConnectionId { get; set; }
    public string Nickname { get; set; } = string.Empty;
    public bool IsReady { get; set; }
    public bool IsAlive { get; set; } = true;
    public PlayerRole Role { get; set; } = PlayerRole.Unknown;
    public int Fouls { get; set; } = 0;
    public int ShoutsCount { get; set; } = 0;
    public bool LosesNextSpeech { get; set; } = false;
    
    // Ночные действия
    public int? NightTargetSlot { get; set; }
    
    // Голосование
    public int? VotedForSlot { get; set; }
}

public class GameEvent
{
    public string Text { get; set; } = string.Empty;
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    public string Type { get; set; } = "info"; // info, alert, night, death
}
