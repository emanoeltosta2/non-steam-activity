# Third-party notices

Non-Steam Activity is distributed under the MIT License; see `LICENSE`.

## Millennium development packages

The frontend is compiled using the public packages maintained by SteamClientHomebrew:

- `@steambrew/client` — LGPL-2.1-only. Source: https://github.com/SteamClientHomebrew/PluginComponents
- `@steambrew/ttc` — MIT. Source: https://github.com/SteamClientHomebrew
- `@steambrew/api` — used as a Millennium development API package. Source: https://github.com/SteamClientHomebrew/PluginComponents

The plugin does not bundle the .NET runtime. `LuaStatusMonitor.exe` is built from the C# source in this repository and requires the user's .NET 8 Runtime installation.

## Build-time type definitions

- TypeScript — Apache-2.0, from Microsoft: https://github.com/microsoft/TypeScript

- `@types/react` and `@types/react-dom` — MIT, from DefinitelyTyped: https://github.com/DefinitelyTyped/DefinitelyTyped

No Lua binaries, game executables, assets, or copyrighted game content are included in this repository or the plugin package.
