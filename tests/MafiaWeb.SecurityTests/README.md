# Security regression tests

Standalone net8.0 console runner, no NuGet packages and no ProjectReference. Links the actual GameHub, GameRoomService and models; uses Microsoft.AspNetCore.App FrameworkReference.

Run from repository root:

```powershell
dotnet run --project tests/MafiaWeb.SecurityTests/MafiaWeb.SecurityTests.csproj
```

On the inspected machine ASP.NET Core 8.0.34 requires .NETCore 8.0.34, but only .NETCore 8.0.28 is installed. Tests were built for net8.0 and successfully executed using the installed matching 10.0.13 frameworks:

```powershell
$env:DOTNET_ROLL_FORWARD = 'LatestMajor'
dotnet run --project tests/MafiaWeb.SecurityTests/MafiaWeb.SecurityTests.csproj
```

Result: 44 passed, 0 failed. Normal deployment/runtime remains net8.0; no project roll-forward policy is changed.

Coverage:
- All 14 caller-userId methods reject mismatched/missing identity with HubException before touching null clients; snapshots of both private views, slots and connection mappings remain unchanged.
- Five host operations (including SetTableSize delegation) reject non-host/missing identity before mutation/network.
- Authenticated host successfully starts/resets/configures a table and assigns a foul; checks actual changes and successful refresh broadcasts, not merely absence of exceptions.
- Source/metadata checks: RequireIdentity is first statement of every public claimed-user method, corresponding runtime test exists, Hub Authorize, hub/voice endpoint RequireAuthorization and authentication middleware order.

Limitations: direct Hub invocation, not HTTP integration or real cookie/WebSocket negotiation; snapshot comparisons cover observable state, not every private field. Source-shape assertions intentionally require review after refactoring.

Auth review (no production changes made):
- Current identity guards block the reviewed caller-id spoofing paths. Host guard covers all reviewed administrative methods.
- RequireIdentity/RequireHost themselves do not inspect Identity.IsAuthenticated. Real endpoints are protected with Authorize; do not expose the Hub without authorization. An unauthenticated ClaimsIdentity carrying NameIdentifier would pass these helpers in isolation.
- Cookie SecurePolicy is SameAsRequest, and HTTP is explicitly supported. Without enforced HTTPS a session cookie may travel over plaintext; reverse proxy HTTPS/forwarded-header deployment needs verification.
- Origin middleware compares authority only, not scheme, and accepts missing Origin. This is not a strict same-origin comparison; HttpOnly/SameSite=Strict help but should not be represented as comprehensive CSRF/WS-origin validation.
- /api/session intentionally issues guest credentials anonymously. Authorization of /api/voice-config therefore does not prevent arbitrary guests obtaining the shared TURN credential. Use restricted/expiring TURN credentials and quotas; no rate limiting appears in Program.cs.
- First occupied slot becomes host. With no admission control, a fresh guest can claim host in an empty room and multiple guest sessions can occupy slots (game-abuse risk, not identity-spoofing bypass).
