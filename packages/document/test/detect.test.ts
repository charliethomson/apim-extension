import { describe, expect, it } from 'vitest';
import { looksLikePolicy, rootElementName, scanRoot } from '../src/detect';

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

  it('finds the root past a header longer than 4 KB', () => {
    const header = `<!--\n${'    @property {string} x  A line of header.\n'.repeat(200)}-->\n`;
    expect(header.length).toBeGreaterThan(4096);
    expect(looksLikePolicy(`${header}<fragment />`)).toBe(true);
  });

  it('says when the text ran out inside the prologue', () => {
    expect(scanRoot('<!-- still going')).toEqual({ more: true });
    expect(scanRoot('<!-- done --> <fragment>')).toEqual({ name: 'fragment', more: false });
    expect(scanRoot('hello').more).toBe(false);
    expect(scanRoot('<!-- long', 4).more).toBe(false);
  });

  it('stays fast on files that start with many comments', () => {
    const text = '  <!-- <add key="x" value="y" /> -->\n'.repeat(200) + '<configuration />';
    const start = performance.now();
    for (let i = 0; i < 100; i++) looksLikePolicy(text);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

