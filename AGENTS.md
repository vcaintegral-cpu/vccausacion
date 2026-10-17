<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- RECIBIDOS purchases use a pure workbook parser and an adapter into the shared PDF draft-accounting function, with one persisted task per document, so extraction remains AI-free without duplicating accounting logic.
- Purchase confirmation recomputes rules with user-scoped reads, then calls an atomic service-only SQL transaction after membership checks, to prevent client journal tampering and partial writes.
- PDF and RECIBIDOS purchases use the same Siigo posting function and payload mapping, with shared expense/source/duplicate/readback gates; Contai exports continue to use stored journal rows to avoid divergent accounting.
- The shared account engine validates expense groups at every assignment boundary and journal construction; approval is additionally guarded in PostgreSQL to prevent bypasses.
- Bulk imports preload company purchase knowledge under user-scoped RLS, retain per-line provenance in raw extraction metadata, and persist bounded groups before marking items complete to avoid per-line network calls.
- Rejected dynamic-module imports require an explicit document reload in the root error boundary; router invalidation cannot clear the browser's rejected module cache.
- Source snapshots store integer cents, database monetary columns store currency units, and all comparisons convert at the boundary; source-backed approval and exports validate the stored journal without changing invoice amounts.
- Account selectors share a catalog-identity hierarchy index and filter the full catalog before bounding rendered results, avoiding repeated full accounting evaluations and oversized menus on the main thread.
- Source-declared IVA rates resolve only an unambiguous active tax record and persist its exact ID without recalculating amounts; bounded, labeled document adjustments are classified separately from purchase expenses.
- Siigo preflight forecasts taxes from serialized item precision and the live company tax catalog; readback reconstructs gross purchase totals from Siigo net totals plus actual retentions, without altering source values or resending existing identities.
- Siigo error recovery state (error kind, attempts, request/response trace, voided consecutives) is persisted on the invoice and remote-identity rows are never resent or deleted (DB trigger), so recovery actions survive sessions and cannot duplicate Siigo documents.
