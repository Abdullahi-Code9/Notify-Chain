// Exercise emitted JavaScript and real dependencies; Jest's module doubles do
// not validate the native SQLite binding or Node's runtime APIs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
  NotificationClaimLease,
  calculateLeaseRenewIntervalMs,
} = require('../dist/services/notification-claim-lease.js');

test('compiled listener lease renews and stops after ownership is lost', async () => {
  let owned = true;
  const calls = [];
  const lease = new NotificationClaimLease({
    notificationId: 7,
    processorId: 'compat-worker',
    lockTimeoutMs: 30000,
    renew: async (...args) => {
      calls.push(args);
      return owned;
    },
  });
  assert.equal(calculateLeaseRenewIntervalMs(30000), 10000);
  try {
    assert.equal(await lease.heartbeatNow(), true);
    owned = false;
    assert.equal(await lease.heartbeatNow(), false);
    assert.equal(lease.isLeaseLost(), true);
    assert.equal(await lease.heartbeatNow(), false);
    assert.deepEqual(calls, [
      [7, 'compat-worker', 30000],
      [7, 'compat-worker', 30000],
    ]);
  } finally {
    await lease.stop();
  }
});

test('native SQLite, Express and fetch work together on the selected Node version', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  let server;
  try {
    await db.exec('CREATE TABLE notifications (id INTEGER PRIMARY KEY, status TEXT NOT NULL)');
    await db.run('INSERT INTO notifications (status) VALUES (?)', 'PENDING');
    const app = express();
    app.get('/notifications/:id', async (req, res, next) => {
      try {
        const row = await db.get('SELECT * FROM notifications WHERE id = ?', req.params.id);
        res.json(row);
      } catch (error) {
        next(error);
      }
    });
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/notifications/1`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 1, status: 'PENDING' });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await db.close();
  }
});
