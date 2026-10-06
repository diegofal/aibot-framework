import { describe, expect, it } from 'bun:test';
import { ProductionsConfigSchema } from '../../src/config';

describe('ProductionsConfigSchema — autoArchive', () => {
  it('defaults to a daily auto-archive of outputs unreviewed for 7 days', () => {
    expect(ProductionsConfigSchema.parse(undefined).autoArchive).toEqual({
      enabled: true,
      staleDays: 7,
      intervalHours: 24,
    });
  });

  it('accepts an explicit switch-off and custom values', () => {
    const parsed = ProductionsConfigSchema.parse({
      autoArchive: { enabled: false, staleDays: 14, intervalHours: 12 },
    });
    expect(parsed.autoArchive).toEqual({ enabled: false, staleDays: 14, intervalHours: 12 });
  });

  it('rejects a non-positive staleDays', () => {
    expect(() => ProductionsConfigSchema.parse({ autoArchive: { staleDays: 0 } })).toThrow();
  });
});
