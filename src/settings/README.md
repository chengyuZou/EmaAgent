# Settings

[中文](README-zh.md)

Settings reads and saves typed application settings. Business packages declare each key, default, Zod schema and application time. Server registers those definitions and any groups with cross-field rules when constructing `SettingsStore`.

## Define and use a setting

```ts
import { z } from 'zod';
import { defineSetting, SettingsStore } from '@ema-agent/settings';
import { SettingsRepo } from '@ema-agent/storage';

const enabledSetting = defineSetting({
  key: 'example.enabled',
  apply: 'nextTurn',
  defaultValue: false,
  schema: z.boolean(),
});
const settings = new SettingsStore(new SettingsRepo(profileDb.sqlite), {
  definitions: [enabledSetting],
});
const enabled = settings.get(enabledSetting);
settings.set(enabledSetting, true);
settings.delete(enabledSetting);
```

SQL stores user overrides as JSON. Definitions and defaults remain in code. `get` reads the repository and validates the value on every call. A missing or invalid value returns a clone of the default; invalid persisted values produce at most one warning per key per Store instance. Reading does not repair the saved value.

`register` rejects duplicate keys. `listDefinitions` returns registered definitions sorted by key; `findDefinition` returns undefined for an unknown key. Server uses this directory to resolve settings submitted through its [value routes](../../apps/server/src/routes/settings/values.ts).

## Saving and notifications

`set` validates one value. `setMany` validates all proposed values before saving them in one repository transaction. If a changed definition names a `group`, the Store validates the whole group using proposed values plus the other keys' current valid values or defaults. A missing group or invalid combination rejects the write.

`delete` removes an override, so subsequent reads use its default. It does not validate group constraints.

The order is validation, database write, then synchronous listener notification. A failed write sends no notification. A listener error propagates but does not undo the saved settings. `subscribe` returns an unsubscribe function.

In-process `SettingsChangedEvent` carries changed keys and a sequence number local to that Store instance. Server consumers use the keys to apply immediate changes. The separate cross-window `settings_changed` event asks Desktop to reload settings and carries no values or sequence number.

`apply` declares when a business consumer should read a new value: immediately, at the next operation, at the next Turn, or after restart. The Store does not schedule those reads; the consuming package implements that timing.

## Code and checks

Business definition files can import `defineSetting` from `@ema-agent/settings/definition` without loading the Store. The helper preserves literal keys and infers the value from the schema; defaults must match that value type. Server exposes the registered definitions to Desktop through `@ema-agent/server/settings`, so browser callers use the same key, schema, default and apply policy. The Store itself remains a backend operation.

[types.ts](types.ts) defines setting and group contracts, [settingsStore.ts](settingsStore.ts) handles validation and notifications, and [Storage](../storage/repos/profile/settings.ts) handles SQL. [Server composition](../../apps/server/src/composition/settings.ts) registers the real business definitions. Desktop parameter components provide their own labels, controls and unit conversions.

Run `pnpm --filter @ema-agent/settings test`. Tests cover fallback reads, validation, write-before-notify order, group rules and definition registration.
