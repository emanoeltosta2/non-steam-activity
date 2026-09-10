# Changelog

## 0.4.9

- Fix detection when Lua Tools has exactly one game: accept the numeric AppID produced by JSON parsing the backend response.
- Use the typed Millennium backend call so the compiler supplies the plugin name.
- Remove the unnecessary override of `RunGame.toString()` so the launch wrapper remains inspectable.
- Include the compiled frontend in the repository and installation archives.
- Pin development dependencies and use `npm ci` to preserve the working compiler versions.
- Add AppID regression tests, Windows packaging, SHA-256 checksums and a GitHub validation workflow.
- Document the distinction between a missing compiled plugin and a Steam interface running without Millennium.

Validation: seven AppID regression cases passed; the frontend compiled successfully. On Windows with Millennium 3.4.1, Iron Blight launched with the helper process, and the user confirmed that the non-Steam activity appeared. Desktop shortcut launching and unusual game launchers were not revalidated for this release.

Publication check: Windows Defender quarantined an earlier compiled candidate as `Trojan:Script/Ulthar.A!ml`. After removing the unnecessary function-string override and rebuilding, a custom scan of the new frontend reported no threats with real-time protection enabled (security intelligence 1.459.133.0). This is a result for that file and scanner version, not a guarantee against future detections. The earlier candidate was not published as a release.
