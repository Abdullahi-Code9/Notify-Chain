# Requirements Document: Stellar Explorer Navigation

## Introduction

The dashboard currently displays Stellar network transaction hashes without providing users a direct way to view transaction details on blockchain explorers. This feature enables users to navigate from transaction hashes to the appropriate Stellar network explorer (Mainnet, Testnet, or Futurenet) based on the configured network. The feature must dynamically determine the network configuration, generate the correct explorer URL, and safely open the explorer in a new browser tab without hard-coding network-specific URLs.

## Glossary

- **Stellar Network**: A blockchain network operated by the Stellar Development Foundation (Mainnet, Testnet, or Futurenet)
- **Transaction Hash**: A 64-character hexadecimal identifier uniquely identifying a transaction on the Stellar network
- **Explorer**: A web-based interface for viewing blockchain transaction details and account information
- **Network Configuration**: The environment setting that determines which Stellar network the dashboard connects to
- **Explorer URL**: The web address that displays transaction details for a given transaction hash on a specific network
- **URL Validation**: The process of ensuring generated explorer URLs are correctly formatted and accessible
- **Safe Navigation**: Opening URLs in a new browser tab without allowing the opened page to access the original page's context (using `rel="noopener noreferrer"`)
- **Mainnet**: The primary production Stellar network
- **Testnet**: The test/staging Stellar network for development and testing
- **Futurenet**: The experimental Stellar network for testing new protocol features
- **Network Detection**: The process of reading the configured network from application settings or environment variables
- **Explorer_Router**: The system component responsible for generating appropriate explorer URLs based on network configuration
- **Transaction_Link**: A UI component that displays a transaction hash and provides navigation to the explorer

## Requirements

### Requirement 1: Detect Configured Stellar Network

**User Story:** As a system, I want to automatically detect which Stellar network is configured, so that I can generate the correct explorer URL without manual configuration.

#### Acceptance Criteria

1. WHEN the dashboard initializes, THE Explorer_Router SHALL read the configured network from application settings or environment variables
2. WHEN the configured network is "mainnet", THE Explorer_Router SHALL identify it as Mainnet
3. WHEN the configured network is "testnet", THE Explorer_Router SHALL identify it as Testnet
4. WHEN the configured network is "futurenet", THE Explorer_Router SHALL identify it as Futurenet
5. WHEN the network configuration is missing or invalid, THE Explorer_Router SHALL default to Testnet or fail gracefully with an error
6. WHEN the dashboard connects to multiple networks (future feature), THE Explorer_Router SHALL detect the current active network
7. WHEN network configuration changes at runtime, THE Explorer_Router SHALL reflect the new network in generated URLs

### Requirement 2: Generate Network-Specific Explorer URLs

**User Story:** As a developer, I want the system to generate appropriate explorer URLs dynamically, so that I don't need to hard-code network-specific URLs in the codebase.

#### Acceptance Criteria

1. WHEN a Mainnet transaction hash is provided, THE Explorer_Router SHALL generate URL to Mainnet explorer (stellar.expert or equivalent)
2. WHEN a Testnet transaction hash is provided, THE Explorer_Router SHALL generate URL to Testnet explorer
3. WHEN a Futurenet transaction hash is provided, THE Explorer_Router SHALL generate URL to Futurenet explorer
4. WHEN a transaction hash is provided, THE Explorer_Router SHALL construct the URL as `{explorerBaseUrl}/tx/{transactionHash}`
5. THE Explorer_Router SHALL NOT hard-code network URLs in code; instead use a configuration file or constants module
6. WHEN a URL is generated, THE Explorer_Router SHALL append the correct URL path for transactions (not accounts or other entity types)
7. WHEN the explorer domain changes, THE configuration SHALL be easily updatable without code changes

### Requirement 3: Validate Transaction Hash Format

**User Story:** As the system, I want to validate transaction hashes before generating explorer URLs, so that invalid hashes don't create broken explorer links.

#### Acceptance Criteria

1. WHEN a transaction hash is provided to the Explorer_Router, THE system SHALL validate it is a 64-character hexadecimal string
2. WHEN a transaction hash is invalid (not 64 characters), THE Explorer_Router SHALL reject it with a validation error
3. WHEN a transaction hash contains non-hexadecimal characters, THE Explorer_Router SHALL reject it with a validation error
4. WHEN a transaction hash is null or undefined, THE Explorer_Router SHALL reject it with a clear error message
5. WHEN a transaction hash validation fails, the system SHALL NOT generate a URL or create a broken link
6. WHEN a transaction hash passes validation, THE Explorer_Router SHALL proceed with URL generation

### Requirement 4: Open Explorer URLs Safely

**User Story:** As a user, I want transaction hash links to open safely in a new browser tab, so that I don't lose my dashboard context.

#### Acceptance Criteria

1. WHEN a user clicks a transaction hash link, THE browser SHALL open the explorer page in a new tab (not replace the current page)
2. WHEN a transaction hash link opens a new tab, THE link SHALL use `target="_blank"` attribute
3. WHEN a transaction hash link opens a new tab, THE link SHALL include `rel="noopener noreferrer"` to prevent security vulnerabilities
4. WHEN the explorer URL is opened, the opened page SHALL NOT be able to access the dashboard's `window` object
5. WHEN a user clicks the link, the dashboard page SHALL remain unchanged and accessible
6. WHEN the explorer page opens, THE dashboard SHALL remain in the background ready for user interaction

### Requirement 5: Display Readable Transaction Hash Links

**User Story:** As a user, I want transaction hash links to be easy to identify and click, so that I can quickly navigate to the explorer.

#### Acceptance Criteria

1. THE Transaction_Link component SHALL display the transaction hash in a visually distinct way (e.g., monospace font, link styling)
2. WHEN a transaction hash is displayed, THE Transaction_Link component SHALL abbreviate long hashes (first 8 + "..." + last 8 characters)
3. THE Transaction_Link component SHALL display the full transaction hash in a tooltip on hover
4. THE Transaction_Link component SHALL use the `<a>` tag with proper `href` attribute for semantics and accessibility
5. WHEN a user hovers over a transaction hash link, cursor SHALL change to pointer
6. THE link color SHALL follow design system conventions (typically blue or branded color with underline)

### Requirement 6: Handle Unsupported Networks Gracefully

**User Story:** As the system, I want unsupported or unknown networks to be handled gracefully, so that the dashboard doesn't break when encountering unexpected network configurations.

#### Acceptance Criteria

1. WHEN a network configuration is not recognized (not mainnet, testnet, or futurenet), THE system SHALL log a warning
2. WHEN an unsupported network is encountered, THE Explorer_Router SHALL either default to a fallback network or disable the explorer link
3. WHEN explorer URL generation fails, THE Transaction_Link component SHALL display the transaction hash as plain text (not clickable)
4. WHEN explorer URL generation fails, the user interface SHALL NOT show error messages (graceful degradation)
5. WHEN an unsupported network is detected, the system MAY display a console warning for developers
6. WHEN the system recovers from network detection failure, the explorer link SHALL become functional again

### Requirement 7: Support Multiple Explorer Services

**User Story:** As a future-proofing measure, I want the system to support multiple explorer services, so that if one explorer goes offline, we can switch to an alternative.

#### Acceptance Criteria

1. WHEN the system generates explorer URLs, THE configuration SHALL specify the primary explorer service (e.g., stellar.expert)
2. THE configuration SHALL support defining multiple explorer services per network (primary and fallback)
3. WHEN the primary explorer is unavailable, the system MAY switch to a secondary explorer (optional feature for MVP)
4. THE URL generation logic SHALL be abstracted to support easy addition of new explorer services
5. WHEN a new explorer service is added, it SHALL only require configuration changes, not code changes

### Requirement 8: Validate Generated URLs

**User Story:** As the system, I want to validate generated explorer URLs before using them, so that malformed URLs don't create broken links.

#### Acceptance Criteria

1. WHEN an explorer URL is generated, THE system SHALL validate it is a valid URL format using URL constructor or validator
2. WHEN a URL validation fails, THE system SHALL reject the URL and not create a link
3. WHEN a transaction hash is 64 characters hexadecimal, the generated URL SHALL always pass validation
4. WHEN a URL is generated, it SHALL start with `https://` (secure protocol only)
5. WHEN a URL contains query parameters, they SHALL be properly URL-encoded
6. WHEN a URL is validated successfully, the system SHALL be confident the link will not 404 (assuming explorer service is online)

### Requirement 9: Integrate Links into Dashboard

**User Story:** As a developer, I want to easily add explorer links to any transaction hash displayed in the dashboard, so that users can access explorers from multiple views.

#### Acceptance Criteria

1. THE Transaction_Link component SHALL be reusable across all dashboard pages (EventDetailsDrawer, TransactionList, etc.)
2. WHEN a transaction hash is displayed in any dashboard component, developers SHALL wrap it with Transaction_Link component
3. THE Transaction_Link component SHALL accept transaction hash as a prop
4. THE Transaction_Link component SHALL accept optional formatting options (e.g., abbreviation, full display)
5. WHEN Transaction_Link is used, the component SHALL automatically detect the network configuration and generate correct URLs
6. THE Transaction_Link component SHALL work consistently across all browser types and devices

### Requirement 10: Support Keyboard Navigation to Explorer

**User Story:** As a keyboard user, I want to navigate to the explorer using keyboard only, so that I can browse the dashboard without a mouse.

#### Acceptance Criteria

1. WHEN a Transaction_Link is focused with Tab key, it SHALL be visually focused (outline or background change)
2. WHEN a Transaction_Link is focused, pressing Enter SHALL open the explorer page in a new tab
3. WHEN a Transaction_Link is focused, the cursor focus SHALL remain on the link (not move to the new window)
4. WHEN a Transaction_Link is accessed via keyboard, the link color or styling SHALL indicate it's keyboard-focusable
5. THE link SHALL include `aria-label` or title attribute describing the action (e.g., "View transaction hash {hash} in Stellar explorer")

### Requirement 11: Handle Network Configuration Changes

**User Story:** As an operator, I want the system to adapt when network configuration changes, so that explorer links always point to the correct network.

#### Acceptance Criteria

1. WHEN network configuration changes at runtime, THE Explorer_Router SHALL update generated URLs to reflect the new network
2. WHEN an existing Transaction_Link receives a network change event, it SHALL re-generate its URL automatically
3. WHEN the dashboard switches from Testnet to Mainnet, all explorer links SHALL immediately point to Mainnet explorer
4. WHEN network configuration is updated, THE dashboard SHALL NOT need to reload for links to work correctly
5. WHEN querying previously viewed transactions after network change, links SHALL point to the correct network

### Requirement 12: Cache Explorer Configuration

**User Story:** As the system, I want to cache network configuration and explorer URLs, so that performance is optimized and repeated URL generation is avoided.

#### Acceptance Criteria

1. WHEN network configuration is read, it SHALL be cached to avoid repeated file/variable reads
2. WHEN a transaction hash is processed, previously generated URLs for the same hash SHALL be retrieved from cache
3. WHEN network configuration changes, the cached URLs SHALL be invalidated and regenerated
4. WHEN the cache grows large, old entries SHALL be periodically cleared to prevent memory bloat
5. THE cache expiration policy SHALL be documented and configurable
6. WHEN cache hit occurs, URL generation SHALL complete in < 1ms (significantly faster than uncached generation)

### Requirement 13: Log and Monitor URL Generation

**User Story:** As an operator, I want visibility into explorer URL generation for debugging, so that I can troubleshoot broken links or configuration issues.

#### Acceptance Criteria

1. WHEN a transaction hash is processed, the system SHALL log the network detection result
2. WHEN an explorer URL is generated, the system SHALL log the generated URL at debug level
3. WHEN URL validation fails, the system SHALL log the failure with the reason (e.g., "Invalid hash format")
4. WHEN network configuration is unknown, the system SHALL log a warning with the unrecognized network value
5. WHEN explorer links are clicked, the system MAY log telemetry for analytics (optional)
6. ALL logs related to URL generation SHALL NOT expose sensitive information (hashes are acceptable, API keys are not)

### Requirement 14: Support Future Protocol Upgrades

**User Story:** As a developer, I want the system to support future Stellar network changes, so that when Stellar updates its protocol, the dashboard adapts easily.

#### Acceptance Criteria

1. WHEN a new Stellar network is introduced, THE configuration SHALL be updatable to include it
2. WHEN explorer services update their URL formats, THE URL generation logic SHALL be easily updatable
3. WHEN Stellar introduces new transaction types, THE system SHALL still generate valid explorer links
4. THE URL generation logic SHALL be version-agnostic (not tied to specific Stellar protocol versions)
5. WHEN system is updated for new networks, existing code using Transaction_Link SHALL continue to work without changes

### Requirement 15: Provide Developer Documentation

**User Story:** As a developer, I want clear documentation on how to use explorer links, so that I can integrate them correctly in the dashboard.

#### Acceptance Criteria

1. THE repository SHALL document supported Stellar networks (Mainnet, Testnet, Futurenet)
2. THE repository SHALL document how to configure the explorer service URL
3. WHEN a developer needs to add a transaction link, documentation SHALL show example code
4. THE documentation SHALL explain how network detection works
5. THE documentation SHALL explain URL validation and error handling
6. THE documentation SHALL include examples of Transaction_Link component usage

