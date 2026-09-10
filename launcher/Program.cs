using System.Diagnostics;

static string? ReadArgument(string[] args, string name)
{
    for (var index = 0; index < args.Length - 1; index++)
    {
        if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
        {
            return args[index + 1];
        }
    }

    return null;
}

static (bool ExactExecutable, bool InsideRoot) FindGameProcesses(string root, string? executable)
{
    var exactExecutable = false;
    var insideRoot = false;

    foreach (var process in Process.GetProcesses())
    {
        try
        {
            var path = process.MainModule?.FileName;
            if (string.IsNullOrWhiteSpace(path)) continue;

            if (!string.IsNullOrWhiteSpace(executable)
                && string.Equals(path, executable, StringComparison.OrdinalIgnoreCase))
            {
                exactExecutable = true;
            }

            if (path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                insideRoot = true;
            }
        }
        catch
        {
            // Protected and already-exited processes are expected here.
        }
        finally
        {
            process.Dispose();
        }

        if (exactExecutable && insideRoot) break;
    }

    return (exactExecutable, insideRoot);
}

static bool HasExactProcess(string executable)
{
    var processName = Path.GetFileNameWithoutExtension(executable);
    foreach (var process in Process.GetProcessesByName(processName))
    {
        try
        {
            if (string.Equals(process.MainModule?.FileName, executable, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        catch
        {
            // Protected and already-exited processes are expected here.
        }
        finally
        {
            process.Dispose();
        }
    }

    return false;
}

static void SignalState(string? token, string state)
{
    if (string.IsNullOrWhiteSpace(token) || token.Any(character => !char.IsLetterOrDigit(character) && character != '-'))
    {
        return;
    }

    try
    {
        var directory = Path.Combine(Path.GetTempPath(), "LuaToolsActivity");
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, $"{token}.{state}"), state);
    }
    catch
    {
        // The normal process exit remains the fallback if signaling fails.
    }
}

static void SignalStarted(string? token) => SignalState(token, "started");
static void SignalCompletion(string? token) => SignalState(token, "done");

static string? FindArtwork(string sourceDirectory, params string[] names)
{
    if (!Directory.Exists(sourceDirectory)) return null;

    var accepted = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
    try
    {
        return Directory.EnumerateFiles(sourceDirectory, "*", SearchOption.AllDirectories)
            .FirstOrDefault(path => accepted.Contains(Path.GetFileName(path)));
    }
    catch
    {
        return null;
    }
}

static string? FindIcon(string sourceDirectory)
{
    if (!Directory.Exists(sourceDirectory)) return null;

    try
    {
        return Directory.EnumerateFiles(sourceDirectory, "*.jpg", SearchOption.TopDirectoryOnly)
            .FirstOrDefault(path => Path.GetFileNameWithoutExtension(path).Length == 40);
    }
    catch
    {
        return null;
    }
}

static bool CopyArtwork(string source, string gridDirectory, string destinationStem)
{
    try
    {
        Directory.CreateDirectory(gridDirectory);
        var extension = Path.GetExtension(source).ToLowerInvariant();
        if (extension is not ".jpg" and not ".png") return false;

        foreach (var candidateExtension in new[] { ".jpg", ".png" })
        {
            var stalePath = Path.Combine(gridDirectory, destinationStem + candidateExtension);
            if (!string.Equals(candidateExtension, extension, StringComparison.OrdinalIgnoreCase)
                && File.Exists(stalePath))
            {
                File.Delete(stalePath);
            }
        }

        File.Copy(source, Path.Combine(gridDirectory, destinationStem + extension), true);
        return true;
    }
    catch
    {
        return false;
    }
}

static int PrepareArtwork(string steamRoot, string sourceAppId, string shortcutAppId)
{
    if (!sourceAppId.All(char.IsDigit) || !shortcutAppId.All(char.IsDigit)) return 4;

    var sourceDirectory = Path.Combine(steamRoot, "appcache", "librarycache", sourceAppId);
    var capsule = FindArtwork(sourceDirectory, "library_600x900.jpg", "library_600x900.png");
    var hero = FindArtwork(sourceDirectory, "library_hero.jpg", "library_hero.png");
    var logo = FindArtwork(sourceDirectory, "logo.png");
    var header = FindArtwork(sourceDirectory, "library_header.jpg", "header.jpg", "library_header.png", "header.png");
    var icon = FindIcon(sourceDirectory);
    var assets = new (string? Source, string Stem)[]
    {
        (capsule, shortcutAppId + "p"),
        (hero, shortcutAppId + "_hero"),
        (logo, shortcutAppId + "_logo"),
        (header, shortcutAppId),
        (icon, shortcutAppId + "_icon"),
    };

    var copied = 0;
    var userDataDirectory = Path.Combine(steamRoot, "userdata");
    if (!Directory.Exists(userDataDirectory)) return 5;

    foreach (var userDirectory in Directory.EnumerateDirectories(userDataDirectory))
    {
        if (!Path.GetFileName(userDirectory).All(char.IsDigit)) continue;
        var gridDirectory = Path.Combine(userDirectory, "config", "grid");
        foreach (var asset in assets)
        {
            if (asset.Source is not null && CopyArtwork(asset.Source, gridDirectory, asset.Stem)) copied++;
        }
    }

    return copied > 0 ? 0 : 6;
}

var prepareSourceAppId = ReadArgument(args, "--prepare-artwork");
if (!string.IsNullOrWhiteSpace(prepareSourceAppId))
{
    var steamRoot = ReadArgument(args, "--steam-root");
    var shortcutAppId = ReadArgument(args, "--shortcut-appid");
    if (string.IsNullOrWhiteSpace(steamRoot) || string.IsNullOrWhiteSpace(shortcutAppId)) return 4;
    return PrepareArtwork(Path.GetFullPath(steamRoot), prepareSourceAppId, shortcutAppId);
}

var root = ReadArgument(args, "--root");
if (string.IsNullOrWhiteSpace(root)) return 2;

root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
var executableArgument = ReadArgument(args, "--exe");
var executable = string.IsNullOrWhiteSpace(executableArgument)
    ? null
    : Path.GetFullPath(executableArgument);
var signalToken = ReadArgument(args, "--signal");
var timeoutSeconds = int.TryParse(ReadArgument(args, "--timeout"), out var parsedTimeout)
    ? Math.Clamp(parsedTimeout, 10, 180)
    : 45;

SignalStarted(signalToken);

var launchDeadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
var state = FindGameProcesses(root, executable);
while (DateTime.UtcNow < launchDeadline && !state.ExactExecutable && !state.InsideRoot)
{
    Thread.Sleep(250);
    state = FindGameProcesses(root, executable);
}

if (!state.ExactExecutable && !state.InsideRoot)
{
    SignalCompletion(signalToken);
    Thread.Sleep(3000);
    return 3;
}

var exactExecutableSeen = state.ExactExecutable;
var emptyChecks = 0;
while (emptyChecks < 4)
{
    Thread.Sleep(250);
    if (exactExecutableSeen && executable is not null)
    {
        emptyChecks = HasExactProcess(executable) ? 0 : emptyChecks + 1;
        continue;
    }

    state = FindGameProcesses(root, executable);
    exactExecutableSeen = exactExecutableSeen || state.ExactExecutable;
    var stillRunning = exactExecutableSeen ? state.ExactExecutable : state.InsideRoot;
    emptyChecks = stillRunning ? 0 : emptyChecks + 1;
}

SignalCompletion(signalToken);
Thread.Sleep(3000);
return 0;
