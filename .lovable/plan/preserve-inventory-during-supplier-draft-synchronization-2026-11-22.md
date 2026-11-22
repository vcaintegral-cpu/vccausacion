# Preserve inventory during supplier draft synchronization

## Verified findings
- **Payment totals with cents:** the cited equality check no longer exists. The current code retries with Siigo's reported payment amount when the difference is within the existing $3 limit, without changing source values. Both reported examples pass: 947,213.34 → 947,213 and 182,776.39 → 182,777. Existing rounding/readback tests pass. This finding was marked stale; no payment-code change is needed. A real Siigo posting was not performed.
- **Inventory overwritten by expense-account sync:** confirmed. The extra assignment uses the selected account to decide whether inventory is allowed, treats existing 14xx accounts as pending, and runs even for unrelated changes. Those assignments are outside the synchronization event and cannot be undone through that event.

## Scope
All companies, preserving each company's existing inventory settings. Only supplier draft synchronization changes; no extraction, invoice values, tax calculations, posting behavior, or company-specific accounting rules change.

## Requested correction
1. Derive inventory eligibility from the company's configured function, never from the newly chosen account.
2. Apply supplementary account/classification changes only when an account or classification actually changed. Tax or cost-center-only synchronization must not trigger account assignment.
3. Preserve existing valid inventory accounts and their products when syncing an expense account. Complete genuinely missing accounts and propagate explicitly requested classification only to eligible lines; do not convert unrelated lines.
4. Make all synchronization writes part of the same recorded operation, including manual decisions, item classification, product fields and associated journal changes. **Undo** restores the exact fields changed by that operation, without overwriting later edits.
5. Preserve same-company/same-provider isolation, draft-only eligibility, conflict detection, membership checks and idempotency. Leave already-approved or posted invoices untouched.

## Technical approach
- Inspect the currently installed sync/undo functions before updating them; do not assume the historical SQL is the latest definition.
- Replace the untracked post-RPC assignment in `draft-sync-dialog.tsx` with one transactional synchronization path. Keep the shared accounting engine rather than introducing separate accounting calculations.
- Use line-level before/after snapshots in the existing synchronization event for accurate undo of accounts, decisions, classification and products. Reject conflicting changes rather than partially applying them.
- Deliver any SQL changes as an idempotent migration under `drizzle/migrations`, maintaining existing grants and authorization. Verify application before relying on the new path; if unavailable, block the supplementary changes with a clear message rather than invoking the unsafe fallback.
- No automatic repair of previously overwritten invoices: their intended accounts cannot safely be inferred.

## Verification
- Regression tests: mixed inventory/expense drafts, genuine missing accounts, explicit classification changes, tax-only and cost-center-only changes, inventory feature on/off, manual decision preservation, duplicate events and concurrent edits.
- Database integration tests: apply → read back → undo → read back restores account, classification, product, manual decision and journal fields; other companies/providers and approved/posted invoices stay unchanged.
- Verify the dialog's apply and undo flow with an authenticated account and controlled test drafts; do not send documents to Siigo.
- Check preview errors and resolve the inventory finding as fixed only after the regression and flow checks pass.

## Why approval is needed
A small eligibility patch alone would stop some overwrites but leave untracked changes that Undo cannot restore. The complete correction changes the saved synchronization and undo operation, so it requires a coordinated application/database update.