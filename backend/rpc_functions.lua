local fs = require("fs")
local logger = require("logger")
local millennium = require("millennium")

local function normalize_appid(value)
    local text = tostring(value or "")

    if not text:match("^%d+$") then
        return nil
    end

    return text
end

local function path_exists(path)
    local ok, exists = pcall(fs.exists, path)
    if ok then
        return exists == true
    end

    return false
end

local function lua_tools_file(appid)
    local normalized = normalize_appid(appid)
    if not normalized then
        return nil
    end

    return millennium.steam_path() .. "\\config\\stplug-in\\" .. normalized .. ".lua"
end

local function requested_appid(params)
    if type(params) == "table" then
        return params.appid or params.appId or params[1]
    end

    return params
end

local function read_text(path)
    local file = io and io.open and io.open(path, "rb")
    if not file then
        return nil
    end

    local content = file:read("*a")
    file:close()
    return content
end

local function current_plugin_directory()
    if not debug or not debug.getinfo then
        return nil
    end

    local ok, info = pcall(debug.getinfo, 1, "S")
    local source = ok and info and tostring(info.source or "") or ""
    source = source:gsub("^@", ""):gsub("/", "\\")
    return source:match("^(.*)\\backend\\[^\\]+$")
end

local function helper_paths()
    local plugin_directory = current_plugin_directory()
    if plugin_directory then
        local helper_directory = plugin_directory .. "\\launcher"
        local helper_executable = helper_directory .. "\\LuaStatusMonitor.exe"
        if path_exists(helper_executable) then
            return helper_directory, helper_executable
        end
    end

    -- Fallback for runtimes that hide Lua debug information. Find this plugin
    -- by its manifest instead of assuming the installation folder name.
    local plugins_directory = millennium.steam_path() .. "\\millennium\\plugins"
    for _, entry in ipairs(fs.list(plugins_directory) or {}) do
        if not entry.is_file then
            local directory = entry.path or (plugins_directory .. "\\" .. tostring(entry.name or ""))
            local manifest = read_text(directory .. "\\plugin.json") or ""
            if manifest:match('"name"%s*:%s*"lua_tools_activity"') then
                local helper_directory = directory .. "\\launcher"
                local helper_executable = helper_directory .. "\\LuaStatusMonitor.exe"
                if path_exists(helper_executable) then
                    return helper_directory, helper_executable
                end
            end
        end
    end

    return nil, nil
end

local function official_artwork(appid)
    local directory = millennium.steam_path() .. "\\appcache\\librarycache\\" .. tostring(appid)
    local entries = fs.list_recursive(directory) or {}
    local artwork = {}

    for _, entry in ipairs(entries) do
        if entry.is_file then
            local name = tostring(entry.name or ""):lower()
            if name == "library_600x900.jpg" or name == "library_600x900.png" then
                artwork.capsule = entry.path
            elseif name == "library_hero.jpg" or name == "library_hero.png" then
                artwork.hero = entry.path
            elseif name == "logo.png" then
                artwork.logo = entry.path
            elseif name == "library_header.jpg" or name == "library_header.png"
                or ((name == "header.jpg" or name == "header.png") and not artwork.header) then
                artwork.header = entry.path
            elseif name:match("^[0-9a-f]+%.jpg$") and #name == 44 and not artwork.icon then
                artwork.icon = entry.path
            end
        end
    end

    return artwork
end

local base64_alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

local function base64_encode(content)
    local encoded = {}
    local output_index = 1

    for index = 1, #content, 3 do
        local first = content:byte(index) or 0
        local second = content:byte(index + 1) or 0
        local third = content:byte(index + 2) or 0
        local value = first * 65536 + second * 256 + third

        encoded[output_index] = base64_alphabet:sub(math.floor(value / 262144) % 64 + 1, math.floor(value / 262144) % 64 + 1)
        encoded[output_index + 1] = base64_alphabet:sub(math.floor(value / 4096) % 64 + 1, math.floor(value / 4096) % 64 + 1)
        encoded[output_index + 2] = index + 1 <= #content
            and base64_alphabet:sub(math.floor(value / 64) % 64 + 1, math.floor(value / 64) % 64 + 1)
            or "="
        encoded[output_index + 3] = index + 2 <= #content
            and base64_alphabet:sub(value % 64 + 1, value % 64 + 1)
            or "="
        output_index = output_index + 4
    end

    return table.concat(encoded)
end

local function requested_artwork(params)
    local appid = normalize_appid(type(params) == "table" and (params.appid or params.appId) or nil)
    local asset_type = tonumber(type(params) == "table" and (params.asset_type or params.assetType) or nil)
    if not appid or asset_type == nil then
        return nil
    end

    local keys = { [0] = "capsule", [1] = "hero", [2] = "logo", [3] = "header", [4] = "icon" }
    return official_artwork(appid)[keys[asset_type]]
end

local function copy_artwork_asset(source, grid_directory, destination_stem)
    if not source then
        return false
    end

    local extension = tostring(fs.extension(source) or ""):lower()
    if extension ~= ".jpg" and extension ~= ".png" then
        return false
    end

    for _, candidate_extension in ipairs({ ".jpg", ".png" }) do
        if candidate_extension ~= extension then
            local stale_path = grid_directory .. "\\" .. destination_stem .. candidate_extension
            if path_exists(stale_path) then
                fs.remove(stale_path)
            end
        end
    end

    local ok, error_message = fs.copy(source, grid_directory .. "\\" .. destination_stem .. extension, false)
    if not ok then
        logger:warn("Lua Tools Activity: falha ao copiar arte: " .. tostring(error_message))
        return false
    end
    return true
end

local function library_paths()
    local steam_root = millennium.steam_path()
    local paths = { steam_root }
    local content = read_text(steam_root .. "\\steamapps\\libraryfolders.vdf") or ""

    for path in content:gmatch('"path"%s+"([^"]+)"') do
        path = path:gsub("\\\\", "\\")
        table.insert(paths, path)
    end

    return paths
end

local function game_installation(appid)
    local normalized = normalize_appid(appid)
    if not normalized then
        return nil
    end

    for _, library in ipairs(library_paths()) do
        local manifest = library .. "\\steamapps\\appmanifest_" .. normalized .. ".acf"
        local content = read_text(manifest)
        if content then
            local install_dir = content:match('"installdir"%s+"([^"]+)"')
            local app_name = content:match('"name"%s+"([^"]+)"') or ("Steam App " .. normalized)
            if install_dir then
                return library .. "\\steamapps\\common\\" .. install_dir, app_name
            end
        end
    end

    return nil
end

local function find_game_executable(appid)
    local install_dir, app_name = game_installation(appid)
    if not install_dir then
        return nil
    end

    return {
        appid = tonumber(normalize_appid(appid)),
        name = app_name,
        -- An empty executable makes the helper monitor every process launched
        -- from the game's installation directory. This avoids the native
        -- recursive directory scan, which can throw a C++ exception.
        executable = "",
        directory = install_dir
    }
end

local function uint32_little_endian(value)
    local number = tonumber(value)
    if not number or number < 0 or number > 4294967295 then
        return nil
    end

    local b1 = number % 256
    number = math.floor(number / 256)
    local b2 = number % 256
    number = math.floor(number / 256)
    local b3 = number % 256
    number = math.floor(number / 256)
    local b4 = number % 256
    return string.char(b1, b2, b3, b4)
end

local function shortcut_exists(shortcut_appid)
    local encoded = uint32_little_endian(shortcut_appid)
    if not encoded then
        return false
    end

    local userdata = millennium.steam_path() .. "\\userdata"
    local users = fs.list(userdata) or {}
    local marker = string.char(2) .. "appid" .. string.char(0) .. encoded

    for _, user in ipairs(users) do
        if not user.is_file and tostring(user.name or ""):match("^%d+$") then
            local content = read_text(userdata .. "\\" .. user.name .. "\\config\\shortcuts.vdf")
            if content and content:find(marker, 1, true) then
                return true
            end
        end
    end

    return false
end

---@ffi
---@param params table
---@return boolean
function has_lua_tools_app(params)
    local appid = requested_appid(params)

    local path = lua_tools_file(appid)
    local exists = path ~= nil and path_exists(path) or false

    logger:info("Lua Tools Activity: AppID " .. tostring(appid) .. " exists=" .. tostring(exists))

    return exists
end

---@ffi
---@return string
function get_lua_tools_appids()
    local directory = millennium.steam_path() .. "\\config\\stplug-in"
    local entries, error_message = fs.list(directory)

    if not entries then
        logger:error("Lua Tools Activity: não foi possível listar " .. directory .. ": " .. tostring(error_message))
        return ""
    end

    local appids = {}
    for _, entry in ipairs(entries) do
        local appid = tostring(entry.name or ""):match("^(%d+)%.lua$")
        if appid then
            table.insert(appids, appid)
        end
    end

    table.sort(appids)
    logger:info("Lua Tools Activity: " .. tostring(#appids) .. " AppIDs encontrados")
    return table.concat(appids, ",")
end

---@ffi
---@param params table
---@return string
function get_lua_tools_executable(params)
    local launcher = find_game_executable(requested_appid(params))
    if not launcher then
        logger:error("Lua Tools Activity: executável não encontrado para AppID " .. tostring(requested_appid(params)))
        return ""
    end

    logger:info("Lua Tools Activity: executável encontrado em " .. launcher.executable)
    local helper_directory, helper_executable = helper_paths()
    if not helper_executable then
        logger:error("Lua Tools Activity: monitor incluído no plugin não foi encontrado")
        return ""
    end

    return table.concat({
        tostring(launcher.appid),
        launcher.name,
        launcher.executable,
        launcher.directory,
        helper_executable,
        helper_directory
    }, "\t")
end

---@ffi
---@param params table
---@return boolean
function has_steam_shortcut(params)
    local appid = type(params) == "table" and (params.appid or params.appId) or params
    return shortcut_exists(appid)
end

local function consume_monitor_signal(params, suffix)
    local token = type(params) == "table" and params.token or params
    token = tostring(token or "")
    if not token:match("^[%w%-]+$") then
        return false
    end

    local temp = os and os.getenv and os.getenv("TEMP") or nil
    if not temp or temp == "" then
        return false
    end

    local signal = temp .. "\\LuaToolsActivity\\" .. token .. "." .. suffix
    if not path_exists(signal) then
        return false
    end

    pcall(os.remove, signal)
    return true
end

---@ffi
---@param params table
---@return boolean
function monitor_started(params)
    return consume_monitor_signal(params, "started")
end

---@ffi
---@param params table
---@return boolean
function monitor_finished(params)
    local finished = consume_monitor_signal(params, "done")
    if finished then
        local token = type(params) == "table" and params.token or params
        token = tostring(token or "")
        local temp = os and os.getenv and os.getenv("TEMP") or nil
        if temp and temp ~= "" and token:match("^[%w%-]+$") then
            pcall(os.remove, temp .. "\\LuaToolsActivity\\" .. token .. ".started")
        end
    end
    return finished
end

---@ffi
---@param params table
---@return boolean
function prepare_lua_tools_artwork(params)
    local appid = normalize_appid(type(params) == "table" and (params.appid or params.appId) or nil)
    local shortcut_appid = normalize_appid(type(params) == "table" and (params.shortcut_appid or params.shortcutAppId) or nil)
    if not appid or not shortcut_appid then
        return false
    end

    local steam_root = millennium.steam_path()
    local artwork = official_artwork(appid)
    local assets = {
        { artwork.capsule, shortcut_appid .. "p" },
        { artwork.hero, shortcut_appid .. "_hero" },
        { artwork.logo, shortcut_appid .. "_logo" },
        { artwork.header, shortcut_appid },
        { artwork.icon, shortcut_appid .. "_icon" }
    }
    local users = fs.list(steam_root .. "\\userdata") or {}
    local copied = 0

    for _, user in ipairs(users) do
        if user.is_directory and tostring(user.name or ""):match("^%d+$") then
            local grid_directory = user.path .. "\\config\\grid"
            local created, create_error = fs.create_directories(grid_directory)
            if created or path_exists(grid_directory) then
                for _, asset in ipairs(assets) do
                    if copy_artwork_asset(asset[1], grid_directory, asset[2]) then
                        copied = copied + 1
                    end
                end
            else
                logger:warn("Lua Tools Activity: pasta de artes indisponível: " .. tostring(create_error))
            end
        end
    end

    logger:info("Lua Tools Activity: " .. tostring(copied) .. " artes copiadas para AppID " .. appid)
    return copied > 0
end

---@ffi
---@param params table
---@return string
function get_lua_tools_artwork_info(params)
    local source = requested_artwork(params)
    if not source then
        return ""
    end

    local size = fs.file_size(source)
    if not size then
        return ""
    end

    local image_type = tostring(fs.extension(source) or ""):lower() == ".png" and "png" or "jpg"
    return image_type .. "\t" .. tostring(size)
end

---@ffi
---@param params table
---@return string
function get_lua_tools_artwork_chunk(params)
    local source = requested_artwork(params)
    local offset = math.max(0, math.floor(tonumber(type(params) == "table" and params.offset or 0) or 0))
    local length = math.min(24576, math.max(1, math.floor(tonumber(type(params) == "table" and params.length or 24576) or 24576)))
    if not source then
        return ""
    end

    local input = io and io.open and io.open(source, "rb")
    if not input then
        return ""
    end
    input:seek("set", offset)
    local content = input:read(length) or ""
    input:close()
    return base64_encode(content)
end

logger:info("Lua Tools Activity RPC registrado")
