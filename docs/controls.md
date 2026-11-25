---
title: Watching and taking control
---

# Watching and taking control

Pair with the URL and secret printed by your bot. Watching doesn't take control away from the script. To allow an operator to intervene, set `bot.client.intervention.permitted = true` when binding that bot session. Leave it unset for a read-only run.

Choose **Intervene** to take control. The script parks at its next `wait_tick` or `wait_ticks`, so a long-running script has to reach those calls to hand off cleanly.

| Action | Keyboard | Touch |
| --- | --- | --- |
| Move | W, A, S, D | Left stick |
| Look | Mouse, or H/L for yaw and J/K for pitch | Swipe the look area |
| Jump | Space | Jump |
| Sprint | Left Ctrl, R, or Q | Sprint |
| Sneak | Shift | Sneak |
| Attack | U | Attack |
| Use | I | Use |

The touch controls appear during manual play. Use the **Inventory** and **Chat** buttons to open their panels; **Pause** opens the control menu.

**Resume play** keeps the operator in control. **Resume script** hands the same bot connection back to the parked script. **Restart script from top**, when available for a `Bot.run` script, starts another run on a fresh connection. Choose resume if you want the script to continue where it stopped.

In inventory, a pending click has not finished dispatching. When that indicator clears, it does not mean the server confirmed the click: Minecraft can accept a prediction without sending a reply. Check the cursor and inventory before handing back. If control is lost with an unresolved inventory action, the parked script can receive `Rosegold::ManualControl::Cancelled`. Check `unresolved_inventory?` and reconcile the inventory rather than repeating the click blindly.
