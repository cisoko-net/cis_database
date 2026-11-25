-- Admin dashboard, client side: /cis_db asks the server (which checks the ACE)
-- and then shows the NUI page in web/dist with the snapshots it is sent.
local open = false
local watching = false
local watchKeys

local function close()
    SetNuiFocus(false, false)
    if not open then return end
    open = false
    SendNUIMessage({ action = 'close' })
    TriggerServerEvent('cis_database:dashClose')
end

RegisterNetEvent('cis_database:dashOpen', function(snap)
    open = true
    SetNuiFocus(true, true)
    SendNUIMessage({ action = 'open', data = snap })
    watchKeys()
end)

RegisterNetEvent('cis_database:dashTick', function(snap)
    if not open then return end
    SendNUIMessage({ action = 'tick', data = snap })
end)

-- reason is 'ace' when the player lacks the ACE (or lost it while the panel
-- was open) and 'stop' when the resource stops. Only 'ace' is the player's to
-- fix, so only 'ace' tells them which ACE: in chat and in F8.
local deniedLine = 'no permission: needs ace cis_database.dashboard'

RegisterNetEvent('cis_database:dashDenied', function(reason)
    if open then SendNUIMessage({ action = 'close' }) end
    open = false
    SetNuiFocus(false, false)
    if reason == 'ace' then
        TriggerEvent('chat:addMessage', { color = { 255, 107, 107 }, args = { 'cis_database', deniedLine } })
        print('cis_database: ' .. deniedLine)
    end
end)

RegisterNUICallback('close', function(_, cb)
    close()
    cb({ ok = true })
end)

RegisterCommand('cis_db', function()
    if open then
        close()
        return
    end
    TriggerServerEvent('cis_database:dashOpen')
end, false)

-- Escape (200) and Pause (322) close the panel. The thread that watches them
-- runs only while the panel is open, so players who never open it run none.
watchKeys = function()
    if watching then return end
    watching = true
    CreateThread(function()
        while open do
            if IsControlJustReleased(0, 322) or IsControlJustReleased(0, 200) then
                close()
                break
            end
            Wait(0)
        end
        watching = false
    end)
end
