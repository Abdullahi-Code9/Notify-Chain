# Architecture Decision Records (ADR)

This directory contains Architecture Decision Records for NotifyChain. An ADR documents a significant architectural or technical decision, the context that led to it, the options considered, and the reasoning behind the chosen approach.

## Why ADRs?

ADRs give future contributors the *why* behind design choices, not just the *what*. When you read code and wonder "why was it built this way?", the relevant ADR should answer that question.

## How to Use This Directory

- **Reading an ADR**: Each record is self-contained. Start with the status and context, then read the decision and consequences.
- **Writing a new ADR**: Copy [`0000-template.md`](0000-template.md), increment the number, fill in all sections, and open a PR.
- **Superseding an ADR**: Mark the old ADR status as `Superseded by ADR-XXXX` and reference the new one.

## ADR Lifecycle

| Status | Meaning |
|--------|---------|
| `Proposed` | Under discussion — not yet accepted |
| `Accepted` | Agreed upon and actively guiding the project |
| `Superseded` | Replaced by a newer decision (link provided) |
| `Deprecated` | No longer relevant but kept for historical record |
| `Rejected` | Considered and explicitly declined |

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-0001](0001-off-chain-listener-architecture.md) | Off-Chain Listener Architecture | Accepted |
| [ADR-0002](0002-soroban-smart-contracts.md) | Soroban Smart Contracts on Stellar | Accepted |
| [ADR-0003](0003-sqlite-for-local-persistence.md) | SQLite for Local Notification Persistence | Accepted |
| [ADR-0004](0004-typescript-for-listener-service.md) | TypeScript for Listener Service | Accepted |
| [ADR-0005](0005-event-deduplication-strategy.md) | Event Deduplication Strategy | Accepted |
| [ADR-0006](0006-rate-limiting-architecture.md) | Rate Limiting for API and RPC Requests | Accepted |
| [ADR-0007](0007-event-processing-architecture.md) | Event Processing Pipeline Architecture | Accepted |
| [ADR-0008](0008-notification-delivery-architecture.md) | Notification Delivery Architecture | Accepted |
| [ADR-0009](0009-database-persistence-architecture.md) | Database and Persistence Architecture | Accepted |

---

## Contributor Guide

### When to Write an ADR

Write an ADR when you're making a significant architectural decision that:

- Changes the fundamental structure of the system
- Introduces a new technology or major dependency
- Alters data flow or communication patterns
- Affects scalability, reliability, or security
- Would benefit future contributors to understand the reasoning

**Do NOT write an ADR for**:
- Routine bug fixes
- Minor feature additions
- Code refactoring that doesn't change architecture
- Configuration changes
- Documentation updates

### How to Write an ADR

1. **Copy the template**: Start from [`0000-use-adr-template.md`](0000-use-adr-template.md)
2. **Choose a number**: Use the next sequential number (check the index)
3. **Fill in all sections**:
   - **Status**: Start with `Proposed`, change to `Accepted` after review
   - **Context**: Clearly explain the problem and constraints
   - **Decision**: Describe what was decided and why
   - **Consequences**: List positive, negative, and risks
   - **Alternatives**: Document options considered and why they were rejected
   - **Implementation**: Reference code, configuration, or documentation
   - **References**: Link to related docs, issues, or PRs
4. **Update the index**: Add your ADR to the index in this README
5. **Open a PR**: Tag maintainers for review

### ADR Review Process

- **Proposed**: ADR is under discussion. Gather feedback from team.
- **Accepted**: ADR is approved and guides the project. Update status.
- **Superseded**: ADR is replaced by a newer decision. Mark old ADR with `Superseded by ADR-XXXX`.
- **Deprecated**: ADR is no longer relevant but kept for history.
- **Rejected**: ADR was considered and declined. Document why.

### Best Practices

- **Be specific**: Use concrete examples and code references
- **Focus on why**: Explain the reasoning, not just the decision
- **Consider alternatives**: Thoroughly document options you didn't choose
- **Keep it current**: Update ADRs if the architecture evolves
- **Link to code**: Reference actual implementation files and line numbers
- **Include diagrams**: Use ASCII art or Mermaid for complex architectures

### Example ADR Topics

- Choosing a database technology (SQLite vs PostgreSQL)
- Implementing rate limiting strategy
- Event deduplication approach
- Notification delivery architecture
- Authentication and authorization patterns
- Caching strategy
- Error handling patterns
- Monitoring and observability approach

---

New ADRs should be numbered sequentially. When in doubt, open a GitHub Discussion or tag a maintainer before writing a full ADR.
