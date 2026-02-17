import { describe, test, expect } from 'bun:test';
import { wrapExternalContent } from '../src/tools/types';

describe('wrapExternalContent', () => {
  test('wraps content with untrusted markers', () => {
    const result = wrapExternalContent('Hello world');
    expect(result).toBe(
      '<<<EXTERNAL_UNTRUSTED_CONTENT>>>\nHello world\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>'
    );
  });

  test('wraps empty string', () => {
    const result = wrapExternalContent('');
    expect(result).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT>>>');
    expect(result).toContain('<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>');
  });

  test('preserves multiline content', () => {
    const content = 'line1\nline2\nline3';
    const result = wrapExternalContent(content);
    expect(result).toContain(content);
    expect(result.startsWith('<<<EXTERNAL_UNTRUSTED_CONTENT>>>')).toBe(true);
    expect(result.endsWith('<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>')).toBe(true);
  });

  test('preserves special characters', () => {
    const content = '<script>alert("xss")</script> & "quotes"';
    const result = wrapExternalContent(content);
    expect(result).toContain(content);
  });
});
