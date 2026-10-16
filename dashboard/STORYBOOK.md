# Dashboard Storybook

Storybook documents reusable NotifyChain dashboard UI components for development and design review.

## Commands

From `dashboard/`:

```bash
npm install
npm run storybook
```

Open [http://localhost:6006](http://localhost:6006).

Build a static Storybook site:

```bash
npm run build-storybook
```

## Documented components

- `Modal` — size and footer variations
- `ThemeToggle` — light / dark
- `PaginationControls` — first / middle / last page and custom page sizes
- `EventCard` — compact / expanded / loading and event-type variants
- `EventExplorerCard` — copied, paused, and clickable states
- `ExportHistoryTable` — mixed export statuses
- `WebhookSummaryCards` — loading and filled metrics

Stories live next to components as `*.stories.tsx` and share fixtures under `src/stories/fixtures/`.

## Keyboard Shortcuts

The dashboard supports keyboard shortcuts for faster navigation. Press `?` at any time to open the shortcuts help overlay.

| Shortcut | Action |
|----------|--------|
| `1`-`9`  | Switch to the corresponding tab (Event Explorer, Delivery Timeline, etc.) |
| `T`      | Toggle between dark and light theme |
| `R`      | Refresh events |
| `?`      | Show/hide keyboard shortcuts help |
| `Esc`    | Close dialogs and overlays |

**Accessibility notes:**
- Shortcuts are disabled while typing in input fields, textareas, or editable elements.
- Modifier keys (Ctrl, Alt, Meta) are respected to avoid conflicts with browser and OS shortcuts.
- The shortcuts help overlay follows ARIA dialog patterns with focus management.
