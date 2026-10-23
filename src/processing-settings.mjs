// SPDX-License-Identifier: GPL-3.0-or-later
import { sourceSizing } from './image-sizing.mjs';

export const carrierScaleForTile = tile => Math.max(1, Math.min(8, Math.round(16 / tile * 2) / 2));
export const carrierScale = settings => settings.autoCarrier ? carrierScaleForTile(settings.tileSize) : settings.carrierScale;

export function conversionDefaults(settings, animatedOutput) {
  return { ...settings, balance: animatedOutput ? 100 : 50, tileSize: animatedOutput ? 2 : 8 };
}

export function balancePreference(balance) {
  const value = Math.max(0, Math.min(100, Number(balance))) / 100;
  // Keep both endpoints while moving the former 75% balance point to center.
  return value <= 0.5 ? value * 1.5 : 0.75 + (value - 0.5) * 0.5;
}

export function processingSize(width, height, settings) {
  return sourceSizing(width, height, settings.autoResize ? null : settings.sourceScale,
    Math.min(16000000, 31000000 / carrierScale(settings) ** 2));
}

export function processingOptions(settings, recoveryBoost = false) {
  const preference = balancePreference(settings.balance);
  const compression = settings.quality < 60 ? 28 : settings.quality < 65 ? 24 : 12;
  return {
    tileSize: settings.tileSize, scale: carrierScale(settings),
    step: settings.manual ? settings.strength : Math.round(Math.max(16 + Math.max(0, preference - 0.5) * 8, compression, recoveryBoost ? 24 : 0) / 2) * 2,
    fit: settings.manual ? settings.fit : 'contain',
    colorAdapt: settings.manual ? settings.colorAdapt : true,
    colorGain: settings.manual ? settings.colorGain : preference < 0.4 ? 1 : preference < 0.65 ? 0.75 : preference < 0.875 ? 0.5 : 0.25,
  };
}
