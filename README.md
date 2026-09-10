# Non-Steam Activity for Lua Tools

**Non-Steam Activity** is a community-made Millennium plugin for Windows that publishes the name of a game added by **Lua Tools** as Steam activity.

It is an independent project and is not affiliated with, endorsed by, or distributed with Lua Tools.

## Features

- Detects Lua Tools games automatically; there is no hard-coded game list.
- Preserves the original Lua Tools launch process.
- Supports launches from the Steam library and Steam-created desktop shortcuts.
- Shows the running title as standard non-Steam game activity.
- Reuses one hidden helper shortcut instead of adding one shortcut per game.
- Applies the game's locally cached Steam artwork before launch.
- Clears the helper activity shortly after the real game closes.

## Requirements

- Windows 10 or newer (x64)
- [Millennium](https://docs.steambrew.app/users/getting-started/installation), installed in Steam and working
- Lua Tools, with at least one game added to the Steam library
- [.NET 8 Desktop Runtime (x64)](https://dotnet.microsoft.com/download/dotnet/8.0)
- Node.js 20 or newer with npm, only for development and rebuilding (Node.js 24 is used in CI)

## Installation

### Install a release or the GitHub ZIP (no npm required)

1. Install Millennium first and open Steam once to confirm that Millennium's settings are available.
2. Install Lua Tools and the .NET 8 Desktop Runtime listed above.
3. Download `non-steam-activity-0.4.9-windows-x64.zip` from the repository's Releases assets, if published. Alternatively use **Code → Download ZIP**. Version 0.4.9 includes the compiled frontend in both distributions.
4. Extract the ZIP. Verify that the plugin folder contains `plugin.json`, `.millennium/Dist/index.js`, `backend` and `launcher/LuaStatusMonitor.exe`.
5. Exit Steam completely, including from the system tray.
6. Copy the **contents of the extracted plugin folder**, including `.millennium`, to the Millennium plugins directory. Replace the old plugin files when updating. Use the location of your own Steam installation; a typical destination is:

   ```text
   C:\Program Files (x86)\Steam\millennium\plugins\non-steam-activity
   ```
   
7. Start Steam, open Millennium settings, enable **Non-Steam Activity**, and restart Steam once more if Millennium requests it.
8. Start a Lua Tools game normally from the Steam library or a Steam-created desktop shortcut. The profile should display the game as **In non-Steam game**.

The plugin does not replace or modify Lua Tools. Lua Tools remains responsible for launching the game; Non-Steam Activity only publishes and monitors the Steam presence.

## Building from source

Install Node.js with npm first, then reopen PowerShell. Check `node --version` and `npm --version`. If npm is not recognized, Node.js/npm is missing or its installation folder is not on PATH. This is not required to use the prebuilt plugin.

```powershell
npm ci
npm test
npm run build
```

The frontend output is written to `.millennium/Dist/index.js`. Commit the rebuilt file whenever the frontend changes. Keep `package-lock.json` in version control and use `npm ci`; the tested compiler uses TypeScript 5.9.3.

The repository includes the tested `launcher/LuaStatusMonitor.exe`. If changing the C# source, install the .NET 8 SDK (the runtime alone cannot compile it), then rebuild and copy the executable before packaging:

```powershell
dotnet publish launcher/LuaStatusMonitor.csproj -c Release -o launcher/publish
Copy-Item launcher/publish/LuaStatusMonitor.exe launcher/LuaStatusMonitor.exe -Force
```

### Prepare a GitHub update

On Windows, run `npm run package`. It tests and compiles the frontend, then creates:

- `dist/non-steam-activity-0.4.9-github-source.zip`: clean repository contents, including source, tests, workflow and compiled frontend. Extract and copy its contents into your repository checkout, preserving your checkout's `.git` folder and any unrelated repository files.
- `dist/non-steam-activity-0.4.9-windows-x64.zip`: installation package to attach to a GitHub Release tagged `v0.4.9`.
- A `.sha256` checksum for each archive.

The packaging script uses an explicit file list and excludes local caches, dependencies and diagnostic tools. Add new source files to that list when extending the plugin. The GitHub workflow tests and packages pushes and pull requests; it does not publish a release automatically.

## Troubleshooting a restored installation

Older repository ZIPs omitted the compiled frontend. Before restarting Steam, verify that `.millennium/Dist/index.js` exists inside the installed plugin folder. Copy the hidden `.millennium` folder too when moving an installation.

If Millennium's settings/menu disappears, exit Steam completely (including its tray icon) and reopen it. The plugin cannot operate while Millennium is absent from the Steam interface. This was observed after Steam recreated its interface during testing; the cause of that restart was not determined. If it persists, diagnose the Millennium installation before testing game activity again.

The frontend accepts a single numeric AppID as well as multiple comma-separated AppIDs. This matters on fresh installations with just one Lua Tools game, because the RPC response parser interprets a single numeric string as JSON.

Run the AppID regression checks with `npm test` after `npm ci`.

## Limitations

- Steam labels this presence as **In non-Steam game**. The plugin does not impersonate official Rich Presence, ownership, achievements, cards, or official playtime.
- Games with unusual multi-process launchers may require future executable detection improvements.
- Artwork is sourced from Steam's local library cache and may be unavailable until Steam has downloaded it.
- Directly opening the game executable bypasses the Steam/Lua Tools launch hook.

## Privacy

The plugin does not collect telemetry or send personal data to third-party services. It reads local Steam and Lua Tools files required to identify the installed game and its artwork.

## Distribution and third-party components

- This repository contains the complete source for the Millennium frontend and Lua backend, as well as the C# source for `LuaStatusMonitor.exe`.
- The published executable is built from `launcher/Program.cs`. It requires the user-installed .NET 8 Runtime; no .NET runtime is redistributed with the plugin.
- Lua Tools is a user-installed prerequisite. This plugin neither bundles, modifies, nor redistributes Lua Tools or game files.
- The frontend uses Millennium's public `@steambrew` development packages. `@steambrew/client` is licensed under LGPL-2.1-only and `@steambrew/ttc` under MIT; their sources are available from the SteamClientHomebrew organization. The React type definitions used only during compilation are MIT-licensed.
- No external paid service, account, telemetry endpoint, or network API is required to use the plugin.

## License

MIT
