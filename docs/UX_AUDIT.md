# UX/UI audit — path to sale-ready

Compiled 2026-07-11 after a hands-on pass through every screen (desktop) during
the Teams launch work. Grouped by priority: P0 blocks the "ready to sell"
impression, P1 is consistency (the design-system pass), P2 is polish.

## P0 — first impression and trust

1. **Login page is from a different product.** Gradient welcome panel, ALL-CAPS
   "USER LOGIN", and the copy promises only "Telegram, Slack and WhatsApp" (no
   Teams, no Gmail). Rebuild it in the app's current language: Figtree, accent
   palette, updated product line. `apps/web/src/app/(auth)/login`.
2. **Every browser tab says just "Messengly".** Add per-route titles via Next
   metadata ("Chats · Messengly", "Broadcasts · Messengly", …) and check the
   favicon set (SVG + PNG fallbacks, dark-scheme variant).
3. **Mobile is undefined.** The Chats table squeezes horizontally, the sidebar
   collapses into a separate bottom "More" sheet that duplicates navigation, the
   broadcast wizard grid overflows. Decide and implement the mobile behaviour
   for the 5 core pages (Chats → cards, Broadcasts → already cards, wizard →
   single column, tables → scroll containers).
4. **Raw errors leak to users.** Adapter/internal messages surface verbatim in
   toasts and errorReason fields ("Adapter connection failed: TypeError: …").
   Map known failures to human sentences; keep the technical detail behind a
   "details" expander in the broadcast log.
5. **Live updates die silently in long-lived tabs** (WS reconnects with an
   expired JWT — see STABILITY_BACKLOG #4). The broadcast detail page now polls
   while sending, but the list page and dashboard stay frozen until reload.

## P1 — the consistency pass (design system)

6. **Container widths differ per page**: Chats is full-width, Broadcasts is a
   narrow column, Templates/Tags/Activity are max-w-4xl, Dashboard max-w-5xl.
   Pick a rule (suggest: data tables full-width, list/detail pages max-w-4xl)
   and apply it everywhere.
7. **Buttons are hand-rolled per page** — mixed `rounded` vs `rounded-lg`,
   px-3/px-4, `border-[1.5px]` vs none, shadow-accent-sm sometimes. Extract a
   `<Button>` (primary / secondary / danger / ghost; sm / md) and sweep the app.
8. **Status badges/chips have per-page styles** (integration status, chat
   status, broadcast status, platform "Always Available"). One `<StatusBadge>`
   with a fixed color map.
9. **Three kinds of empty state** (the `EmptyState` component, hand-made
   centered blocks, spinner-only). Use `EmptyState` everywhere with one icon
   style and a single CTA pattern.
10. **Loading states**: Templates/Broadcasts show skeletons, Tags/Chats show a
    spinner. Standardize on skeletons for lists/tables.
11. **Date formats are mixed**: `10.07.2026` (Chats), `Jul 10, 2026`
    (Templates/Integrations), `11 Jul, 01:04` (Broadcasts), relative "2h ago"
    elsewhere. One `formatDate`/`formatDateTime` util; relative time only in
    Activity.
12. **Modals are copy-pasted** (import wizard, tag editor, settings, delete
    confirms) with different paddings, radii and close behaviours. Extract
    `<Modal>`; uniform ESC/overlay-click/focus-trap.
13. **Toast copy varies in voice** ("Success", "Tag \"X\" created", raw error
    strings). Style rule: verb-first result, no exclamation marks, errors say
    what happened and what to do next.
14. **Icon and avatar sizes drift** (44/48px cards, 3.5/4 icons in the same
    row). Normalize per component size.

## P2 — polish to top-tier

15. **Keyboard and screen-reader pass**: icon-only buttons (row actions "…",
    modal close ✕) need aria-labels; wizard steps aren't reachable by keyboard;
    verify focus rings survived the custom styles.
16. **Contrast**: `text-slate-400` on white for meta text fails WCAG AA at
    small sizes in several places; bump meta text to slate-500.
17. **Chats table at 1000 rows**: sticky header, virtualization or pagination,
    and touch-visible row actions (hover-only today).
18. **Analytics page** hasn't had the visual refresh (old card styles); align
    with the new language (framed rows, gradient accents).
19. **Motion**: transitions vary 150–500 ms and `hover:-translate-y-px` is
    applied inconsistently; define one motion scale.
20. **Org selector in the dark sidebar** is a native `<select>` that clashes
    with the panel; replace with a styled trigger + menu.
21. **Landing page** (landing.html) still shows the old font/copy; sync with
    Figtree and the new voice before demos.
22. **Demo/seed data hygiene**: seed accounts are `@omnichannel.dev` and test
    chats named "test1/Test4" show up in screenshots; prepare a clean demo org
    for sales.
