# Design Document: Stellar Explorer Navigation

## Overview

The Stellar explorer navigation system provides a reusable, type-safe way to generate and display links to Stellar blockchain explorers without hard-coding network-specific URLs. The design emphasizes separation of concerns through dedicated modules for network detection, URL generation, validation, and caching, enabling easy adaptation to future protocol changes and explorer service updates.

Core design principles:
1. **Configuration-driven** — All network and explorer URLs defined in config, not code
2. **Type-safe** — TypeScript interfaces enforce correct network types and URL formats
3. **Validated** — Transaction hashes and URLs validated before use
4. **Cached** — Network config and generated URLs cached for performance
5. **Composable** — Modular design allows independent testing and evolution

## Architecture

### Module Structure

```
dashboard/src/
├── config/
│   └── stellarNetwork.ts          # Network config and explorer mappings
├── utils/
│   ├── explorerUrl.ts              # URL generation and validation
│   ├── networkDetector.ts           # Network detection from config
│   └── urlValidator.ts              # URL format validation
├── hooks/
│   └── useExplorerUrl.ts            # React hook for URL generation with caching
└── components/
    └── TransactionLink.tsx           # Reusable component for explorer links
```

### Component Hierarchy

```
Dashboard
├── EventDetailsDrawer
│   ├── MetadataRow
│   │   └── TransactionLink (wraps hash)
│   └── PayloadSection
│       └── TransactionLink (in payload)
├── TransactionList
│   ├── TransactionRow
│   │   └── TransactionLink (hash column)
│   └── ...
└── ...
```

## Modules

### 1. Network Configuration (`stellarNetwork.ts`)

**Purpose:** Centralized configuration for all Stellar networks and explorer services.

```typescript
// Network configuration
export interface NetworkConfig {
  name: string
  type: 'mainnet' | 'testnet' | 'futurenet'
  displayName: string
  explorerServices: ExplorerService[]
}

export interface ExplorerService {
  name: string
  baseUrl: string
  txPath: string // e.g., '/tx/{hash}'
  priority: number // Primary (1) or fallback (2+)
}

// Configuration mapping
export const STELLAR_NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    name: 'mainnet',
    type: 'mainnet',
    displayName: 'Mainnet',
    explorerServices: [
      {
        name: 'stellar.expert',
        baseUrl: 'https://stellar.expert',
        txPath: '/tx/{hash}',
        priority: 1,
      },
      // Optional fallback explorer
    ],
  },
  testnet: {
    name: 'testnet',
    type: 'testnet',
    displayName: 'Testnet',
    explorerServices: [
      {
        name: 'stellar.expert',
        baseUrl: 'https://testnet.stellar.expert',
        txPath: '/tx/{hash}',
        priority: 1,
      },
    ],
  },
  futurenet: {
    name: 'futurenet',
    type: 'futurenet',
    displayName: 'Futurenet',
    explorerServices: [
      {
        name: 'stellar.expert',
        baseUrl: 'https://futurenet.stellar.expert',
        txPath: '/tx/{hash}',
        priority: 1,
      },
    ],
  },
}

// Export network type for type safety
export type NetworkType = 'mainnet' | 'testnet' | 'futurenet'
```

**Benefits:**
- Single source of truth for network and explorer configuration
- Easy to add new networks or explorers
- Type-safe network names
- Priority system for fallback explorers

### 2. Network Detector (`networkDetector.ts`)

**Purpose:** Detect configured network from environment or settings.

```typescript
export interface NetworkDetectorOptions {
  configSource?: 'env' | 'settings' | 'custom'
  defaultNetwork?: NetworkType
  logger?: Logger
}

export class NetworkDetector {
  private currentNetwork: NetworkType | null = null
  private listeners: Set<(network: NetworkType) => void> = new Set()
  private options: NetworkDetectorOptions

  constructor(options: NetworkDetectorOptions = {}) {
    this.options = {
      configSource: 'env',
      defaultNetwork: 'testnet',
      ...options,
    }
    this.detectNetwork()
  }

  private detectNetwork(): void {
    try {
      // Try environment first
      const envNetwork = process.env.REACT_APP_STELLAR_NETWORK
      if (envNetwork && this.isValidNetwork(envNetwork)) {
        this.currentNetwork = envNetwork as NetworkType
        return
      }

      // Try local storage (for runtime changes)
      const storedNetwork = localStorage.getItem('stellar_network')
      if (storedNetwork && this.isValidNetwork(storedNetwork)) {
        this.currentNetwork = storedNetwork as NetworkType
        return
      }

      // Fall back to default
      this.currentNetwork = this.options.defaultNetwork || 'testnet'
      this.options.logger?.warn(
        `No network configured, using default: ${this.currentNetwork}`
      )
    } catch (error) {
      this.options.logger?.error('Failed to detect network:', error)
      this.currentNetwork = this.options.defaultNetwork || 'testnet'
    }
  }

  private isValidNetwork(value: string): boolean {
    return ['mainnet', 'testnet', 'futurenet'].includes(value)
  }

  getCurrentNetwork(): NetworkType {
    return this.currentNetwork || 'testnet'
  }

  setNetwork(network: NetworkType): void {
    if (!this.isValidNetwork(network)) {
      this.options.logger?.error(`Invalid network: ${network}`)
      return
    }

    if (this.currentNetwork !== network) {
      this.currentNetwork = network
      localStorage.setItem('stellar_network', network)
      this.notifyListeners(network)
    }
  }

  subscribe(listener: (network: NetworkType) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(network: NetworkType): void {
    this.listeners.forEach(listener => listener(network))
  }
}

// Export singleton instance
export const networkDetector = new NetworkDetector()
```

**Features:**
- Multi-source detection (env, storage, default)
- Observer pattern for network change notifications
- Type-safe network validation
- Comprehensive error logging

### 3. URL Validator (`urlValidator.ts`)

**Purpose:** Validate transaction hashes and generated URLs.

```typescript
export interface ValidationResult {
  valid: boolean
  error?: string
}

export const URL_VALIDATOR = {
  // Validate transaction hash: 64 hex characters
  validateTransactionHash(hash: unknown): ValidationResult {
    if (typeof hash !== 'string') {
      return { valid: false, error: 'Hash must be a string' }
    }

    if (hash.length !== 64) {
      return { valid: false, error: 'Hash must be 64 characters' }
    }

    if (!/^[a-f0-9]{64}$/i.test(hash)) {
      return { valid: false, error: 'Hash must be hexadecimal' }
    }

    return { valid: true }
  },

  // Validate URL format
  validateUrl(url: string): ValidationResult {
    try {
      const parsedUrl = new URL(url)

      // Must be HTTPS
      if (parsedUrl.protocol !== 'https:') {
        return { valid: false, error: 'URL must use HTTPS' }
      }

      // Must have hostname
      if (!parsedUrl.hostname) {
        return { valid: false, error: 'URL missing hostname' }
      }

      return { valid: true }
    } catch (error) {
      return { valid: false, error: `Invalid URL format: ${String(error)}` }
    }
  },

  // Validate explorer URL path
  validateExplorerPath(path: string): ValidationResult {
    if (typeof path !== 'string' || !path.includes('{hash}')) {
      return {
        valid: false,
        error: 'Explorer path must include {hash} placeholder',
      }
    }

    return { valid: true }
  },
}
```

**Validation Coverage:**
- Transaction hash format (64 hex characters)
- URL format (valid URL structure)
- Protocol requirement (HTTPS only)
- Explorer path format (contains {hash} placeholder)

### 4. URL Generator (`explorerUrl.ts`)

**Purpose:** Generate and cache explorer URLs for transaction hashes.

```typescript
export interface ExplorerUrlResult {
  url: string | null
  network: NetworkType
  error?: string
  cached: boolean
}

export class ExplorerUrlGenerator {
  private cache: Map<string, string> = new Map()
  private maxCacheSize = 1000
  private logger: Logger

  constructor(logger?: Logger) {
    this.logger = logger || console
  }

  generate(
    hash: string,
    network?: NetworkType
  ): ExplorerUrlResult {
    const currentNetwork = network || networkDetector.getCurrentNetwork()
    const cacheKey = `${currentNetwork}:${hash}`

    // Check cache first
    if (this.cache.has(cacheKey)) {
      this.logger.debug(`Cache hit for ${cacheKey}`)
      return {
        url: this.cache.get(cacheKey) || null,
        network: currentNetwork,
        cached: true,
      }
    }

    // Validate hash
    const hashValidation = URL_VALIDATOR.validateTransactionHash(hash)
    if (!hashValidation.valid) {
      this.logger.warn(`Invalid hash: ${hashValidation.error}`)
      return {
        url: null,
        network: currentNetwork,
        error: hashValidation.error,
        cached: false,
      }
    }

    // Get network config
    const networkConfig = STELLAR_NETWORKS[currentNetwork]
    if (!networkConfig) {
      this.logger.error(`Unknown network: ${currentNetwork}`)
      return {
        url: null,
        network: currentNetwork,
        error: `Unknown network: ${currentNetwork}`,
        cached: false,
      }
    }

    // Get primary explorer service
    const explorer = networkConfig.explorerServices.find(s => s.priority === 1)
    if (!explorer) {
      this.logger.error(`No explorer configured for ${currentNetwork}`)
      return {
        url: null,
        network: currentNetwork,
        error: `No explorer configured`,
        cached: false,
      }
    }

    // Generate URL
    const url = explorer.baseUrl + explorer.txPath.replace('{hash}', hash)

    // Validate generated URL
    const urlValidation = URL_VALIDATOR.validateUrl(url)
    if (!urlValidation.valid) {
      this.logger.error(`Generated invalid URL: ${urlValidation.error}`)
      return {
        url: null,
        network: currentNetwork,
        error: urlValidation.error,
        cached: false,
      }
    }

    // Cache and return
    this.setCacheEntry(cacheKey, url)
    this.logger.debug(`Generated URL for ${cacheKey}: ${url}`)

    return {
      url,
      network: currentNetwork,
      cached: false,
    }
  }

  private setCacheEntry(key: string, value: string): void {
    if (this.cache.size >= this.maxCacheSize) {
      // Remove oldest entries (first added)
      const entriesToRemove = Math.ceil(this.maxCacheSize * 0.1)
      const keys = Array.from(this.cache.keys())
      keys.slice(0, entriesToRemove).forEach(k => this.cache.delete(k))
    }

    this.cache.set(key, value)
  }

  invalidateCache(network?: NetworkType): void {
    if (network) {
      // Invalidate specific network
      const prefix = `${network}:`
      const keysToDelete = Array.from(this.cache.keys()).filter(k =>
        k.startsWith(prefix)
      )
      keysToDelete.forEach(k => this.cache.delete(k))
      this.logger.debug(`Invalidated cache for network: ${network}`)
    } else {
      // Clear all cache
      this.cache.clear()
      this.logger.debug('Cleared all URL cache')
    }
  }

  getCacheStats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: this.maxCacheSize }
  }
}

// Export singleton instance
export const explorerUrlGenerator = new ExplorerUrlGenerator()
```

**Features:**
- URL generation with validation
- LRU-like cache with size limits
- Network-aware generation
- Comprehensive logging
- Cache invalidation

### 5. React Hook (`useExplorerUrl.ts`)

**Purpose:** Provide React component access to explorer URL generation with automatic updates.

```typescript
export interface UseExplorerUrlOptions {
  hash: string
  network?: NetworkType
  onError?: (error: string) => void
}

export function useExplorerUrl(options: UseExplorerUrlOptions) {
  const [result, setResult] = React.useState<ExplorerUrlResult | null>(null)

  // Generate URL on mount and when hash/network changes
  React.useEffect(() => {
    const result = explorerUrlGenerator.generate(options.hash, options.network)
    setResult(result)

    if (result.error && options.onError) {
      options.onError(result.error)
    }
  }, [options.hash, options.network])

  // Subscribe to network changes
  React.useEffect(() => {
    const unsubscribe = networkDetector.subscribe(network => {
      if (!options.network) {
        // Only regenerate if not using explicit network
        const result = explorerUrlGenerator.generate(options.hash, network)
        setResult(result)
      }
    })

    return unsubscribe
  }, [options.hash])

  return result
}
```

**Features:**
- Automatic URL generation
- Network change detection
- Error callback support
- Cache-aware re-rendering

### 6. TransactionLink Component

**Purpose:** Reusable component for displaying and linking to transaction hashes.

```typescript
export interface TransactionLinkProps {
  hash: string
  abbreviated?: boolean
  network?: NetworkType
  className?: string
  onOpenExplorer?: () => void
}

export function TransactionLink({
  hash,
  abbreviated = true,
  network,
  className,
  onOpenExplorer,
}: TransactionLinkProps) {
  const result = useExplorerUrl({ hash, network })
  const displayHash = abbreviated ? abbreviateHash(hash) : hash

  // No URL available, show plain text
  if (!result || !result.url) {
    return (
      <span
        className={className}
        title={hash}
        aria-label={`Transaction hash ${hash}`}
      >
        {displayHash}
      </span>
    )
  }

  // URL available, show link
  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={hash}
      aria-label={`View transaction hash ${hash} in Stellar ${result.network} explorer`}
      onClick={() => onOpenExplorer?.()}
    >
      {displayHash}
    </a>
  )
}

function abbreviateHash(hash: string): string {
  if (hash.length <= 20) return hash
  return `${hash.substring(0, 8)}...${hash.substring(hash.length - 8)}`
}
```

**Features:**
- Configurable abbreviation
- Graceful fallback to plain text
- Semantic HTML with accessibility
- Click tracking callback
- Automatic URL generation via hook

## Data Models

### Network Type Hierarchy

```typescript
mainnet
├── stellarnet (SDF operated)
└── private networks (future)

testnet
├── Future: Multiple testnet variants

futurenet
└── Experimental protocol testing
```

### Explorer Service Priority

1. **Primary (1)**: stellar.expert (stable, well-maintained)
2. **Fallback (2+)**: Alternative explorers (if primary unavailable)

### Cache Key Format

`{network}:{transactionHash}`

Example: `mainnet:0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a`

## Error Handling Strategy

### Invalid Hash
```
User clicks link with invalid hash
  ↓
URL validation fails
  ↓
Component shows plain text (no link)
  ↓
Developer can log warning
```

### Unknown Network
```
Network detection fails
  ↓
Falls back to Testnet
  ↓
Component generates Testnet URL
  ↓
Console warning logged
```

### Network Change
```
User switches networks (runtime)
  ↓
Network detector notifies listeners
  ↓
Hook re-generates URLs with new network
  ↓
Component updates links
```

## Performance Considerations

### Caching Strategy
- Cache size: 1000 URLs
- Eviction: LRU-like (10% oldest removed when full)
- Invalidation: On network change
- Hit rate: Expected 70-90% for typical usage

### Generation Performance
- Uncached: ~0.5-1ms (hash validation + URL construction)
- Cached: <0.1ms (cache lookup)
- Overall impact on component render: Negligible

### Memory Impact
- Per cached URL: ~200 bytes (cache key + URL)
- 1000 URLs: ~200KB maximum
- Negligible compared to typical dashboard size

## Integration Points

### EventDetailsDrawer
- Wrap transaction hash in TransactionLink
- Pass `network` prop if needed

### TransactionList
- Wrap hash column with TransactionLink
- Batch render optimization possible

### Wallet Balance Display
- Display account links (future feature, similar pattern)

## Security Considerations

1. **URL Validation**: All URLs validated before use (HTTPS protocol required)
2. **Sandbox**: Links opened with `rel="noopener noreferrer"` for isolation
3. **Input Validation**: Transaction hashes validated before URL generation
4. **Logging**: No sensitive data logged (hashes are non-sensitive)

## Future Enhancements

1. **Account Links**: Extend pattern to view account details
2. **Fallback Explorers**: Switch to secondary explorer if primary unavailable
3. **Analytics**: Track which links are clicked (with user consent)
4. **Custom Explorers**: Allow users to configure custom explorer URLs
5. **Multiple Networks**: Support viewing same hash on multiple networks

