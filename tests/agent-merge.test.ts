import { expect, test } from 'bun:test';
import { mergeUndo } from '../backend/agent-merge';
const bytes = (s: string) => Buffer.from(s);

test('undo removes only the agent change while preserving a non-overlapping user edit and CRLF', () => {
  const before = bytes('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
  const after = bytes('ONE\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
  const current = bytes('ONE\r\ntwo\r\nthree\r\nfour\r\nFIVE\r\n');
  expect(mergeUndo(before, after, current)).toEqual(bytes('one\r\ntwo\r\nthree\r\nfour\r\nFIVE\r\n'));
});

test('overlapping edits return a conflict, never conflict markers or a partial result', () => {
  expect(() => mergeUndo(bytes('one\ntwo\n'), bytes('ONE\ntwo\n'), bytes('USER\ntwo\n'))).toThrow(/overlap/);
});

test('exact originals preserve non-UTF8 bytes, empty files and file absence without a text merge', () => {
  const raw = Buffer.from([0, 255, 13, 10]);
  expect(mergeUndo(raw, bytes('after'), bytes('after'))).toEqual(raw);
  expect(mergeUndo(null, bytes('created'), bytes('created'))).toBeNull();
  expect(mergeUndo(raw, null, null)).toEqual(raw);
  expect(mergeUndo(bytes(''), bytes('after'), bytes('after'))).toEqual(bytes(''));
});

test('edited new files, recreated deleted files, binary and malformed UTF8 all refuse unsafe merging', () => {
  expect(() => mergeUndo(null, bytes('created'), bytes('user edit'))).toThrow();
  expect(() => mergeUndo(bytes('original'), null, bytes('user recreation'))).toThrow();
  expect(() => mergeUndo(Buffer.from([0, 1]), Buffer.from([0, 2]), Buffer.from([0, 3]))).toThrow();
  expect(() => mergeUndo(Buffer.from([255]), bytes('a'), bytes('b'))).toThrow();
});

test('user insertions and missing final newlines are preserved', () => {
  const before = bytes('one\ntwo\nthree\nfour\nfive');
  const after = bytes('ONE\ntwo\nthree\nfour\nfive');
  expect(mergeUndo(before, after, bytes('ONE\ntwo\nthree\nfour\nfive\nuser'))).toEqual(bytes('one\ntwo\nthree\nfour\nfive\nuser'));
});
