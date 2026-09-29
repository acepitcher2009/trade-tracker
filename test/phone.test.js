import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, formatPhone } from '../shared/phone.js';
import { hashPin, verifyPin } from '../shared/pin.js';

test('three formats resolve to the same digits', () => {
  for (const s of ['(979) 555-1234', '979-555-1234', '+1 979 555 1234', '19795551234', '979.555.1234']) {
    assert.equal(normalizePhone(s), '9795551234', s);
  }
});
test('invalid numbers return null', () => {
  for (const s of ['', null, '555-1234', '29795551234', '1234']) assert.equal(normalizePhone(s), null, String(s));
});
test('formatPhone', () => assert.equal(formatPhone('9794921302'), '(979) 492-1302'));
test('pin hash/verify', () => {
  const h = hashPin('123456');
  assert.ok(verifyPin('123456', h));
  assert.ok(!verifyPin('654321', h));
  assert.throws(() => hashPin('1234'));
});
