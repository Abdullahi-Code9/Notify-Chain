# Implementation Plan: Event Detail Drawer

## Overview

This implementation plan converts the design into actionable frontend development tasks. The event detail drawer will be built incrementally across 4 phases: component infrastructure, core drawer implementation, interaction features, and polish/testing. Each phase includes checkpoints to validate progress.

## Tasks

- [ ] 1. Phase 1: Component Foundation and State Management
  - [ ] 1.1 Create EventDetailDrawer component shell
    - Create `dashboard/src/components/EventDetailDrawer.tsx`
    - Define component props interface
    - Set up initial state management (open/close, selected event)
    - Render basic drawer structure with header and close button
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 1.1, 5.1, 10.1_

  - [ ] 1.2 Implement backdrop and container styling
    - Create drawer backdrop with semi-transparent overlay
    - Implement slide-in animation from right (CSS transitions)
    - Position drawer panel correctly for desktop (40-50% width)
    - Apply responsive breakpoints for tablet and mobile
    - File: `dashboard/src/components/EventDetailDrawer.tsx` (styles)
    - _Requirements: 1.2, 11.1, 11.2, 11.3, 13.1, 13.2_

  - [ ] 1.3 Create MetadataRow sub-component
    - Render label + value pairs
    - Handle abbreviation for long values (first 10 + last 8 chars)
    - Display null/undefined as "—"
    - Export for use in sections
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 2.1, 7.1, 7.5, 7.6, 9.1_

  - [ ] 1.4 Create CopyButton sub-component
    - Render icon button with aria-label
    - Implement copy-to-clipboard using navigator.clipboard API
    - Include fallback for older browsers (textarea trick)
    - Handle errors gracefully
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.8_

  - [ ] 1.5 Set up EventFeed integration state
    - Add `selectedEventId` state to EventFeed component
    - Add `drawerOpen` state to EventFeed component
    - Create `handleEventSelect(eventId)` callback
    - Create `handleDrawerClose()` callback
    - Pass state to EventDetailDrawer via props
    - File: `dashboard/src/components/EventList.tsx` or parent
    - _Requirements: 1.1, 1.3, 14.1_

  - [ ] 1.6 Checkpoint — Component renders without errors
    - Render EventFeed with EventDetailDrawer
    - Verify drawer appears when opened
    - Verify close button exists and is clickable
    - Check responsive layout at different breakpoints
    - _Requirements: 1.1, 1.2_

- [ ] 2. Phase 2: Metadata Display and Sections
  - [ ] 2.1 Create SenderDetailsSection component
    - Display contract address with copy button
    - Display sender info if available
    - Use MetadataRow for formatting
    - Handle missing sender data gracefully
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 2.2, 2.3, 6.1, 8.1, 8.2, 9.2_

  - [ ] 2.2 Create BlockchainContextSection component
    - Display event name
    - Display event type
    - Display event ID with copy button
    - Display ledger number
    - Display transaction hash with copy button
    - Display formatted timestamp
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 6.2, 6.3, 8.1, 8.2_

  - [ ] 2.3 Create EventPayloadSection component
    - Display payload fields without truncation
    - Implement text wrapping for long values (no ellipsis)
    - Handle special characters and unicode preservation
    - Provide vertical scrolling for many fields
    - Display "No payload data" if payload empty
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 8.1_

  - [ ] 2.4 Create StatusHistorySection component (optional)
    - Display status timeline if data available
    - Format timestamps consistently
    - Hide section if no status history
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 8.1, 8.4_

  - [ ] 2.5 Implement section header styling and hierarchy
    - Use semantic `<h3>` tags for section headers
    - Apply consistent spacing and visual separation
    - Use semantic `<dl>` for metadata rows
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 8.2, 8.6, 10.8, 10.10_

  - [ ] 2.6 Add event metadata loading and display
    - Display core metadata immediately
    - Format timestamps as human-readable dates (ISO 8601 → readable)
    - Abbreviate addresses and hashes (10+...+8 pattern)
    - Handle null/undefined gracefully with em-dash
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 7.1, 7.5, 7.6_

  - [ ] 2.7 Checkpoint — All metadata sections render correctly
    - Open drawer and verify all sections display
    - Verify metadata values are abbreviated correctly
    - Verify null values display as "—"
    - Verify timestamp formatting (human-readable)
    - Verify payload displays without truncation
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

- [ ] 3. Phase 3: Interaction Features
  - [ ] 3.1 Implement drawer open animation
    - Animate backdrop fade-in over 150ms
    - Animate panel slide-in over 250ms using CSS transitions
    - Ensure animation is smooth and interruptible
    - Test prefers-reduced-motion media query
    - File: `dashboard/src/components/EventDetailDrawer.tsx` (CSS)
    - _Requirements: 13.1, 13.2, 13.3, 13.6_

  - [ ] 3.2 Implement drawer close animation
    - Animate panel slide-out over 200ms
    - Animate backdrop fade-out
    - Remove from DOM or hide after animation
    - File: `dashboard/src/components/EventDetailDrawer.tsx` (CSS)
    - _Requirements: 13.3, 13.4, 13.5_

  - [ ] 3.3 Implement backdrop click-to-close
    - Detect click on backdrop element
    - Trigger drawer close
    - Prevent click event from bubbling to feed
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 4.2, 4.6_

  - [ ] 3.4 Implement close button functionality
    - Close button triggers `onClose()` callback
    - Feed preserves scroll position when drawer closes
    - Feed focus returns to selected event or feed element
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 4.1, 4.4, 4.5_

  - [ ] 3.5 Implement copy-to-clipboard feedback
    - Display confirmation message ("Address copied") for 1.5-2 seconds
    - Auto-dismiss notification after timeout
    - Display error message if copy fails
    - Focus remains on copy button after copy
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 6.4, 6.5, 6.6, 6.7, 6.8_

  - [ ] 3.6 Implement feed position preservation
    - Capture feed scroll position when drawer opens
    - Restore feed position when drawer closes
    - Prevent feed scroll while drawer is open (mobile)
    - Store position in state or ref
    - File: `dashboard/src/components/EventList.tsx` (parent)
    - _Requirements: 4.4, 4.5, 4.7_

  - [ ] 3.7 Implement event selection highlighting in feed
    - Add visual highlighting to selected event row
    - Update highlighting when different event selected
    - Keep highlight visible (scroll into view if needed) while drawer open
    - Remove highlight when drawer closes
    - File: `dashboard/src/components/EventRow.tsx`
    - _Requirements: 1.3, 14.1, 14.2, 14.3, 14.4, 14.5_

  - [ ] 3.8 Implement event switching while drawer open
    - Allow user to select different event while drawer is open
    - Update drawer content without closing drawer
    - No close/reopen animation when switching events
    - Fade out old content, fade in new content (optional)
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 1.5, 14.1_

  - [ ] 3.9 Checkpoint — All interactions work correctly
    - Open and close drawer multiple times
    - Verify feed position is preserved
    - Verify copy buttons work and show feedback
    - Verify backdrop click closes drawer
    - Verify close button works
    - Verify event switching updates drawer content
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [ ] 4. Phase 4: Keyboard Navigation and Accessibility
  - [ ] 4.1 Implement focus trap
    - Create useFocusTrap hook (or use existing library)
    - Tab cycles through interactive elements: close button → copy buttons → drawer
    - Shift+Tab cycles backwards through elements
    - First element focused automatically when drawer opens
    - Focus returns to previously focused element when drawer closes
    - File: `dashboard/src/hooks/useFocusTrap.ts` and `EventDetailDrawer.tsx`
    - _Requirements: 5.1, 5.2, 5.5, 5.6, 5.7_

  - [ ] 4.2 Implement Escape key handling
    - Pressing Escape closes drawer from any focused element
    - Works even if focus is on copy button or other elements
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 4.3, 5.4_

  - [ ] 4.3 Implement close button keyboard accessibility
    - Close button focusable via Tab key
    - Pressing Enter or Space activates close button
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 5.3, 5.8_

  - [ ] 4.4 Add ARIA attributes and labels
    - Drawer: role="dialog", aria-modal="true", aria-label, aria-labelledby
    - Close button: aria-label="Close drawer"
    - Section headers: Proper heading hierarchy with ids
    - Copy buttons: aria-label="Copy {field} {value}"
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [ ] 4.5 Add status and alert ARIA roles
    - Copy feedback uses role="status" aria-live="polite"
    - Error messages use role="alert" aria-live="assertive"
    - Backdrop has aria-hidden="true"
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 10.5, 10.6, 10.7, 10.9_

  - [ ] 4.6 Use semantic HTML
    - Event name as `<h2>` in drawer header
    - Section titles as `<h3>` tags
    - Metadata rows as `<dl>/<dt>/<dd>` structure
    - All interactive elements as `<button>` tags
    - Optional: Timestamp as `<time>` tag
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 10.8, 10.10_

  - [ ] 4.7 Test keyboard navigation
    - Tab through all interactive elements
    - Verify focus order is logical: close → address copy → id copy → hash copy → drawer
    - Verify Shift+Tab reverses order
    - Verify Escape closes drawer
    - Verify Enter/Space on close button works
    - Manual testing with keyboard only
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [ ] 4.8 Test with screen reader
    - Open drawer with screen reader enabled
    - Verify drawer announcement: "Event details dialog opened"
    - Verify section headers announced as headings
    - Verify metadata labels associated with values
    - Verify copy button labels announced
    - Test with NVDA, JAWS, or MacOS VoiceOver
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

  - [ ] 4.9 Checkpoint — Full keyboard and screen reader accessibility
    - Keyboard navigation works smoothly
    - Focus trapping prevents tab escape
    - All interactive elements reachable
    - Screen reader announces drawer and sections
    - No accessibility violations in axe-core scan
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ] 5. Phase 5: Performance and Polish
  - [ ] 5.1 Implement metadata caching
    - Create event metadata cache (Map<string, EventMetadata>)
    - Check cache before fetching metadata
    - Store fetched metadata in cache
    - Set cache expiration (5-10 minutes optional)
    - File: `dashboard/src/hooks/useEventMetadata.ts`
    - _Requirements: 12.6_

  - [ ] 5.2 Implement lazy loading for extended metadata
    - Display core metadata immediately
    - Load payload and extended data asynchronously
    - Show loading state while fetching
    - Handle fetch errors with retry option
    - File: `dashboard/src/hooks/useEventMetadata.ts`
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [ ] 5.3 Implement error boundary
    - Wrap drawer in Error Boundary component
    - Display fallback UI on error
    - Allow user to close drawer or retry
    - Log error for debugging
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 12.4, 9.1_

  - [ ] 5.4 Implement prefers-reduced-motion support
    - Detect prefers-reduced-motion media query
    - Skip animations if reduced motion requested
    - Keep layout the same, just remove transitions
    - File: `dashboard/src/components/EventDetailDrawer.tsx` (CSS)
    - _Requirements: 13.6_

  - [ ] 5.5 Implement tooltip for abbreviated values
    - Show full value in tooltip on hover
    - Keep tooltip visible for 1+ second after hover ends
    - Use existing Tooltip component or create simple one
    - Accessible tooltip with ARIA attributes
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 7.2, 7.4_

  - [ ] 5.6 Optimize rendering with memoization
    - Memoize section components (SenderDetails, BlockchainContext, etc.)
    - Use useCallback for event handlers
    - Use useMemo for expensive calculations
    - Prevent unnecessary re-renders when drawer switches events
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 12.5_

  - [ ] 5.7 Handle drawer updates while feed updates
    - Ensure drawer content doesn't refresh when new events arrive
    - Keep drawer displaying previously loaded event even if removed from feed
    - Support pagination without closing drawer
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: 15.1, 15.2, 15.3_

  - [ ] 5.8 Test responsive layout on all breakpoints
    - Test mobile < 480px: Full-screen drawer, feed locked
    - Test tablet 480-767px: 60-70% width drawer
    - Test desktop ≥ 768px: 40-50% width drawer
    - Verify content readable on all sizes
    - Verify no horizontal scrolling needed
    - Verify touch targets 44x44px on mobile
    - File: Dashboard on multiple devices/viewports
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

  - [ ] 5.9 Test payload field edge cases
    - Test single-line short payloads
    - Test multi-line payloads with \n characters
    - Test payloads with special characters and unicode
    - Test nested objects/arrays in payload
    - Test empty payload
    - Verify no truncation, text wraps properly
    - File: Manual testing in browser
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 9.4_

  - [ ] 5.10 Checkpoint — Performance and polish complete
    - Drawer opens within 100ms
    - Core metadata visible within 150ms
    - Metadata caching working
    - Prefers-reduced-motion respected
    - Responsive on all breakpoints
    - No console errors or warnings
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

- [ ] 6. Phase 6: Integration Testing and Documentation
  - [ ] 6.1 Create integration tests
    - Test drawer opens when event clicked
    - Test drawer closes on close button click
    - Test drawer closes on Escape key
    - Test drawer closes on backdrop click
    - Test feed position preserved
    - Test event switching while drawer open
    - Test copy buttons work
    - File: `dashboard/src/components/EventDetailDrawer.test.tsx`
    - _Requirements: 1.1, 1.2, 4.1, 4.2, 4.3, 6.1, 6.2, 6.3_

  - [ ] 6.2 Create accessibility tests
    - Test keyboard navigation with userEvent
    - Test focus trap (Tab doesn't escape)
    - Test ARIA attributes present
    - Test screen reader announcements with accessibility tree
    - Test prefers-reduced-motion respected
    - File: `dashboard/src/components/EventDetailDrawer.test.tsx`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 10.1, 10.2, 10.3_

  - [ ] 6.3 Create responsive layout tests
    - Test drawer width at mobile breakpoint
    - Test drawer width at tablet breakpoint
    - Test drawer width at desktop breakpoint
    - Verify content doesn't overflow
    - File: `dashboard/src/components/EventDetailDrawer.test.tsx`
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.6_

  - [ ] 6.4 Add inline documentation and comments
    - Document component props and usage
    - Document focus trap logic
    - Document caching strategy
    - Document responsive breakpoints
    - Add JSDoc comments for complex functions
    - File: `dashboard/src/components/EventDetailDrawer.tsx`
    - _Requirements: All_

  - [ ] 6.5 Create user-facing documentation
    - Add screenshot of drawer to dashboard README
    - Document how to open drawer (click event)
    - Document keyboard shortcuts (Escape to close, Tab to navigate)
    - Document copy-to-clipboard feature
    - File: `dashboard/README.md` or `docs/`
    - _Requirements: All_

  - [ ] 6.6 Final QA and validation
    - Manual end-to-end testing across all browsers
    - Verify all requirements met
    - Run accessibility audit (axe-core, WAVE)
    - Performance audit (Lighthouse)
    - Manual keyboard-only testing
    - Manual screen reader testing
    - File: Manual testing checklist
    - _Requirements: All_

  - [ ] 6.7 Checkpoint — All tests pass, documentation complete
    - All integration tests passing
    - All accessibility tests passing
    - All responsive layout tests passing
    - No console errors or accessibility violations
    - Documentation complete and accurate
    - _Requirements: All_

## Notes

- Tasks build incrementally; each phase has a checkpoint to catch issues early
- Phase 1-3 focus on core functionality; Phase 4 focuses on accessibility; Phase 5 focuses on performance
- Phase 6 ensures quality through testing and documentation
- Tasks reference specific requirements for full traceability
- Keyboard navigation (focus trap, Escape, Tab) critical for Phase 4
- Responsive design tested at each checkpoint, not just Phase 5
- Animation complexity can be reduced to simple opacity/transform if needed for schedule
- Copy-to-clipboard with fallback handles older browsers
- Screen reader testing recommended with real users or NVDA/JAWS trial versions

