namespace MafiaWeb.Models;

public class PublicPlayerDto
{
    public int SlotNumber { get; set; }
    public string? UserId { get; set; }
    public string Nickname { get; set; } = string.Empty;
    public bool IsOccupied { get; set; }
    public bool IsReady { get; set; }
    public bool IsAlive { get; set; } = true;
    public bool IsCurrentSpeaker { get; set; }
    public bool IsNominated { get; set; }
    public int Fouls { get; set; }
    public int ShoutsCount { get; set; }
    public bool LosesNextSpeech { get; set; }
    public string? RoleTitle { get; set; } // Видно только если это твоя роль, напарник-маф или конец игры
    public string? RoleCode { get; set; }  // "peaceful", "mafia", "don", "sheriff", "hidden"
    public int? VotedForSlot { get; set; }
}

public class PublicGameStateDto
{
    public GamePhase Phase { get; set; }
    public string PhaseTitle { get; set; } = string.Empty;
    public string PhaseDescription { get; set; } = string.Empty;
    public int DayNumber { get; set; }
    public int SecondsLeft { get; set; }
    public int? CurrentSpeakerSlot { get; set; }
    public List<int> NominatedSlots { get; set; } = new();
    public List<PublicPlayerDto> Slots { get; set; } = new();
    public List<GameEvent> RecentEvents { get; set; } = new();
    
    // Личная инфа смотрящего игрока
    public int? MySlotNumber { get; set; }
    public string? MyRoleCode { get; set; }
    public string? MyRoleTitle { get; set; }
    public bool CanSpeakNow { get; set; }
    public bool CanVoteNow { get; set; }
    public bool CanShootNow { get; set; }
    public bool CanCheckNow { get; set; }
    public bool HasNominatedThisTurn { get; set; }
    public bool HasCheckedThisNight { get; set; }
    public string? SheriffLastCheckResult { get; set; }
    public string? DonLastCheckResult { get; set; }
    public Dictionary<int, string> KnownChecks { get; set; } = new();
    public int? MyNightTargetSlot { get; set; }
    public int AliveMafiaCount { get; set; }
    public int? ActiveShoutSlotNumber { get; set; }
    public int ActiveShoutSecondsLeft { get; set; }
    public int MyShoutsCount { get; set; }
    public bool MyLosesNextSpeech { get; set; }
    
    public GameWinner Winner { get; set; }
}
