local logger = require("logger")
local millennium = require("millennium")

-- Millennium registers backend RPCs from this module.
require("rpc_functions")

local function on_load()
    logger:info("Lua Tools Activity backend carregado")
    millennium.ready()
end

return {
    on_load = on_load
}
