import * as sqlite3 from 'sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger';

/** How long a write waits for a competing connection's lock before failing. */
export const DATABASE_BUSY_TIMEOUT_MS = 5_000;

/**
 * SQLite Database Service
 * Handles all database operations with promise-based interface
 */
export interface DatabaseRecoveryOptions {
  /** Max reconnect attempts per operation after a detected connection failure. Default 3. */
  maxReconnectAttempts?: number;
  /** Base delay for exponential backoff between reconnect attempts, in ms. Default 100. */
  reconnectBaseDelayMs?: number;
}

export class Database {
  private db: sqlite3.Database | null = null;
  private dbPath: string;
  private isInitialized: boolean = false;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  /** True while a transaction is open; recovery never fires mid-transaction. */
  private inTransaction: boolean = false;

  constructor(dbPath: string = './data/notifications.db', recovery: DatabaseRecoveryOptions = {}) {
    this.dbPath = dbPath;
    this.maxReconnectAttempts = Math.max(0, recovery.maxReconnectAttempts ?? 3);
    this.reconnectBaseDelayMs = Math.max(0, recovery.reconnectBaseDelayMs ?? 100);
  }

  /**
   * Whether an error looks like a lost/unusable connection rather than a
   * data or constraint problem. Only these trigger recovery - retrying a
   * constraint violation or syntax error would just fail again.
   */
  private isConnectionError(err: any): boolean {
    if (!err) return false;
    const code = err.code || err.errno;
    if (typeof code === 'string') {
      if (['SQLITE_IOERR', 'SQLITE_CANTOPEN', 'SQLITE_NOTADB', 'SQLITE_MISUSE'].includes(code)) {
        return true;
      }
    }
    const message = String(err.message || err);
    return /closed|no such database|unable to open|disk i\/o error|not a database/i.test(message);
  }

  /**
   * Close the stale handle (best-effort) and open a fresh one.
   */
  private async reconnect(): Promise<void> {
    const stale = this.db;
    this.db = null;
    if (stale) {
      await new Promise<void>((resolve) => {
        try {
          stale.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    await this.connect();
    logger.warn('Database connection recovered', { path: this.dbPath });
  }

  /**
   * Run an operation with bounded connection recovery.
   *
   * On a detected connection failure the handle is re-opened with
   * exponential backoff and the operation retried once per successful
   * reconnect, up to maxReconnectAttempts. Data errors (constraints,
   * syntax) propagate immediately without any reconnect attempt, and no
   * recovery happens while a transaction is open (see transaction()).
   */
  private async executeWithRecovery<T>(op: () => Promise<T>): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= this.maxReconnectAttempts; attempt++) {
      try {
        if (!this.db) {
          if (!this.isInitialized) throw new Error('Database not initialized');
          await this.reconnect();
        }
        return await op();
      } catch (err) {
        lastError = err;
        if (this.inTransaction || !this.isConnectionError(err)) {
          throw err;
        }
        if (attempt < this.maxReconnectAttempts) {
          const delayMs = this.reconnectBaseDelayMs * Math.pow(2, attempt);
          logger.warn('Database connection failure detected; attempting recovery', {
            path: this.dbPath,
            attempt: attempt + 1,
            maxReconnectAttempts: this.maxReconnectAttempts,
            delayMs,
            error: String((err as any)?.message || err),
          });
          try {
            await new Promise((r) => setTimeout(r, delayMs));
            await this.reconnect();
          } catch (reconnectErr) {
            lastError = reconnectErr;
            logger.error('Database reconnect attempt failed', {
              path: this.dbPath,
              attempt: attempt + 1,
              error: String((reconnectErr as any)?.message || reconnectErr),
            });
            continue;
          }
        }
      }
    }
    throw lastError;
  }

  /**
   * Initialize database connection and run migrations
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      await this.applyIncrementalMigrations();
      return;
    }

    try {
      // Ensure data directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        logger.info('Created database directory', { path: dbDir });
      }

      // Open database connection
      await this.connect();

      // Run schema migrations
      await this.runMigrations();

      this.isInitialized = true;
      logger.info('Database initialized successfully', { path: this.dbPath });
    } catch (error) {
      logger.error('Failed to initialize database', { error, path: this.dbPath });
      throw error;
    }
  }

  /**
   * Connect to SQLite database
   */
  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Assign the handle only after a successful open: a handle whose open
      // failed can never be closed reliably, and leaving it in this.db
      // would wedge the recovery path.
      const handle = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          logger.error('Failed to connect to database', { error: err, path: this.dbPath });
          try {
            handle.close(() => undefined);
          } catch {
            // best-effort cleanup of a handle that never opened
          }
          reject(err);
        } else {
          this.db = handle;
          logger.info('Connected to SQLite database', { path: this.dbPath });
          // Wait (instead of failing with SQLITE_BUSY) when another connection
          // — e.g. a second listener instance on the same file — holds the
          // write lock. Without this, contended atomic claims would error and
          // fail open, re-introducing duplicate event processing.
          this.db!.configure('busyTimeout', DATABASE_BUSY_TIMEOUT_MS);
          // Enable foreign keys
          handle.run('PRAGMA foreign_keys = ON', (pragmaErr) => {
            if (pragmaErr) {
              reject(pragmaErr);
            } else {
              resolve();
            }
          });
        }
      });
    });
  }

  /**
   * Run database migrations from schema.sql
   */
  private async runMigrations(): Promise<void> {
    const schemaPath = path.join(__dirname, 'schema.sql');
    
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Schema file not found: ${schemaPath}`);
    }

    const schema = fs.readFileSync(schemaPath, 'utf-8');

    // Execute the schema as one script so trigger bodies with semicolons work.
    await this.exec(schema);

    await this.applyIncrementalMigrations();

    logger.info('Database migrations completed');
  }

  /**
   * Split SQL statements intelligently, preserving BEGIN...END blocks
   */
  private splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inBeginBlock = false;
    
    const lines = sql.split(/\r?\n/);
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Check for BEGIN keyword (case insensitive)
      if (/^\s*BEGIN\s*$/i.test(trimmed)) {
        inBeginBlock = true;
      }
      
      current += line + '\n';
      
      // Check for END; which closes the BEGIN block
      if (inBeginBlock && /^\s*END\s*;/i.test(trimmed)) {
        inBeginBlock = false;
        statements.push(current.trim());
        current = '';
        continue;
      }
      
      // If not in BEGIN block and line ends with semicolon, it's a complete statement
      if (!inBeginBlock && trimmed.endsWith(';')) {
        statements.push(current.trim());
        current = '';
      }
    }
    
    // Add any remaining content
    if (current.trim().length > 0) {
      statements.push(current.trim());
    }
    
    return statements.filter(s => s.length > 0 && !s.startsWith('--'));
  }

  /**
   * Apply migrations for databases created before schema.sql was updated in-place.
   */

  private async applyIncrementalMigrations(): Promise<void> {
    try {
      await this.run('ALTER TABLE scheduled_notifications ADD COLUMN next_retry_at DATETIME');
    } catch (error: any) {
      // Completely ignore ALL errors here. SQLite might complain the column exists.
      return;
    }
  }

  /**
   * Execute a SQL query that modifies data (INSERT, UPDATE, DELETE)
   */
  async run(sql: string, params: any[] = []): Promise<{ lastID: number; changes: number }> {
    return this.executeWithRecovery(
      () =>
        new Promise((resolve, reject) => {
          this.db!.run(sql, params, function (err) {
            if (err) {
              logger.error('Database run error', { sql, params, error: err });
              reject(err);
            } else {
              resolve({ lastID: this.lastID, changes: this.changes });
            }
          });
        })
    );
  }

  /**
   * Execute a SQL query that returns a single row (SELECT)
   */
  async get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
    return this.executeWithRecovery(
      () =>
        new Promise((resolve, reject) => {
          this.db!.get(sql, params, (err, row) => {
            if (err) {
              logger.error('Database get error', { sql, params, error: err });
              reject(err);
            } else {
              resolve(row as T);
            }
          });
        })
    );
  }

  /**
   * Execute a SQL query that returns multiple rows (SELECT)
   */
  async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return this.executeWithRecovery(
      () =>
        new Promise((resolve, reject) => {
          this.db!.all(sql, params, (err, rows) => {
            if (err) {
              logger.error('Database all error', { sql, params, error: err });
              reject(err);
            } else {
              resolve(rows as T[]);
            }
          });
        })
    );
  }

  /**
   * Execute a SQL script that may contain multiple statements.
   */
  async exec(sql: string): Promise<void> {
    return this.executeWithRecovery(
      () =>
        new Promise((resolve, reject) => {
          this.db!.exec(sql, (err) => {
            if (err) {
              logger.error('Database exec error', { sql, error: err });
              reject(err);
            } else {
              resolve();
            }
          });
        })
    );
  }

  /**
   * Execute multiple statements in a transaction
   */
  async transaction(callback: () => Promise<void>): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Recovery is suspended for the whole transaction: a mid-transaction
    // reconnect would lose the transaction silently, so any failure rolls
    // back and propagates to the caller instead.
    this.inTransaction = true;
    try {
      await this.run('BEGIN TRANSACTION');
      await callback();
      await this.run('COMMIT');
    } catch (error) {
      try {
        await this.run('ROLLBACK');
      } catch (rollbackError) {
        logger.error('Rollback failed after transaction error', { error: rollbackError });
      }
      logger.error('Transaction rolled back', { error });
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      this.db!.close((err) => {
        if (err) {
          logger.error('Failed to close database', { error: err });
          reject(err);
        } else {
          logger.info('Database connection closed');
          this.db = null;
          this.isInitialized = false;
          resolve();
        }
      });
    });
  }

  /**
   * Get database connection status
   */
  isConnected(): boolean {
    return this.isInitialized && this.db !== null;
  }
}

// Singleton instance
let dbInstance: Database | null = null;

/**
 * Reset the database singleton (for tests).
 */
export async function resetDatabaseSingleton(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Get or create database singleton instance
 */
export function getDatabase(dbPath?: string): Database {
  if (!dbInstance) {
    const finalPath = dbPath || process.env.DATABASE_PATH || './data/notifications.db';
    dbInstance = new Database(finalPath);
  }
  return dbInstance;
}

/**
 * Initialize database (should be called on application startup)
 */
export async function initializeDatabase(dbPath?: string): Promise<Database> {
  const db = getDatabase(dbPath);
  await db.initialize();
  return db;
}
