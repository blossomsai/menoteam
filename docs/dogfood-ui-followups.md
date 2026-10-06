# UI follow-ups reserved for Menoteam dogfood

Both changes have been implemented through the live Menoteam workflow and integrated: Work list search from `1e45dc3` is included in `b2738cd`, and Instructions/session-recovery changes are included in `6806dd6` (see the acceptance ledger for exact commits and evidence). The original reproduction and acceptance criteria below remain the browser checklist; browser acceptance is still pending. Do not mark either follow-up accepted from a code-only change: review the integrated behavior in the browser and record the result.

## Work list text search

**Repro:** Open a project, choose **Work**, and add enough Works that their titles are not all visible at once. There is no text search control; the status tabs are the only narrowing controls. Finding a specific Work requires scanning the list.

**Acceptance:** Add an accessible search field that matches Work title and overview case-insensitively. Search composes with the existing All / In progress / Paused / Done filters. Preserve the selected status while the query changes; show a useful empty state when no Work matches. Verify direct Work links still open the correctly scoped Work and test the search in the browser with several Works.

## Preserve unsaved Instructions during remote updates

**Repro:** Open Project settings → Instructions, choose **Edit**, and type a change without saving. While the editor remains open, update and save the same project Instructions from another session or a permitted Master settings change. The app refreshes the project snapshot every two seconds; when the server value changes, the current editor synchronizes its local draft from that prop and can silently replace the unsaved text.

**Acceptance:** Keep a dirty local draft intact when a newer server revision arrives. Make the remote change visible and offer a deliberate resolution such as reload remote or keep editing; never silently overwrite either side. Verify local save, remote update while dirty, cancel, and concurrent-save behavior in the browser.
