# Common Patterns

**Skeleton projects:** Search battle-tested skeletons before implementing from scratch. Clone best match as foundation.

**Repository pattern:** Encapsulate data access behind standard interface (findAll/findById/create/update/delete). Business logic depends on abstract interface, not storage mechanism.

**API response envelope:** `{ success, data, error, meta }` — status indicator + nullable payload + nullable error + pagination meta.
