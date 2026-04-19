import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Ledger } from '../ledger.js';

let ledger: Ledger;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `usrcp-tamper-test-${Date.now()}.db`);
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  try {
    fs.unlinkSync(dbPath);
    fs.unlinkSync(dbPath + '-wal');
    fs.unlinkSync(dbPath + '-shm');
  } catch {}
});

describe('Tamper Counter', () => {
  it('initializes with count 0', () => {
    const state = ledger.getState(['global_preferences']);
    const gp = state.global_preferences as any;
    const tracker = gp.custom.tamperTracker as any;
    expect(tracker.count).toBe(0);
    expect(tracker.lastTamper).toBe(null);
    expect(tracker.sessionId).toBeDefined();
  });

  it('increments on decrypt fail and flags event', () => {
    // Append an event
    ledger.appendEvent({
      domain: 'test',
      summary: 'test event',
      intent: 'test intent',
      outcome: 'success',
    }, 'test_platform');

    // Corrupt the summary field
    const event = ledger.getTimeline({ last_n: 1 })[0];
    const row = ledger.db.prepare('SELECT summary FROM timeline_events WHERE event_id = ?').get(event.event_id) as any;
    const parts = row.summary.split(':');
    const buf = Buffer.from(parts[1], 'base64');
    buf[buf.length - 16] ^= 0xff; // Corrupt auth tag
    const tampered = 'enc:' + buf.toString('base64');
    ledger.db.prepare('UPDATE timeline_events SET summary = ? WHERE event_id = ?').run(tampered, event.event_id);

    // Read back
    const timeline = ledger.getTimeline({ last_n: 1 });
    expect(timeline[0].summary).toBe('[TAMPERED]');
    expect(timeline[0].tampered).toBe(true);

    // Check tracker incremented
    const state = ledger.getState(['global_preferences']);
    const gp = state.global_preferences as any;
    const tracker = gp.custom.tamperTracker as any;
    expect(tracker.count).toBe(1);
    expect(tracker.lastTamper).toBeDefined();
  });

  it('logs tamper to audit log', () => {
    // Sim tamper as above
    ledger.appendEvent({
      domain: 'test',
      summary: 'test event',
      intent: 'test intent',
      outcome: 'success',
    }, 'test_platform');

    const event = ledger.getTimeline({ last_n: 1 })[0];
    const row = ledger.db.prepare('SELECT summary FROM timeline_events WHERE event_id = ?').get(event.event_id) as any;
    const parts = row.summary.split(':');
    const buf = Buffer.from(parts[1], 'base64');
    buf[buf.length - 16] ^= 0xff;
    const tampered = 'enc:' + buf.toString('base64');
    ledger.db.prepare('UPDATE timeline_events SET summary = ? WHERE event_id = ?').run(tampered, event.event_id);

    ledger.getTimeline({ last_n: 1 });

    const audit = ledger.getAuditLog();
    const tamperLog = audit.find((a: any) => a.operation === 'tamper_detected');
    expect(tamperLog).toBeDefined();
    expect(tamperLog.detail).toContain('count=1');
  });

  it('throws on excessive tampers (>5)', () => {
    for (let i = 0; i < 6; i++) {
      ledger.appendEvent({
        domain: 'test',
        summary: `event ${i}`,
        intent: 'intent',
        outcome: 'success',
      }, 'test');
    }

    for (let i = 0; i < 6; i++) {
      const event = ledger.getTimeline({ last_n: 6 })[i];
      const row = ledger.db.prepare('SELECT detail FROM timeline_events WHERE event_id = ?').get(event.event_id) as any;
      const parts = row.detail.split(':');
      const buf = Buffer.from(parts[1], 'base64');
      buf[buf.length - 16] ^= 0xff;
      const tampered = 'enc:' + buf.toString('base64');
      ledger.db.prepare('UPDATE timeline_events SET detail = ? WHERE event_id = ?').run(tampered, event.event_id);
    }

    // First 5 should not throw
    for (let i = 0; i < 5; i++) {
      const timeline = ledger.getTimeline({ last_n: 6 });
      expect(timeline.length).toBe(6);
    }

    // 6th should throw
    expect(() => {
      ledger.getTimeline({ last_n: 6 });
    }).toThrow('Excessive tampering');
  });

  it('detects audit integrity fail and increments counter', () => {
    // Append event to create audit log
    ledger.appendEvent({
      domain: 'test',
      summary: 'test',
      intent: 'test',
      outcome: 'success',
    }, 'test');

    // Get the latest audit entry
    const audit = ledger.getAuditLog(1);
    const entry = audit[0];

    // Corrupt integrity_tag
    const tagParts = entry.integrity_tag.split(':');
    const buf = Buffer.from(tagParts[1], 'base64');
    buf[0] ^= 0xff;
    const tamperedTag = 'enc:' + buf.toString('base64');
    ledger.db.prepare('UPDATE audit_log SET integrity_tag = ? WHERE id = ?').run(tamperedTag, entry.id);

    // Now getAuditLog
    const newAudit = ledger.getAuditLog();
    const newEntry = newAudit.find((a: any) => a.id === entry.id);
    expect(newEntry.integrity_verified).toBe(false);
    expect(newEntry.tampered).toBe(true);

    // Check tracker
    const state = ledger.getState(['global_preferences']);
    const gp = state.global_preferences as any;
    const tracker = gp.custom.tamperTracker as any;
    expect(tracker.count).toBe(1);
  });

  it('resets tamper counter on key rotation', () => {
    // Sim 3 tampers
    for (let i = 0; i < 3; i++) {
      ledger.appendEvent({
        domain: 'test',
        summary: `tamper ${i}`,
        intent: 'test',
        outcome: 'success',
      }, 'test');

      const event = ledger.getTimeline({ last_n: 1 })[0];
      const row = ledger.db.prepare('SELECT summary FROM timeline_events WHERE event_id = ?').get(event.event_id) as any;
      const parts = row.summary.split(':');
      const buf = Buffer.from(parts[1], 'base64');
      buf[buf.length - 16] ^= 0xff;
      const tampered = 'enc:' + buf.toString('base64');
      ledger.db.prepare('UPDATE timeline_events SET summary = ? WHERE event_id = ?').run(tampered, event.event_id);

      ledger.getTimeline({ last_n: 1 });
    }

    // Check count = 3
    const state1 = ledger.getState(['global_preferences']);
    const gp1 = state1.global_preferences as any;
    const tracker1 = gp1.custom.tamperTracker as any;
    expect(tracker1.count).toBe(3);

    // Rotate key
    ledger.rotateKey();

    // Check count = 0
    const state2 = ledger.getState(['global_preferences']);
    const gp2 = state2.global_preferences as any;
    const tracker2 = gp2.custom.tamperTracker as any;
    expect(tracker2.count).toBe(0);
    expect(tracker2.lastTamper).toBe(null);

    // Verify rotation log
    const audit = ledger.getAuditLog();
    const rotationLog = audit.find((a: any) => a.operation === 'key_rotation');
    expect(rotationLog).toBeDefined();
  });
});