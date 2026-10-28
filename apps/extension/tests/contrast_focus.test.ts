import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sRGBtoLin(colorChannel: number): number {
  if (colorChannel <= 0.04045) return colorChannel / 12.92;
  return Math.pow((colorChannel + 0.055) / 1.055, 2.4);
}

function hexToLuminance(hex: string): number {
  hex = hex.replace('#', '');
  const r = sRGBtoLin(parseInt(hex.substring(0, 2), 16) / 255);
  const g = sRGBtoLin(parseInt(hex.substring(2, 4), 16) / 255);
  const b = sRGBtoLin(parseInt(hex.substring(4, 6), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = hexToLuminance(hex1);
  const l2 = hexToLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('TASK-P1-05: WCAG 2.1 AA Contrast Ratios & Focus Rings', () => {
  const tokensPath = path.resolve(__dirname, '../src/styles/tokens.css');
  const componentsPath = path.resolve(__dirname, '../src/styles/components.css');
  const glassPath = path.resolve(__dirname, '../src/styles/glass.css');
  const tokensCss = fs.readFileSync(tokensPath, 'utf8');
  const componentsCss = fs.readFileSync(componentsPath, 'utf8');
  const glassCss = fs.readFileSync(glassPath, 'utf8');

  it('verifies --text-tertiary meets or exceeds WCAG 2.1 AA 4.5:1 contrast against light canvas and dark surface', () => {
    const match = /--text-tertiary:\s*light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\);/.exec(tokensCss);
    expect(match).not.toBeNull();
    const lightTertiary = match![1]!;
    const darkTertiary = match![2]!;

    expect(lightTertiary.toLowerCase()).toBe('#59595e');
    expect(darkTertiary.toLowerCase()).toBe('#8e8e93');

    // Contrast against light canvas #f5f5f7
    const lightRatio = contrastRatio('#f5f5f7', lightTertiary);
    expect(lightRatio).toBeGreaterThanOrEqual(4.5);

    // Contrast against dark surface #1c1c1e
    const darkSurfaceRatio = contrastRatio('#1c1c1e', darkTertiary);
    expect(darkSurfaceRatio).toBeGreaterThanOrEqual(4.5);

    // Contrast against dark canvas #000000
    const darkCanvasRatio = contrastRatio('#000000', darkTertiary);
    expect(darkCanvasRatio).toBeGreaterThanOrEqual(4.5);
  });

  it('verifies all text/bg color token combinations in light and dark mode meet or exceed 4.5:1 contrast', () => {
    const primaryMatch = /--text-primary:\s*light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\);/.exec(
      tokensCss,
    );
    const secondaryMatch = /--text-secondary:\s*light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\);/.exec(
      tokensCss,
    );
    const tertiaryMatch = /--text-tertiary:\s*light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\);/.exec(
      tokensCss,
    );

    expect(primaryMatch).not.toBeNull();
    expect(secondaryMatch).not.toBeNull();
    expect(tertiaryMatch).not.toBeNull();

    const lightPrimary = primaryMatch![1]!;
    const darkPrimary = primaryMatch![2]!;
    const lightSecondary = secondaryMatch![1]!;
    const darkSecondary = secondaryMatch![2]!;
    const lightTertiary = tertiaryMatch![1]!;
    const darkTertiary = tertiaryMatch![2]!;

    // Light mode text vs canvas (#f5f5f7), surface-elevated (#ffffff), surface-secondary (#f2f2f7)
    const lightBgs = ['#f5f5f7', '#ffffff', '#f2f2f7'];
    for (const bg of lightBgs) {
      expect(contrastRatio(bg, lightPrimary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(bg, lightSecondary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(bg, lightTertiary)).toBeGreaterThanOrEqual(4.5);
    }

    // Dark mode text vs canvas (#000000) and surface-secondary (#1c1c1e)
    const darkBgs = ['#000000', '#1c1c1e'];
    for (const bg of darkBgs) {
      expect(contrastRatio(bg, darkPrimary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(bg, darkSecondary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(bg, darkTertiary)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('verifies font size tokens and focus ring definitions on interactive components and glass elements', () => {
    // 1. Font size tokens
    expect(tokensCss).toMatch(/--text-2xs:\s*11px;/);
    expect(tokensCss).toMatch(/--text-xs:\s*12px;/);

    // 2. Focus ring token exists
    expect(tokensCss).toContain('--accent-ring:');

    // 3. Components have :focus-visible rules with outline: none and box-shadow with accent-ring
    expect(componentsCss).toContain(':focus-visible');
    expect(componentsCss).toContain('var(--accent-ring)');
    expect(componentsCss).toMatch(/box-shadow:\s*0 0 0 2px var\(--accent-ring\);/);
    expect(componentsCss).toContain('@media (forced-colors: active)');

    // 4. Glass input focus-visible rules
    expect(glassCss).toContain('.glass-input:focus-visible');
    expect(glassCss).toContain('var(--accent-ring)');
    expect(glassCss).toContain('@media (forced-colors: active)');
  });
});
