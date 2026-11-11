FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ["MafiaWeb.csproj", "./"]
RUN dotnet restore "MafiaWeb.csproj"
COPY . .
RUN dotnet publish "MafiaWeb.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "MafiaWeb.dll"]
