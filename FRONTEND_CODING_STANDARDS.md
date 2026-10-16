# Frontend Coding Standards Guide

This document outlines the coding conventions, folder structure, and component organization used throughout the Notify-Chain frontend application.

## Table of Contents

- [Naming Conventions](#naming-conventions)
- [Folder Structure](#folder-structure)
- [Component Organization](#component-organization)
- [Code Style Guidelines](#code-style-guidelines)
- [Testing Standards](#testing-standards)
- [Examples](#examples)

---

## Naming Conventions

### File Naming

- **Components**: PascalCase with `.tsx` extension
  - `SubscriptionForm.tsx`
  - `PreferencesPage.tsx`
  - `SavedFiltersPanel.tsx`

- **Hooks**: camelCase with `use` prefix and `.ts` extension
  - `usePreferences.ts`

- **Services**: camelCase with `.ts` extension
  - `preferenceService.ts`

- **Types**: camelCase with `.ts` extension
  - `preferences.ts`

- **Test Files**: Same name as the file being tested with `.test.tsx` or `.test.ts` extension
  - `SubscriptionForm.test.tsx`
  - `PreferencesPage.test.tsx`

- **Configuration Files**: camelCase or kebab-case depending on tool requirements
  - `vite.config.ts`
  - `tailwind.config.ts`
  - `tsconfig.json`

### Code Naming

- **Components**: PascalCase
  ```tsx
  export function SubscriptionForm() { }
  export function PreferencesPage() { }
  export function Toggle() { }
  ```

- **Custom Hooks**: camelCase with `use` prefix
  ```ts
  export function usePreferences() { }
  ```

- **Services/Objects**: camelCase
  ```ts
  export const preferenceService = { }
  ```

- **Types and Interfaces**: PascalCase
  ```ts
  interface FormValues { }
  interface FieldErrors { }
  type WalletState = "disconnected" | "connected";
  ```

- **Constants**: UPPER_SNAKE_CASE
  ```ts
  const GROUP_NAME_MIN = 3;
  const GROUP_NAME_MAX = 64;
  const USAGE_MIN = 1;
  ```

- **Variables and Functions**: camelCase
  ```ts
  const [walletState, setWalletState] = useState<WalletState>("disconnected");
  const handleChannelToggle = useCallback(...)
  ```

- **Event Handlers**: camelCase with `handle` prefix
  ```ts
  const handleSubmit = (e: React.FormEvent) => { }
  const handleChannelToggle = useCallback(...)
  ```

---

## Folder Structure

```
frontend/
├── src/
│   ├── components/           # React components
│   │   ├── __tests__/        # Component tests
│   │   ├── preferences/      # Feature-specific components
│   │   │   ├── PreferencesPage.tsx
│   │   │   ├── PreferencesPage.test.tsx
│   │   │   └── index.ts      # Barrel export
│   │   ├── SubscriptionForm.tsx
│   │   ├── SavedFiltersPanel.tsx
│   │   └── ...
│   ├── hooks/                # Custom React hooks
│   │   └── usePreferences.ts
│   ├── services/             # API/external service wrappers
│   │   └── preferenceService.ts
│   ├── stores/               # State management (Zustand)
│   │   ├── __tests__/
│   │   └── useSavedFilters.ts
│   ├── types/                # TypeScript type definitions
│   │   └── preferences.ts
│   └── test/                 # Test setup files
│       └── setup.ts
├── app/                      # Next.js app directory (pages)
│   ├── analytics/
│   │   └── page.tsx
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── .env.example
├── .gitignore
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── postcss.config.mjs
```

### Directory Purposes

- **`src/components/`**: Reusable UI components. Organize by feature when components are related.
- **`src/components/__tests__/`**: Test files for top-level components.
- **`src/hooks/`**: Custom React hooks that encapsulate reusable logic.
- **`src/services/`**: API clients, external service wrappers, and business logic.
- **`src/stores/`**: Global state management using Zustand.
- **`src/types/`**: Shared TypeScript type definitions and interfaces.
- **`src/test/`**: Test configuration and setup files.
- **`app/`**: Next.js App Router pages and layouts.

---

## Component Organization

### Component Structure

Components should follow this general structure:

1. **Imports** - All imports at the top
2. **Type Definitions** - Local types and interfaces
3. **Constants** - Component-specific constants
4. **Sub-components** - Helper components defined before the main component
5. **Main Component** - The primary exported component
6. **Helper Functions** - Non-component utility functions

### Example Component Structure

```tsx
"use client";

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface FormValues {
  groupName: string;
  usageCount: number | "";
}

interface FieldErrors {
  groupName?: string;
  usageCount?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GROUP_NAME_MIN = 3;
const GROUP_NAME_MAX = 64;

// ---------------------------------------------------------------------------
// Validation Functions
// ---------------------------------------------------------------------------
export function validateGroupName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Group name is required.";
  if (trimmed.length < GROUP_NAME_MIN) {
    return `Group name must be at least ${GROUP_NAME_MIN} characters.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
interface BannerProps {
  state: WalletState;
  publicKey: string | null;
  error: string | null;
  onConnect: () => void;
  onRetry: () => void;
}

function WalletStatusBanner({ state, publicKey, error, onConnect, onRetry }: BannerProps) {
  // Implementation
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export default function SubscriptionForm() {
  // Implementation
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------
function buildSubscriptionTx(_form: { groupName: string; usageCount: number }, _creator: string): string {
  return "AAAAAA==";
}
```

### Feature-Based Organization

When a feature has multiple related components, organize them in a subdirectory:

```
components/
└── preferences/
    ├── PreferencesPage.tsx      # Main component
    ├── PreferencesPage.test.tsx # Tests
    └── index.ts                 # Barrel export
```

The `index.ts` file provides clean imports:

```ts
// components/preferences/index.ts
export { PreferencesPage } from "./PreferencesPage";
export type { PreferencesPageProps } from "./PreferencesPage";
```

Usage:

```ts
import { PreferencesPage } from "@/components/preferences";
```

### Component Comments

Add JSDoc-style comments for complex components:

```tsx
/**
 * PreferencesPage – Notification Preferences Management Interface
 *
 * Implements Issue #178:
 * - Toggles for notification categories
 * - Support for Email, Wallet, and In-App delivery channels
 * - Displays current preference status
 * - Loading and error states
 * - Responsive mobile + desktop layout
 * - Connects to backend preference APIs via usePreferences hook
 */
export function PreferencesPage({ recipient }: PreferencesPageProps) {
  // ...
}
```

---

## Code Style Guidelines

### TypeScript

- Use **strict mode** (enabled in `tsconfig.json`)
- Prefer **explicit return types** for exported functions
- Use **type unions** for string literals with known values
- Avoid `any` - use `unknown` if necessary with proper type guards

```ts
// Good
type WalletState = "disconnected" | "connected" | "waiting_for_signature" | "error";

// Avoid
type WalletState = string;
```

### React Patterns

- Use **functional components** with hooks
- Prefer **`useCallback`** for event handlers passed to children
- Use **`useMemo`** for expensive computations
- Implement **proper TypeScript types** for props

```ts
const handleChannelToggle = useCallback(
  (channel: DeliveryChannel) => async (enabled: boolean) => {
    await setChannel(channel, enabled);
  },
  [setChannel]
);
```

### State Management

- Use **Zustand** for global state (see `src/stores/`)
- Use **React hooks** for local component state
- Follow the **loading/error/success pattern** for async operations

```ts
export type PreferencesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: RecipientPreferences }
  | { status: "error"; error: string };
```

### Styling

- Use **Tailwind CSS** for styling
- Prefer **utility classes** over custom CSS
- Use **dark mode** variants where appropriate
- Follow **responsive design** patterns (mobile-first)

```tsx
className={[
  "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full",
  "transition-colors duration-200 ease-in-out focus:outline-none",
  checked ? "bg-indigo-600" : "bg-gray-200",
  disabled ? "cursor-not-allowed opacity-50" : "",
]
  .filter(Boolean)
  .join(" ")
```

### Accessibility

- Use **semantic HTML** elements
- Include **ARIA attributes** for interactive elements
- Provide **proper labels** for form inputs
- Support **keyboard navigation**

```tsx
<button
  id={id}
  role="switch"
  aria-checked={checked}
  aria-label={label}
  disabled={disabled}
  onClick={() => onChange(!checked)}
>
```

---

## Testing Standards

### Test Organization

- Place test files **co-located** with the component being tested
- Name test files as `[ComponentName].test.tsx`
- Use **Vitest** as the test runner
- Use **Testing Library** for component testing

### Test Structure

```tsx
describe('ComponentName', () => {
  beforeEach(() => {
    // Setup mocks
  });

  it('does something specific', () => {
    // Test implementation
  });
});
```

### Testing Best Practices

- Test **user behavior**, not implementation details
- Use **screen queries** from Testing Library
- Mock external dependencies (services, hooks)
- Test **error states** and **loading states**
- Use **descriptive test names**

```tsx
it('shows connect prompt when wallet is disconnected', () => {
  render(<SubscriptionForm />);
  expect(screen.getByText(/connect your freighter wallet/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument();
});
```

### Mocking Services

Mock services at the top of test files:

```tsx
vi.mock("../../services/preferenceService", () => ({
  preferenceService: mockService,
}));
```

---

## Examples

### Complete Component Example

See `src/components/SubscriptionForm.tsx` for a complete example of:
- Form validation
- Wallet integration
- State management
- Error handling
- Accessibility

### Complete Hook Example

See `src/hooks/usePreferences.ts` for a complete example of:
- Custom React hook
- Async state management
- Optimistic updates
- Error handling

### Complete Service Example

See `src/services/preferenceService.ts` for a complete example of:
- Service layer pattern
- Type-safe API calls
- Error handling
- Documentation

### Complete Test Example

See `src/components/preferences/PreferencesPage.test.tsx` for a complete example of:
- Component testing
- Mocking
- User interaction testing
- State testing

---

## Additional Resources

- [React Documentation](https://react.dev/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [Testing Library Documentation](https://testing-library.com/docs/react-testing-library/intro/)
- [Vitest Documentation](https://vitest.dev/)
- [Zustand Documentation](https://zustand-demo.pmnd.rs/)
