# B1-1 Decision Note 0001: Failed Turn response requirement

- **Version:** 1
- **Status:** Accepted for B1-1 implementation
- **Date:** 2026-11-03
- **Authority:** CTO A1 execution decision recorded in [PR #97](https://github.com/basicv8vc/Ember/pull/97#issuecomment-6604932178)

## Decision

Both `completed` and `failed` assistant Turns must have a non-null `response_message_id`. The existing composite foreign key continues to require that response to be an `ember` message in the same tenant and conversation, and the existing unique constraint continues to limit a response message to one Turn. Failed Turns retain the existing `timeout` and `internal_error` failure reasons.

`running` Turns still cannot have a response. `cancelled` Turns may have no response when cancellation happens before one is produced.

## Scope

This note records the implementation correction in migration `0012_conversation.sql` and its real PostgreSQL 17 tests. The accepted ADR-0004 annex remains unchanged; this note does not revise its frozen blob.
