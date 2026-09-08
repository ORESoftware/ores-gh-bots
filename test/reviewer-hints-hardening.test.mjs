import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  REVIEWER_HINTS_SCHEMA,
  parseReviewerHints,
} from '../packages/github/src/index.mjs';

function hint(from, source, messageId, number = 7) {
  return {
    source,
    message_id: messageId,
    from,
    subject: `[acme/widget] Review (#${number})`,
    links: [`https://github.com/acme/widget/pull/${number}`],
  };
}

test('reviewer hints accept connector mailbox forms but reject trusted-address display-name spoofing', () => {
  const result = parseReviewerHints({
    schema: REVIEWER_HINTS_SCHEMA,
    reviewer: 'the1mills',
    messages: [
      hint('GitHub <notifications@github.com>', 'gmail', 'one'),
      hint('GitHub noreply@github.com', 'proton', 'two'),
      hint('notifications@github.com attacker@example.com', 'yahoo', 'three', 8),
      hint('notifications@github.com <attacker@example.com>', 'imap', 'four', 9),
      hint('attacker@example.com <noreply@github.com>', 'imap', 'five', 10),
    ],
  }, 'the1mills');

  assert.equal(result.length, 1);
  assert.equal(result[0].prNumber, 7);
  assert.deepEqual(result[0].sources, ['email:gmail', 'email:proton']);
  assert.equal(result[0].hintIds.length, 2);
});

test('reviewer hint timestamps and schema login rules stay fail-closed and aligned', async () => {
  assert.deepEqual(parseReviewerHints({
    schema: REVIEWER_HINTS_SCHEMA,
    generated_at: '2026-09-08T15:00:00.123Z',
    messages: [],
  }, 'the1mills'), []);

  for (const generatedAt of [
    '2026-02-31T15:00:00Z',
    '2026-09-08 15:00:00Z',
    '2026-09-08T25:00:00Z',
    '2026-09-08T15:00:00+24:00',
  ]) {
    assert.throws(() => parseReviewerHints({
      schema: REVIEWER_HINTS_SCHEMA,
      generated_at: generatedAt,
      messages: [],
    }, 'the1mills'), /RFC 3339/u);
  }

  const schema = JSON.parse(await readFile(new URL('../config/reviewer-hints.schema.json', import.meta.url), 'utf8'));
  const reviewer = new RegExp(schema.properties.reviewer.pattern, 'u');
  for (const value of ['a', 'the1mills', `a${'b'.repeat(38)}`]) assert.equal(reviewer.test(value), true);
  for (const value of ['-bad', 'bad-', 'bad--name', 'x'.repeat(40)]) assert.equal(reviewer.test(value), false);
});
