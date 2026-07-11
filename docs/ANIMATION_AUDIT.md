# Animation audit — the "expensive" feel without the cost

Compiled 2026-07-11 from a code pass over apps/web. Companion to UX_AUDIT.md
item 19 (one motion scale).

**Where we stand.** All motion today is Tailwind utilities: spinners,
`animate-pulse` skeletons, two `animate-ping` live dots, `hover:-translate-y-px`
on buttons, the compact-view padding transition, the settings toggle knob, the
risk-meter marker, progress-bar widths, and sonner's built-in toast animations.
No animation library is installed and none is needed — everything below is CSS
keyframes + Tailwind config, zero bundle cost.

**Performance guardrails (apply to every item):**
- Animate `transform` and `opacity` only — GPU-composited, no reflow. The two
  existing exceptions (compact-view padding, progress width) stay as-is.
- One motion scale in tailwind.config: 150ms enter / 100ms exit for controls,
  200–250ms for surfaces, 400–600ms for one-off accents. `ease-out` in,
  `ease-in` out.
- Everything behind `motion-safe:` variants so `prefers-reduced-motion` users
  get an instant UI.
- Mount-stagger capped at the first ~12 items; nothing animates in the
  1000-row chats table except row hover.
- No infinite loops besides the existing live-dots and the sending stripe.

## Ranked by "looks expensive" per unit of work

1. **Overlays and modals enter/exit** (import wizard, tag/template editors,
   connect modal, delete confirms, settings modal). Today they pop in with no
   transition — the single most visible cheapness. Backdrop fades in 150ms;
   the panel does opacity 0→1 + scale .97→1 + translateY 8px→0, 200ms ease-out.
   One shared `<Modal>` wrapper (UX_AUDIT #12) gets this for free everywhere.
2. **Skeleton shimmer.** Replace `animate-pulse` with a moving gradient sweep
   (pseudo-element, `translateX(-100%→100%)`, 1.4s). This is the texture people
   recognize from Linear/Stripe; one change in `Skeleton.tsx` upgrades every
   loading state at once.
3. **List mount stagger** (Broadcasts, Templates, Tags, Connected Accounts,
   Platform Settings, dashboard cards): fade + translateY(6px) 200ms with a
   25ms/item delay, first ~12 items only, on first mount only (CSS
   `animation-delay` via inline style index).
4. **Dashboard numbers count up** (metric cards): requestAnimationFrame from 0
   to value over ~600ms with ease-out, once per load. Paired with the card
   stagger, the first screen reads premium immediately.
5. **A live broadcast feels alive.** While `status === 'sending'`: the amber
   progress bar gets a slow-moving diagonal stripe (background-position
   animation on a composited layer); new delivery-log lines enter with
   fade + translateY; the per-messenger cards' bars already transition width.
6. **Button micro-interactions.** `motion-safe:active:scale-[0.98]` on primary
   buttons; the existing `hover:-translate-y-px` kept but standardized (it is
   missing on some cards); Save buttons briefly morph to a check on success
   (scale-in 300ms) before the toast.
7. **Wizard step changes** (broadcast + import): the step body enters with
   fade + translateX(12px→0) 150ms; the step-indicator bars already transition
   color — add width transition on the fill.
8. **Route-level fade.** `app/(dashboard)/template.tsx` with a 150ms fade-in on
   `main`. Enter-only (no exit) so navigation never waits on animation.
9. **Sidebar active indicator** slides between items (absolutely-positioned
   2px accent bar, `transition: transform 200ms`), instead of the instant
   background swap.
10. **Status chips crossfade.** After Update chats flips Active/Inactive, the
    chip color changes mid-refetch — `transition-colors duration-300` makes the
    flip readable instead of jarring.
11. **Collapsibles** (delivery Logs, FAQ accordion): animate `grid-template-rows
    0fr→1fr` (modern, layout-cheap) so panels unfold instead of snapping; the
    chevrons already rotate.

## Deliberately not animated

- The chats table body (up to 1000 rows): hover states only.
- Teams remote-login frames (it's a video-like stream already).
- Anything scroll-linked or parallax — wrong genre for a work tool.
- Skeleton→content swap stays a plain replace; content-shaped skeletons
  already prevent layout jump.

## Implementation shape

~30 lines in `tailwind.config.ts` (keyframes: `fade-in-up`, `shimmer`,
`stripe-slide`, `scale-in`; duration/easing tokens), a `<Modal>` wrapper, a
`Skeleton.tsx` edit, and point applications per page. No dependencies. Roughly
half a day for items 1–6; the rest are follow-ups behind the shared components
from UX_AUDIT P1.
