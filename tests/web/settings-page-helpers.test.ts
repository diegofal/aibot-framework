import { describe, expect, it } from 'bun:test';
import { ccliModelSelect } from '../../web/pages/settings-helpers.js';

const OPTIONS = [
  { value: '', label: 'CLI default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

describe('ccliModelSelect', () => {
  it('renders a <select>, not a text input', () => {
    const html = ccliModelSelect({ availableModels: OPTIONS, model: '' });
    expect(html).toContain('<select id="ccli-model">');
    expect(html).not.toContain('type="text"');
  });

  it('marks the current model selected', () => {
    const html = ccliModelSelect({ availableModels: OPTIONS, model: 'opus' });
    expect(html).toContain('value="opus" selected');
  });

  it('defaults to the empty/CLI-default option when no model is set', () => {
    const html = ccliModelSelect({ availableModels: OPTIONS, model: '' });
    expect(html).toContain('value="" selected');
  });

  it('keeps a saved value outside the known list as a selected custom option', () => {
    const html = ccliModelSelect({
      availableModels: OPTIONS,
      model: 'claude-sonnet-4-5-20251022',
    });
    expect(html).toContain('claude-sonnet-4-5-20251022 (custom)');
    expect(html).toContain('value="claude-sonnet-4-5-20251022" selected');
    // exactly one option carries `selected` — the custom one, not opus/sonnet/etc.
    expect((html.match(/selected/g) || []).length).toBe(1);
  });

  it('falls back to a single "CLI default" option when availableModels is missing', () => {
    const html = ccliModelSelect({ model: '' });
    expect(html).toContain('CLI default');
  });

  it('escapes a hostile custom model value', () => {
    const html = ccliModelSelect({ availableModels: OPTIONS, model: '"><script>1</script>' });
    expect(html).not.toContain('<script>');
  });
});
