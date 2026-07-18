# Device Access Test Plan

## Goal

Verify that each device only sees lists it created or joined by invite code, while all joined devices edit the same underlying list data.

## Setup

- Device A: normal browser session.
- Device B: another phone, another browser, or incognito/private mode.
- Production URL: `https://cp-list-helper.icebearh.workers.dev/`.
- Supabase migration `003_add_event_access.sql` has been run.

## Cases

1. A creates a list.
   - Expected: A homepage shows the new list.
   - Expected: list detail page can generate/copy invite code.

2. B opens homepage without invite code.
   - Expected: B does not see A's list.

3. B opens A's detail URL directly without invite code.
   - Expected: B sees an access-denied message and can return to homepage.

4. B enters A's invite code.
   - Expected: B enters A's list detail page.
   - Expected: B homepage shows this joined list after refresh.

5. Shared list edits are synchronized.
   - Action: A changes one item's status/price/note.
   - Expected: B refreshes and sees the same change.
   - Action: B changes one item's status/price/note.
   - Expected: A refreshes and sees the same change.

6. B removes a joined list.
   - Action: B deletes the joined list card from homepage.
   - Expected: B homepage no longer shows the list.
   - Expected: A homepage still shows the list.
   - Expected: A detail page still has all wish items.

7. B rejoins after removing.
   - Action: B enters the same invite code again.
   - Expected: B can see the list again.

8. A deletes an owned list.
   - Action: A deletes the list card.
   - Expected: A homepage no longer shows the list.
   - Expected: B cannot access the old detail URL.
   - Expected: the old invite code no longer resolves.

9. Duplicate invite entry.
   - Action: B enters the same invite code multiple times.
   - Expected: only one `event_access` row exists for B and the list.
   - Expected: B homepage shows one list card.
