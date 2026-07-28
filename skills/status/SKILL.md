---
description: Show portal connections status — connected Zuar Portal instances, session version group, active default portal
disable-model-invocation: true
---

# Portal connections status

Call the `list_portals` tool with `scope: "all"` and present two
compact sections: first the session — bound version group, default
portal, and the portals usable right now; then the rest of the
registry (other version groups), so the user sees both without
eyeballing flags in one long mixed table. If the session is unbound,
say so and explain that the first `use_portal` call will bind the
session to that portal's version group.
