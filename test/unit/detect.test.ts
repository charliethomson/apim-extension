import { describe, expect, it } from 'vitest';
import { looksLikePolicy, rootElementName } from '../../src/parser/detect';

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

describe('rootElementName', () => {
  it('skips declarations, comments and DOCTYPE', () => {
    expect(rootElementName('<?xml version="1.0"?><!DOCTYPE x><!-- a --><configuration>')).toBe('configuration');
  });

  it('gives up on unterminated prologue and non-markup', () => {
    expect(rootElementName('<!-- never closed')).toBeUndefined();
    expect(rootElementName('hello')).toBeUndefined();
  });

  it('stays fast on files that start with many comments', () => {
    const text = '  <!-- <add key="x" value="y" /> -->\n'.repeat(200) + '<configuration />';
    const start = performance.now();
    for (let i = 0; i < 100; i++) looksLikePolicy(text);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

