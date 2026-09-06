import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hoursOpen, isScheduledHour, localHourIn } from '../src/schedule.ts';
import { SCHEDULE_TIMEZONE } from '../src/config.ts';

describe('1am America/Chicago across DST', () => {
  test('during CDT (UTC-5), 06:00 UTC is 1am Chicago and 07:00 UTC is not', () => {
    assert.equal(localHourIn(SCHEDULE_TIMEZONE, new Date('2026-07-15T06:00:00Z')), 1);
    assert.equal(localHourIn(SCHEDULE_TIMEZONE, new Date('2026-07-15T07:00:00Z')), 2);
    assert.equal(isScheduledHour(new Date('2026-07-15T06:00:00Z')), true);
    assert.equal(isScheduledHour(new Date('2026-07-15T07:00:00Z')), false);
  });

  test('during CST (UTC-6), 07:00 UTC is 1am Chicago and 06:00 UTC is not', () => {
    assert.equal(localHourIn(SCHEDULE_TIMEZONE, new Date('2026-01-15T07:00:00Z')), 1);
    assert.equal(localHourIn(SCHEDULE_TIMEZONE, new Date('2026-01-15T06:00:00Z')), 0);
    assert.equal(isScheduledHour(new Date('2026-01-15T07:00:00Z')), true);
    assert.equal(isScheduledHour(new Date('2026-01-15T06:00:00Z')), false);
  });

  test('exactly one of the two cron entries fires on any given day', () => {
    for (const day of ['2026-01-15', '2026-03-08', '2026-07-15', '2026-11-01', '2026-12-31']) {
      const fires = ['06:00', '07:00'].filter((hhmm) => isScheduledHour(new Date(`${day}T${hhmm}:00Z`)));
      assert.equal(fires.length, 1, `${day} fired ${fires.length} times: ${fires.join(',')}`);
    }
  });

  test('midnight normalises to 0, not 24', () => {
    assert.equal(localHourIn(SCHEDULE_TIMEZONE, new Date('2026-07-15T05:00:00Z')), 0);
  });
});

describe('PR age', () => {
  test('computes hours open', () => {
    const now = new Date('2026-08-23T06:00:00Z');
    assert.equal(hoursOpen('2026-08-21T00:00:00Z', now), 54);
  });

  test('rejects an unparseable timestamp rather than silently returning NaN', () => {
    assert.throws(() => hoursOpen('not-a-date', new Date()), /unparseable/);
  });
});
