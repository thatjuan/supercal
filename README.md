# Supercal

Supercal is a containerised, multitenant daemon. It aggregates many calendar accounts (Google, Microsoft 365, iCloud, any CalDAV server, ICS links) into one feed that any major calendar client can subscribe to. It also hosts calendars whose events live in Supercal, using the same feed and publication pipeline. You choose which calendars are published, merge several into virtual calendars, and set a privacy level per calendar. Everything is managed through a versioned OpenAPI API, and the web dashboard is built on that same API.

- `docs/product.md`: what it does and for whom
- `docs/architecture.md`: how it is built (decided, with evidence)
- `docs/brief.md`: the pre-spike hypotheses
- `spikes/`: the derisking spikes behind the architecture (`feed`, `ingest`, `platform`), each with a `FINDINGS.md`

Work is tracked as GitHub issues under milestones 1–8.
