# Dashboard accessibility automation

The `Frontend accessibility` workflow runs on dashboard pull requests, pushes to
`main`/`master`, and manual dispatch. It uses the dashboard lockfile and existing
Jest, Testing Library, user-event, and jest-axe dependencies. No browser download
or live listener/wallet service is required.

From `dashboard`, run `npm ci`, then `npm run test:a11y`. The dedicated config
inherits the dashboard transforms and module mappings, and selects only the
shared-component accessibility suite and the representative interaction suite.
Real timers are required during axe scans.

## Coverage

- Shared components: modal, mobile navigation drawer, theme toggle, toast viewport,
  and dashboard layout landmarks.
- Export history: loaded table, next page, failed-status filtering, search with no
  matches, and clearing filters to recover.
- Notification search: initial guidance, type filter and result cards, pagination,
  empty results, service failure alert, and clearing filters.
- Notification export: disabled state before filters, format selection, download
  boundary invocation, and completion status feedback.
- Keyboard dialog flow: opening with Enter, initial focus, forward/backward focus
  containment, Escape dismissal, and restoration to the trigger.

Page tests render actual page/component markup; notification API and wallet service
boundaries are mocked. They do not exercise a deployed site, live data, or wallet
extensions. The pagination page-number wrapper uses a named group because its
children are buttons rather than list items.

## Reading failures

The job fails on test errors or axe violations. The verbose console output and
`frontend-accessibility-results` artifact contain `jest.txt` and `jest.json`,
including matcher diagnostics with axe rule IDs, affected selectors/markup, and
help links. Artifacts are uploaded even after test failure and retained for 14
days; dependency-install failures may occur before reports exist. Fix the
underlying markup and rerun the focused command; do not suppress a rule just to
make CI pass. New major pages and interactive states should extend this suite.

## Manual review remains required

JSDOM cannot validate visual layout, reliable color contrast, actual browser focus
behavior, assistive-technology announcements, or usability. A passing job is not
WCAG conformance. Before release, manually check keyboard-only navigation and
visible focus across desktop/mobile menus and dialogs; screen-reader names,
headings, table navigation, loading/error announcements; light/dark contrast;
200%/400% zoom and reflow; and representative mobile browser interactions.
Record the browsers, assistive technologies, findings, and follow-up issues in the
PR or release review. Pages outside the documented subset require manual review
and future automation rather than an assumption of coverage.
