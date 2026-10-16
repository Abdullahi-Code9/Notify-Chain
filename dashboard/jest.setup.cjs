require('@testing-library/jest-dom');

const { jest } = require('@types/jest');

const originalFetch = global.fetch;
const originalSetTimeout = global.setTimeout;
const originalSetInterval = global.setInterval;

const failureState = {
  rpc: { enabled: false, remainingFailures: 0, recoveryDelayMs: 0 },
  database: { enabled: false, remainingFailures: 0, recoveryDelayMs: 0 },
  scheduler: { enabled: false, remainingFailures: 0, recoveryDelayMs: 0 },
  notificationProvider: { enabled: false, remainingFailures: 0, recoveryDelayMs: 0 },
};

const now = () => Date.now();

function normalizeComponent(component) {
  if (component === 'notification' || component === 'notificationProvider' || component === 'notification-provider') {
    return 'notificationProvider';
  }
  return component;
}

function assertComponent(component) {
  const normalized = normalizeComponent(component);
  if (!failureState[normalized]) {
    throw new Error(`Unknown failure injection component: ${component}`);
  }
  return normalized;
}

function createError(component, message) {
  const error = new Error(message);
  error.name = 'FailureInjectionError';
  error.component = component;
  error.code = 'FAILURE_INJECTED';
  return error;
}

function consumeFailure(component) {
  const normalized = assertComponent(component);
  const state = failureState[normalized];
  if (!state.enabled) {
    return null;
  }
  if (state.remainingFailures > 0) {
    state.remainingFailures -= 1;
    return createError(normalized, `Injected failure for ${normalized}`);
  }
  if (state.recoveryDelayMs > 0) {
    const elapsed = now() - state.startedAt;
    if (elapsed < state.recoveryDelayMs) {
      return createError(normalized, `Injected failure for ${normalized}`);
    }
  }
  state.enabled = false;
  return null;
}

function isFailureEnabled(component) {
  const normalized = assertComponent(component);
  const state = failureState[normalized];
  if (!state.enabled) {
    return false;
  }
  if (state.remainingFailures > 0) {
    return true;
  }
  if (state.recoveryDelayMs > 0) {
    return now() - state.startedAt < state.recoveryDelayMs;
  }
  return false;
}

function injectFailure(component, options = {}) {
  const normalized = assertComponent(component);
  const { count = 1, recoveryDelayMs = 0 } = options;
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('count must be a non-negative integer');
  }
  if (!Number.isFinite(recoveryDelayMs) || recoveryDelayMs < 0) {
    throw new Error('recoveryDelayMs must be a non-negative number');
  }
  const state = failureState[normalized];
  state.enabled = true;
  state.remainingFailures = count;
  state.recoveryDelayMs = recoveryDelayMs;
  state.startedAt = now();
  return () => clearFailure(normalized);
}

function clearFailure(component) {
  const normalized = assertComponent(component);
  const state = failureState[normalized];
  state.enabled = false;
  state.remainingFailures = 0;
  state.recoveryDelayMs = 0;
  state.startedAt = undefined;
}

function clearAllFailures() {
  Object.keys(failureState).forEach((component) => clearFailure(component));
}

function withFailure(component, options, fn) {
  const cleanup = injectFailure(component, options);
  try {
    return fn();
  } finally {
    cleanup();
  }
}

async function withFailureAsync(component, options, fn) {
  const cleanup = injectFailure(component, options);
  try {
    return await fn();
  } finally {
    cleanup();
  }
}

function failureInjectionFetch(url, init) {
  const component = /scheduler/i.test(url)
    ? 'scheduler'
    : /notification/i.test(url)
      ? 'notificationProvider'
      : /database|\/db/i.test(url)
        ? 'database'
        : 'rpc';
  const error = consumeFailure(component);
  if (error) {
    return Promise.reject(error);
  }
  return originalFetch(url, init);
}

fobject.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() {
    return 600;
  },
});

Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get() {
    return 800;
  },
});

Element.prototype.getBoundingClientRect = () => ({
  width: 800,
  height: 600,
  top: 0,
  left: 0,
  bottom: 600,
  right: 800,
  x: 0,
  y: 0,
  toJSON: () => ({}),
});

beforeAll(() => {
  clearAllFailures();
  if (originalFetch) {
    global.fetch = failureInjectionFetch;
  }
});

afterEach(() => {
  clearAllFailures();
  if (originalFetch) {
    global.fetch = failureInjectionFetch;
  }
  if (global.setTimeout !== originalSetTimeout) {
    global.setTimeout = originalSetTimeout;
  }
  if (global.setInterval !== originalSetInterval) {
    global.setInterval = originalSetInterval;
  }
});

afterAll(() => {
  clearAllFailures();
  if (originalFetch) {
    global.fetch = originalFetch;
  }
});

global.failureInjection = {
  injectFailure,
  clearFailure,
  clearAllFailures,
  isFailureEnabled,
  consumeFailure,
  withFailure,
  withFailureAsync,
  failureInjectionFetch,
  state: failureState,
};
