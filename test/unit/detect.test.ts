import { describe, expect, it } from 'vitest';
import { looksLikePolicy } from '../../src/parser/detect';

describe('looksLikePolicy', () => {
  it.each([
    '<policies>',
    '<fragment/>',
    '﻿<?xml version="1.0"?>\n<!-- c -->\n<!-- d -->\n  <policies >',
  ])('accepts %j', (s) => expect(looksLikePolicy(s)).toBe(true));

  it.each(['<project>', '<policiesx>', 'text <policies>', '<root><policies/></root>', ''])('rejects %j', (s) =>
    expect(looksLikePolicy(s)).toBe(false),
  );
});
