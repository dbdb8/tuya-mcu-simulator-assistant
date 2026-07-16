# JavaScript Scheduled Dynamic Report Tutorial

[中文](./javascript-timer-script-guide.md) | [English](./javascript-timer-script-guide.en.md)

This tutorial explains how to write JavaScript dynamic report scripts under **Settings > Scheduled Reports**. Scripts are useful when ordinary fixed, rotating, or random DP values cannot express related DPs, persistent sequences, timestamps, JSON strings, binary Raw payloads, or CRC values.

A script only **calculates the DPs for the current execution**. Delay, interval, network gate, run limit, and batch/sequential report behavior remain controlled by the scheduled task.

> The DP codes `switch`, `status`, `sensor_value`, `event_detail`, and `raw_packet` are neutral examples. Replace them with codes that exist in the loaded Debugfile and obey each DP's type, range, step, enum, and length constraints.

## 1. When to use scripts

Use JavaScript when a task needs to:

- Generate several mutually consistent DPs in one execution.
- Persist and increment a sequence across reports and application restarts.
- Include the current Unix time, sample ID, length fields, or checksums.
- Build dynamic JSON for a String DP.
- Assemble Raw bytes with little-endian integers and CRC16-Modbus.
- Skip a cycle until a DP condition is satisfied.

Scripts cannot construct or send heartbeat, Wi-Fi reset, provisioning, OTA, or arbitrary protocol commands, and cannot bypass the loaded Debugfile to write serial frames.

## 2. Create a script task

1. Start the assistant and load the target Debugfile JSON manually.
2. Select the serial port and baud rate, then start debugging.
3. Open **Settings > Scheduled Reports**.
4. Add a task and enter its name and group.
5. Change the generation mode to **JavaScript Script**.
6. Configure delay, interval, network gate, run limit, and report mode.
7. Write or paste `generate(ctx)` in the editor.
8. Enter an initial-state JSON object, such as `{ "seq": 0 }`.
9. Select **Test Generation** and inspect the generated DPs, Raw hex, state, and summary.
10. Save and start the task after the preview is valid.

Preview does not send serial data, mutate script state, or increment the task run count.

## 3. Minimal script

Every script must define a global `generate(ctx)` function and return an object:

```javascript
function generate(ctx) {
  return {
    reports: [{ code: "switch", value: true }],
    state: ctx.state,
    summary: "switch=true",
    skip: false,
  };
}
```

| Field     | Required | Meaning                                                                      |
| --------- | -------- | ---------------------------------------------------------------------------- |
| `reports` | Yes      | DPs generated for this execution, each containing `code` and `value`         |
| `state`   | Yes      | Persistent state for the next execution; return a plain JSON object          |
| `summary` | No       | Serial-log summary, truncated to 180 characters                              |
| `skip`    | No       | When `true`, saves state without sending DPs or incrementing successful runs |

When `skip` is not `true`, `reports` must contain at least one DP. A code may appear only once per execution.

## 4. Runtime context

`ctx` is read-only. Return a new `state` value instead of attempting to mutate the context.

| Field               | Type      | Meaning                                                       |
| ------------------- | --------- | ------------------------------------------------------------- |
| `ctx.nowMs`         | `number`  | Current Unix time in milliseconds                             |
| `ctx.nowUnix`       | `number`  | Current Unix time in seconds                                  |
| `ctx.runIndex`      | `number`  | Execution index derived from the current successful run count |
| `ctx.state`         | `object`  | State from the last successful report or skipped cycle        |
| `ctx.values`        | `object`  | Current backend DP values keyed by DP code                    |
| `ctx.schema`        | `object`  | PID and DP definitions parsed from the Debugfile              |
| `ctx.network`       | `object`  | Current network `code` and localized `label`                  |
| `ctx.task.id`       | `string`  | Current task ID                                               |
| `ctx.task.name`     | `string`  | Current task name                                             |
| `ctx.task.runCount` | `number`  | Number of successful executions                               |
| `ctx.preview`       | `boolean` | Whether Test Generation triggered this execution              |

Scripts used by Triggered Reports also receive:

- `ctx.trigger`: the downloaded `id`, `code`, `value`, `receivedAtMs`, and `frameIndex`.
- `ctx.sequence`: sequence ID, group, run index, start/elapsed time, and previous run time; `null` for one-time responses.
- Return `complete=true` to end a periodic sequence after the current successful report.

Read a current DP value:

```javascript
function generate(ctx) {
  const current = Number(ctx.values.sensor_value ?? 0);
  const next = clamp(current + 5, 0, 100);
  return {
    reports: [{ code: "sensor_value", value: next }],
    state: ctx.state,
    summary: `sensor_value=${next}`,
  };
}
```

Read a DP definition safely:

```javascript
const point = ctx.schema.points.find((item) => item.code === "sensor_value");
const min = Number(point?.property?.min ?? 0);
const max = Number(point?.property?.max ?? 100);
```

## 5. Built-in helpers

| Function                 | Result         | Purpose                                                    |
| ------------------------ | -------------- | ---------------------------------------------------------- |
| `randomInt(min, max)`    | integer        | Inclusive random integer                                   |
| `randomChoice(values)`   | array item     | Random element from a non-empty array                      |
| `clamp(value, min, max)` | number         | Restrict a number to a range                               |
| `u16le(value)`           | `number[]`     | Two-byte little-endian integer                             |
| `u32le(value)`           | `number[]`     | Four-byte little-endian integer                            |
| `concatBytes(...arrays)` | `number[]`     | Concatenate byte arrays                                    |
| `crc16Modbus(bytes)`     | integer        | CRC16-Modbus with initial `0xFFFF` and polynomial `0xA001` |
| `bytesToHex(bytes)`      | string         | Lowercase hex without spaces                               |
| `raw(bytes)`             | Raw wrapper    | Return bytes as a Raw DP                                   |
| `json(object)`           | String wrapper | Serialize an object as compact JSON for a String DP        |

`u16le(0x1234)` returns `[0x34, 0x12]`. There is no built-in big-endian helper; define one when required:

```javascript
function u16be(value) {
  const n = Number(value) >>> 0;
  return [(n >>> 8) & 0xff, n & 0xff];
}
```

## 6. DP value types

### Bool

Return a JavaScript boolean, not `"true"` or `1`:

```javascript
reports: [{ code: "switch", value: true }];
```

### Value

Return an integer aligned with Debugfile `min`, `max`, and `step`:

```javascript
function generate(ctx) {
  const point = ctx.schema.points.find((item) => item.code === "sensor_value");
  const min = Number(point?.property?.min ?? 0);
  const max = Number(point?.property?.max ?? 100);
  const step = Math.max(1, Number(point?.property?.step ?? 1));
  const value = min + randomInt(0, Math.floor((max - min) / step)) * step;
  return {
    reports: [{ code: "sensor_value", value }],
    state: ctx.state,
    summary: `sensor_value=${value}`,
  };
}
```

`scale` describes display precision; the MCU model still receives an integer. For example, a displayed value of `12.3` with `scale=1` commonly uses protocol integer `123`, subject to the product definition.

### Enum

Return a string from Debugfile `range`, or a valid zero-based numeric index. Strings are recommended:

```javascript
reports: [{ code: "status", value: "running" }];
```

### Bitmap

Return an integer. Bitwise operations can combine flags:

```javascript
const OVER_TEMP = 1 << 0;
const SENSOR_ERROR = 1 << 2;
reports: [{ code: "fault_bitmap", value: OVER_TEMP | SENSOR_ERROR }];
```

### String

Return text directly, or use `json(object)` for compact JSON:

```javascript
reports: [
  {
    code: "event_detail",
    value: json({
      seq: Number(ctx.state.seq ?? 0),
      timestamp: ctx.nowUnix,
      type: "sample",
    }),
  },
];
```

The UTF-8 byte length must not exceed Debugfile `maxlen`, which defaults to 255 bytes when absent.

### Raw

Raw accepts even-length hex, a byte array, or `raw(bytes)`:

```javascript
{ code: "raw_packet", value: "01 02 0a ff" }
{ code: "raw_packet", value: [1, 2, 10, 255] }
{ code: "raw_packet", value: raw([1, 2, 10, 255]) }
```

Every byte must be an integer from 0 to 255. The final byte length must not exceed `maxlen`.

## 7. Multiple related DPs and report mode

```javascript
function generate(ctx) {
  const running = ctx.task.runCount % 2 === 0;
  const value = running ? randomInt(20, 80) : 0;
  return {
    reports: [
      { code: "switch", value: running },
      { code: "status", value: running ? "running" : "idle" },
      { code: "sensor_value", value },
    ],
    state: ctx.state,
    summary: `status=${running ? "running" : "idle"}, value=${value}`,
  };
}
```

Batch mode places these DPs into one DP report frame. Sequential mode sends them independently in `reports` order. The script does not change between modes.

## 8. Persistent state

Use an initial state such as:

```json
{ "seq": 0, "phase": 0 }
```

Then return the next state:

```javascript
function generate(ctx) {
  const seq = Number(ctx.state.seq ?? 0);
  const phases = ["idle", "running", "complete"];
  const phase = Number(ctx.state.phase ?? 0) % phases.length;
  return {
    reports: [
      { code: "status", value: phases[phase] },
      {
        code: "event_detail",
        value: json({ seq, timestamp: ctx.nowUnix, status: phases[phase] }),
      },
    ],
    state: {
      ...ctx.state,
      seq: seq + 1,
      phase: (phase + 1) % phases.length,
    },
    summary: `seq=${seq}, status=${phases[phase]}`,
  };
}
```

State rules:

- A successful serial report commits state and increments `runCount`.
- A send failure commits neither state nor run count.
- `skip=true` commits state without sending or incrementing runs.
- Preview never commits state or sends data.
- Pause and application restart preserve state.
- Reset restores `initialState`.
- A duplicated task starts from `initialState`.

## 9. Conditional skip

```javascript
function generate(ctx) {
  if (ctx.values.switch !== true) {
    return {
      reports: [],
      state: {
        ...ctx.state,
        skipped: Number(ctx.state.skipped ?? 0) + 1,
      },
      summary: "switch is off; skip this cycle",
      skip: true,
    };
  }
  return {
    reports: [{ code: "sensor_value", value: randomInt(0, 100) }],
    state: ctx.state,
    summary: "sample generated",
  };
}
```

Use task network gates and timing controls for scheduling. Scripts cannot change their next execution time.

## 10. Raw packet and CRC16-Modbus

The following neutral packet contains version, little-endian sequence, Unix time, data length, three samples, and a little-endian CRC over all preceding bytes:

```javascript
function generate(ctx) {
  const seq = Number(ctx.state.seq ?? 0) & 0xffff;
  const samples = [randomInt(0, 100), randomInt(0, 100), randomInt(0, 100)];
  const body = concatBytes([0x01], u16le(seq), u32le(ctx.nowUnix), [samples.length], samples);
  const crc = crc16Modbus(body);
  const packet = concatBytes(body, u16le(crc));
  return {
    reports: [{ code: "raw_packet", value: raw(packet) }],
    state: { ...ctx.state, seq: (seq + 1) & 0xffff },
    summary: `seq=${seq}, bytes=${packet.length}, crc=0x${crc.toString(16).padStart(4, "0")}`,
  };
}
```

CRC16-Modbus standard vector:

```javascript
const bytes = [49, 50, 51, 52, 53, 54, 55, 56, 57]; // "123456789"
const crc = crc16Modbus(bytes); // 0x4B37
```

The packet layout is an example, not a universal Tuya Raw format. Follow the target DP's documented CRC coverage and byte order.

## 11. Preview, import, and export

Use Test Generation to validate syntax, DP codes, types, ranges, enum values, Raw hex, length, CRC, next state, and summary. Preview reads current state but does not save its returned state.

The v3 task export includes `apiVersion`, `source`, `initialState`, and current `state`. Do not place passwords, tokens, keys, or personal data in source or state.

Imports containing scripts require explicit confirmation and remain disabled after import. The destination Debugfile must contain compatible DP definitions.

## 12. Sandbox limits

Scripts run in embedded Rust QuickJS, not WebView `eval`. They have no file, network, environment, process, Node.js, DOM, Tauri, or serial APIs.

| Resource              | Limit                                 |
| --------------------- | ------------------------------------- |
| Execution time        | 100ms                                 |
| QuickJS memory        | 8MB                                   |
| QuickJS stack         | 256KB                                 |
| Source                | 64KB                                  |
| State JSON            | 16KB                                  |
| Reports per execution | 64 unique DP codes                    |
| Summary               | 180 characters                        |
| String/Raw            | Debugfile `maxlen`, default 255 bytes |

Avoid infinite loops, deep recursion, and large temporary arrays.

## 13. Troubleshooting

- **`generate(ctx) is required`**: define a global function with that exact name.
- **No DPs returned**: return at least one report or set `skip: true`.
- **Unknown DP**: use a Debugfile DP `code`, not its numeric ID or display name.
- **Duplicate DP**: return each code at most once per execution.
- **Invalid DP value**: check boolean type, integer range/step, enum range, String wrapper, or Raw format.
- **DP data too long**: check UTF-8 String bytes or Raw bytes against `maxlen`.
- **Execution failed**: inspect Monaco diagnostics and remove browser/Node.js APIs, loops, recursion, or large allocations.
- **Preview succeeds but send fails**: verify the Debugfile, serial connection, network gate, and physical module.

A send failure does not advance state, so the original sequence can be retried after restoring the connection.

## 14. Preflight checklist

- The correct Debugfile and PID are loaded.
- Every report uses a real DP code.
- Values match Bool, Value, Enum, Bitmap, String, and Raw definitions.
- Value/Bitmap values satisfy `min`, `max`, and `step`.
- String/Raw values fit `maxlen`.
- Raw byte order, length fields, and CRC coverage match the business protocol.
- `initialState` is a JSON object with safe defaults.
- Test Generation shows the expected patches, state, and summary.
- Report mode, network gate, interval, and run limit are correct.
- The serial port is open; start with a long interval and a small run limit.

## 15. Complete generic template

```javascript
function findPoint(ctx, code) {
  const point = ctx.schema.points.find((item) => item.code === code);
  if (!point) throw new Error(`${code} is missing from Debugfile`);
  return point;
}

function randomSteppedValue(point) {
  const min = Number(point.property?.min ?? 0);
  const max = Number(point.property?.max ?? 100);
  const step = Math.max(1, Number(point.property?.step ?? 1));
  return min + randomInt(0, Math.floor((max - min) / step)) * step;
}

function generate(ctx) {
  const seq = Number(ctx.state.seq ?? 0) >>> 0;
  const valuePoint = findPoint(ctx, "sensor_value");
  const statusPoint = findPoint(ctx, "status");
  const range = Array.isArray(statusPoint.property?.range) ? statusPoint.property.range : [];
  if (range.length === 0) throw new Error("status has no enum range");

  const sensorValue = randomSteppedValue(valuePoint);
  const status = randomChoice(range);
  const body = concatBytes([0x01], u32le(seq), u32le(ctx.nowUnix), u16le(sensorValue));
  const crc = crc16Modbus(body);
  const packet = concatBytes(body, u16le(crc));

  return {
    reports: [
      { code: "switch", value: true },
      { code: "status", value: status },
      { code: "sensor_value", value: sensorValue },
      {
        code: "event_detail",
        value: json({ seq, timestamp: ctx.nowUnix, status, value: sensorValue }),
      },
      { code: "raw_packet", value: raw(packet) },
    ],
    state: { ...ctx.state, seq: (seq + 1) >>> 0 },
    summary: `seq=${seq}, status=${status}, value=${sensorValue}, bytes=${packet.length}`,
  };
}
```

Start with one DP, verify preview and serial behavior, then add JSON, Raw, and related DPs incrementally. This makes DP-definition, packet-layout, and serial-connection problems much easier to isolate.
