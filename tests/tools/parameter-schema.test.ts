import { describe, expect, test } from 'bun:test';
import { buildParametersSchema } from '../../src/tools/parameter-schema';

describe('buildParametersSchema', () => {
  test('maps type, description, default and required', () => {
    const s = buildParametersSchema({
      q: { type: 'string', description: 'query', required: true },
      n: { type: 'integer', default: 5 },
    });
    expect(s.type).toBe('object');
    expect(s.properties.q).toEqual({ type: 'string', description: 'query' });
    expect(s.properties.n).toEqual({ type: 'integer', description: undefined, default: 5 });
    expect(s.required).toEqual(['q']);
  });

  test('no required params → required undefined; no params → empty properties', () => {
    expect(buildParametersSchema({ a: { type: 'string' } }).required).toBeUndefined();
    expect(buildParametersSchema().properties).toEqual({});
  });
});
