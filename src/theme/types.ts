export type ThemeMode = 'light' | 'dark';
export type ThemePreference = ThemeMode | 'system';
export type ContentFontPreset = 'system' | 'rounded' | 'reading' | 'custom';

export interface ThemeSettings {
  hue: number;
  radius: number;
  mode: ThemeMode;
  contentFontPreset: ContentFontPreset;
  contentFontFamily: string;
}

export interface ThemeVariables {
  colorScheme: ThemeMode;
  cssVariables: Readonly<Record<'--chromatic-hue' | '--ema-radius', string>>;
}
