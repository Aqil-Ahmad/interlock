# ADR-0002: AGPL-3.0 with a commercial exception

- **Status:** accepted
- **Date:** 2026-08-04

## Context

Interlock is a commercial product. It is also developer tooling that people will
want to read, audit and self-host, and it carries ideas that are cheap to copy
once described — speculative merge scheduling, cross-branch semantic matching.

Those two facts pull in opposite directions. Source-available buys trust,
contribution and adoption in a market where developers install a background
daemon that watches their repositories; a permissive license hands a funded
competitor a finished product.

Interlock runs locally today, but the plan already anticipates a team/server mode
(the plan lists it as a v1 non-goal, not a never). Whatever license
is chosen now applies to code written long before that mode exists, and cannot be
retracted from anything already published.

## Decision

Dual license:

- **AGPL-3.0-only** by default, full text in `LICENSE_AGPL`.
- **A commercial license** sold to organisations that cannot accept AGPL terms.

`LICENSE.md` is the router: an SPDX header, a REUSE snippet region, or an
`ee/` path marks code as commercial; everything else is AGPL.

Both packages' `license` fields carry the SPDX identifier `AGPL-3.0-only`.
`AGPL-3.0` on its own is deprecated in the SPDX list and ambiguous about the
"or later" clause; being explicit keeps automated license scanners — the tools
enterprise buyers run before approving an install — from flagging it.

## Consequences

**Easier:** the source stays readable and auditable, which matters
disproportionately for software that watches a company's private repositories.
Section 13 closes the network loophole, so a vendor cannot run a modified
Interlock as a hosted service without publishing their changes — the specific
outcome a permissive license cannot prevent. Selling exceptions is a revenue
line, not just a defensive measure.

**Harder:** some enterprises refuse AGPL outright at the procurement stage,
regardless of how the software is used. That is the intended pressure toward the
commercial license, but it does cost adoption, and it makes the commercial terms
a thing that must actually exist rather than a footnote.

**Committed to:** owning the copyright in everything shipped. Selling exceptions
requires holding the rights to relicense, so **every outside contributor must
sign a CLA or assign copyright before their first merge.** Without that, a single
un-assigned contribution makes the commercial half unsellable. This is cheap to
set up now and effectively unfixable later.

There is no registered company yet, so the CLA names a natural person as the
Entity. A GitHub organisation is not a legal person and cannot hold the granted
rights, so naming one would make every signature collected against it worthless.
`CLA.md` §8 carries an assignment clause instead: the rights transfer to the
company on incorporation, with no need to re-collect signatures. Swapping the
Entity is therefore a follow-up, not a blocker.

Also committed to: AGPL applies to Interlock's own source. It says nothing about
the repositories Interlock analyses — worth stating plainly in the README, since
a tool that reads your code and is licensed AGPL invites exactly that question.

## Alternatives considered

- **Apache-2.0** (the previous proposal) — maximum adoption and frictionless
  procurement, with an explicit patent grant. Rejected: a competitor can fork it
  and sell a hosted version owing nothing back. For a company rather than a
  research project, that is the whole ballgame.
- **Business Source License 1.1** — blocks hosted competitors for a fixed term,
  then converts to Apache. Rejected: not OSI-approved, which trips enterprise
  legal review, and the conversion date is a cliff to plan around. AGPL gets
  similar protection with a license buyers' tooling already recognises.
- **MIT** — no patent grant and no copyleft. Strictly worse here than Apache-2.0.
- **Proprietary / closed** — forfeits the trust and audit benefits that make a
  repo-watching daemon installable in the first place.

## Follow-ups

- [x] Add `LICENSE_AGPL` and the `LICENSE.md` router.
- [x] Set `license` to `AGPL-3.0-only` in every manifest.
- [x] Add `CLA.md` and enforce it in `.github/workflows/cla.yml`.
- [x] Fill the legal entity and contact blanks in `CLA.md` and `LICENSE.md`; have both reviewed.
- [x] Store CLA signatures on the `cla-signatures` branch of this repository — no separate repo or PAT.
- [ ] On incorporation: assign the rights under `CLA.md` §8 and update the Entity in `CLA.md` and `LICENSE.md`.
- [ ] Draft the commercial license terms before the first external user.
- [ ] Search the "Interlock" name for existing marks before investing in branding.
