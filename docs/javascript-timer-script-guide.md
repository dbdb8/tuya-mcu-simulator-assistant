# JavaScript 定时动态上报脚本教程

[中文](./javascript-timer-script-guide.md) | [English](./javascript-timer-script-guide.en.md)

本教程介绍如何在“设置 > 定时上报”中编写 JavaScript 动态上报脚本。脚本适合生成普通随机值难以表达的数据，例如相互关联的多个 DP、持续递增的序号、当前时间戳、JSON 字符串、二进制 Raw 数据和 CRC。

脚本只负责**计算本次需要上报的 DP 数据**。任务的延迟、间隔、网络条件、执行次数以及合并/逐个上报方式仍由定时任务配置控制。

> 教程中的 `switch`、`status`、`sensor_value`、`event_detail` 和 `raw_packet` 是通用示例。使用前必须替换成当前 Debugfile 中真实存在的 DP code，并按照该 DP 的类型、范围、步长、枚举和长度约束返回数据。

## 1. 适用场景

普通 DP 配置模式适合固定值、多值轮询和单字段随机。以下场景更适合 JavaScript：

- 一次生成多个相互一致的 DP，例如状态为 `running` 时同时上报非零剩余时间。
- 每次上报都需要递增序号，并在应用重启后继续使用该序号。
- payload 包含当前 Unix 时间、采样编号、长度字段或校验码。
- String DP 需要上报动态 JSON。
- Raw DP 需要按协议组装字节、写入小端整数并计算 CRC16-Modbus。
- 只有满足特定 DP 状态时才发送，否则跳过当前周期。

脚本不能构造或发送心跳、Wi-Fi reset、配网、OTA 等任意协议命令，也不能绕过 Debugfile 直接发送串口帧。

## 2. 创建第一个脚本任务

1. 启动助手并手动加载目标设备的 Debugfile JSON。
2. 选择串口和波特率，点击“开始调试”。
3. 打开右上角“设置 > 定时上报”。
4. 点击“添加任务”，填写任务名称和分组。
5. 将生成方式切换为“JavaScript 脚本”。
6. 设置固定或随机延迟、执行间隔、网络条件和执行次数限制。
7. 在脚本编辑器中粘贴或编写 `generate(ctx)`。
8. 在“初始状态”中填写 JSON 对象，例如 `{ "seq": 0 }`。
9. 点击“测试生成”，检查生成的 DP、Raw hex、状态和摘要。
10. 预览正确后保存并启动任务。

“测试生成”不会打开串口发送数据，不会改变当前脚本状态，也不会增加任务执行次数。因此可以反复预览。

## 3. 最小脚本

每个脚本必须定义全局函数 `generate(ctx)`，并返回一个对象：

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

返回字段：

| 字段      | 必填 | 说明                                                   |
| --------- | ---- | ------------------------------------------------------ |
| `reports` | 是   | 本次生成的 DP 数组。每项包含 `code` 和 `value`         |
| `state`   | 是   | 下一次执行使用的持久化状态，建议始终返回普通 JSON 对象 |
| `summary` | 否   | 本次上报的日志摘要，最多保留 180 个字符                |
| `skip`    | 否   | `true` 表示保存状态但不发送 DP，且不增加成功执行次数   |

当 `skip` 不是 `true` 时，`reports` 至少需要包含一个 DP。同一次执行不能返回两个相同的 DP code。

## 4. 运行上下文 `ctx`

`ctx` 是只读的本次执行上下文。不要尝试直接修改它，应通过返回的 `state` 保存下一次需要的数据。

| 字段                | 类型      | 说明                                                    |
| ------------------- | --------- | ------------------------------------------------------- |
| `ctx.nowMs`         | `number`  | 当前 Unix 时间，单位毫秒                                |
| `ctx.nowUnix`       | `number`  | 当前 Unix 时间，单位秒，等于 `Math.floor(nowMs / 1000)` |
| `ctx.runIndex`      | `number`  | 本次计划使用的执行序号，从当前成功次数推导              |
| `ctx.state`         | `object`  | 上一次成功提交或 `skip` 保存的脚本状态                  |
| `ctx.values`        | `object`  | 后端当前保存的所有 DP 值，以 DP code 为 key             |
| `ctx.schema`        | `object`  | 当前 Debugfile 解析后的 PID 和 DP 定义                  |
| `ctx.network`       | `object`  | 当前网络状态，包含 `code` 和本地化 `label`              |
| `ctx.task.id`       | `string`  | 当前任务 ID                                             |
| `ctx.task.name`     | `string`  | 当前任务名称                                            |
| `ctx.task.runCount` | `number`  | 当前已成功执行的次数                                    |
| `ctx.preview`       | `boolean` | 当前是否由“测试生成”触发                                |

脚本用于“触发上报”时还会提供：

- `ctx.trigger`：本次下发的 `id/code/value/receivedAtMs/frameIndex`。
- `ctx.sequence`：周期序列的 ID、分组、执行序号、开始时间、已运行时间和上次执行时间；单次响应时为 `null`。
- 返回 `complete=true`：本次成功上报后结束周期序列。

查看当前 DP 值：

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

查找 Debugfile 中的 DP 定义：

```javascript
const point = ctx.schema.points.find((item) => item.code === "sensor_value");
const min = Number(point?.property?.min ?? 0);
const max = Number(point?.property?.max ?? 100);
```

脚本不应假定所有 Debugfile 都有相同属性。读取 `min`、`max`、`step`、`range` 或 `maxlen` 时应提供合理的缺省值。

## 5. 内置帮助函数

| 函数                     | 返回值        | 用途                                              |
| ------------------------ | ------------- | ------------------------------------------------- |
| `randomInt(min, max)`    | 整数          | 生成包含最小值和最大值的随机整数                  |
| `randomChoice(values)`   | 任意数组元素  | 从非空数组随机选择一项                            |
| `clamp(value, min, max)` | 数字          | 将数字限制在指定范围内                            |
| `u16le(value)`           | `number[]`    | 将整数编码成 2 字节小端数组                       |
| `u32le(value)`           | `number[]`    | 将整数编码成 4 字节小端数组                       |
| `concatBytes(...arrays)` | `number[]`    | 按顺序合并多个字节数组                            |
| `crc16Modbus(bytes)`     | 整数          | 计算 CRC16-Modbus，初值 `0xFFFF`、多项式 `0xA001` |
| `bytesToHex(bytes)`      | 字符串        | 将字节数组转换为无空格的小写 hex                  |
| `raw(bytes)`             | Raw 包装值    | 明确将字节数组作为 Raw DP 返回                    |
| `json(object)`           | String 包装值 | 将对象压缩序列化为 JSON 字符串 DP                 |

`u16le(0x1234)` 返回 `[0x34, 0x12]`，`u32le(0x12345678)` 返回 `[0x78, 0x56, 0x34, 0x12]`。当前没有内置大端函数，如协议要求大端，可显式构造数组：

```javascript
function u16be(value) {
  const n = Number(value) >>> 0;
  return [(n >>> 8) & 0xff, n & 0xff];
}
```

## 6. 各 DP 类型写法

### 6.1 Bool

Bool 必须返回 JavaScript 布尔值，不能返回字符串 `"true"` 或数字 `1`。

```javascript
reports: [{ code: "switch", value: true }];
```

错误示例：

```javascript
reports: [{ code: "switch", value: "true" }];
```

### 6.2 Value

Value 必须返回整数，并满足 Debugfile 的 `min`、`max` 和 `step`。

```javascript
function generate(ctx) {
  const point = ctx.schema.points.find((item) => item.code === "sensor_value");
  const min = Number(point?.property?.min ?? 0);
  const max = Number(point?.property?.max ?? 100);
  const step = Math.max(1, Number(point?.property?.step ?? 1));
  const slots = Math.floor((max - min) / step);
  const value = min + randomInt(0, slots) * step;

  return {
    reports: [{ code: "sensor_value", value }],
    state: ctx.state,
    summary: `sensor_value=${value}`,
  };
}
```

`scale` 仅描述显示精度，助手仍按 MCU 协议整数模型校验和上报。例如平台显示 `12.3`、`scale=1` 时，脚本通常应返回协议整数 `123`，具体以 Debugfile 和产品协议为准。

### 6.3 Enum

Enum 可以返回 Debugfile `range` 中的字符串，也可以返回合法的从零开始的数字下标。推荐使用字符串，脚本更易读，也不容易因为枚举顺序变化而产生错误。

```javascript
reports: [{ code: "status", value: "running" }];
```

如果 `range` 是 `["idle", "running", "error"]`，返回 `1` 也会映射为 `running`：

```javascript
reports: [{ code: "status", value: 1 }];
```

### 6.4 Bitmap

Bitmap 与 Value 一样返回整数，并受 Debugfile 范围和步长校验。可以使用按位运算组合故障位：

```javascript
const OVER_TEMP = 1 << 0;
const SENSOR_ERROR = 1 << 2;
const flags = OVER_TEMP | SENSOR_ERROR;

return {
  reports: [{ code: "fault_bitmap", value: flags }],
  state: ctx.state,
  summary: `fault_bitmap=${flags}`,
};
```

### 6.5 String

普通文本可直接返回字符串：

```javascript
reports: [{ code: "message", value: "sample complete" }];
```

需要生成 JSON 时使用 `json(object)`。助手会压缩序列化，不会添加格式化空格：

```javascript
reports: [
  {
    code: "event_detail",
    value: json({
      seq: Number(ctx.state.seq ?? 0),
      timestamp: ctx.nowUnix,
      type: "sample",
      value: randomInt(10, 90),
    }),
  },
];
```

String 的 UTF-8 字节长度不能超过 Debugfile 的 `maxlen`。没有配置 `maxlen` 时，助手默认最多允许 255 字节。

### 6.6 Raw

Raw 支持三种等价写法：

```javascript
// 偶数长度 hex，可包含空格。
{ code: "raw_packet", value: "01 02 0a ff" }

// 每项必须是 0..255 的整数。
{ code: "raw_packet", value: [1, 2, 10, 255] }

// 推荐用于动态组包，可明确表达这是 Raw 数据。
{ code: "raw_packet", value: raw([1, 2, 10, 255]) }
```

Raw 字节数不能超过 Debugfile 的 `maxlen`，且空 hex 字符串不合法。

## 7. 多个关联 DP

一个脚本可以同时生成不同类型的 DP：

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

任务选择“合并上报”时，这些 DP 会进入同一条 DP 上报帧；选择“逐个上报”时，助手按 `reports` 顺序逐个发送。脚本内容无需因此改变。

## 8. 持久化序号和状态

`ctx.state` 用于保存下一次执行需要的数据。初始状态可以配置为：

```json
{
  "seq": 0,
  "phase": 0
}
```

脚本读取当前状态并返回下一状态：

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

状态提交规则：

- 串口发送成功后，保存返回的 `state` 并增加 `runCount`。
- 串口发送失败时，不保存新状态，不增加 `runCount`；重试仍使用原序号。
- `skip=true` 时保存状态，但不发送串口帧，也不增加 `runCount`。
- “测试生成”不会保存状态，不发送帧，也不增加序号。
- 暂停任务或重启应用后保留当前状态。
- 点击“重置脚本状态”会恢复为 `initialState`。
- 复制任务时，副本从 `initialState` 开始，不继承正在运行的状态。

不要直接修改嵌套状态对象。推荐返回新对象，避免预览和正式运行之间出现难以判断的副作用。

## 9. 条件跳过 `skip`

任务本身支持网络门槛；更细的业务条件可以在脚本中判断。例如只有 `switch=true` 时才生成采样数据：

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

`skip` 适合等待 DP 条件，不适合代替任务的固定/随机间隔或网络触发配置。脚本不能改变下一次调度时间。

## 10. Raw 组包与 CRC16-Modbus

下面的通用示例生成一个 Raw 数据包：

| 偏移 | 长度 | 字段         | 编码                        |
| ---- | ---- | ------------ | --------------------------- |
| 0    | 1    | 协议版本     | 固定 `0x01`                 |
| 1    | 2    | 采样序号     | `u16le`                     |
| 3    | 4    | Unix 时间    | `u32le`                     |
| 7    | 1    | 数据长度     | 当前固定为 3                |
| 8    | 3    | 采样数据     | 三个字节                    |
| 11   | 2    | CRC16-Modbus | 对偏移 0..10 计算，小端写入 |

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

预览结果中的 `patches[].value` 会显示规范化后的连续 hex。可以临时在摘要中加入 `bytesToHex(packet)` 排查组包，但摘要最多保留 180 个字符。

CRC16-Modbus 标准校验向量：

```javascript
function generate(ctx) {
  const bytes = [49, 50, 51, 52, 53, 54, 55, 56, 57]; // ASCII "123456789"
  const crc = crc16Modbus(bytes); // 0x4B37

  return {
    reports: [{ code: "raw_packet", value: raw(concatBytes(bytes, u16le(crc))) }],
    state: ctx.state,
    summary: `CRC=0x${crc.toString(16).padStart(4, "0")}`,
  };
}
```

CRC 覆盖范围和 CRC 字节序必须遵循目标 DP 的业务协议。上述数据包结构只是演示，不代表涂鸦 Raw DP 的统一格式。

## 11. 随机值与步长对齐

不要先随机任意整数再期望后端自动修正步长。后端只负责校验，不会悄悄改变脚本值：

```javascript
function randomValueFor(point) {
  const min = Number(point.property?.min ?? 0);
  const max = Number(point.property?.max ?? 100);
  const step = Math.max(1, Number(point.property?.step ?? 1));
  const slots = Math.max(0, Math.floor((max - min) / step));
  return min + randomInt(0, slots) * step;
}

function generate(ctx) {
  const point = ctx.schema.points.find((item) => item.code === "sensor_value");
  if (!point) throw new Error("sensor_value is missing from Debugfile");
  const value = randomValueFor(point);

  return {
    reports: [{ code: point.code, value }],
    state: ctx.state,
    summary: `${point.code}=${value}`,
  };
}
```

Enum 随机值应从 Debugfile 的 `range` 中选择：

```javascript
const point = ctx.schema.points.find((item) => item.code === "status");
const range = Array.isArray(point?.property?.range) ? point.property.range : [];
if (range.length === 0) throw new Error("status has no enum range");
const status = randomChoice(range);
```

## 12. 预览、导入与导出

### 测试生成

“测试生成”适合检查：

- 脚本语法和 `generate(ctx)` 是否存在。
- DP code 是否存在。
- 返回类型、数值范围、步长和枚举是否合法。
- Raw 最终 hex、字节长度和 CRC 是否正确。
- 下一状态和日志摘要是否符合预期。

预览使用当前状态，但不会保存预览返回的新状态。连续点击预览可能因为随机数或当前时间而得到不同数据，但持久化序号不会推进。

### 导出

定时任务导出格式版本为 v3，脚本任务会包含：

- `apiVersion`
- `source`
- `initialState`
- `state`

导出包含当前状态，适合继续测试。不要在脚本源码或状态中保存密码、Token、密钥或个人数据。

### 导入

导入含脚本的任务时，助手会显示确认信息，包括脚本任务数量和源码大小。导入后任务默认不自动启动，必须检查 Debugfile 和脚本后手动启动。

从其他设备复制任务时，目标 Debugfile 必须具有相同 DP code 和兼容的数据定义，否则预览或启动会失败。

## 13. 沙箱与资源限制

脚本运行在 Rust 内嵌 QuickJS 沙箱中，不使用 WebView `eval`。脚本不能访问：

- 文件系统。
- 网络和 `fetch`。
- 环境变量和 `process`。
- `require`、Node.js 模块或浏览器 DOM。
- Tauri API。
- 串口 API 和任意发送函数。

当前限制：

| 项目            | 限制                                     |
| --------------- | ---------------------------------------- |
| 单次执行时间    | 100ms                                    |
| QuickJS 内存    | 8MB                                      |
| QuickJS 栈      | 256KB                                    |
| 脚本源码        | 64KB                                     |
| 持久化状态 JSON | 16KB                                     |
| 单次返回 DP     | 最多 64 个，且 code 不可重复             |
| 日志摘要        | 最多 180 个字符                          |
| String/Raw      | 不超过 Debugfile `maxlen`，缺省 255 字节 |

脚本应保持单次计算短小确定，不要使用死循环、深递归或创建大型数组。沙箱会中断超时脚本，但任务会进入错误状态。

## 14. 常见错误与排查

### `generate(ctx) is required`

脚本没有定义名为 `generate` 的函数，或函数被写在无法访问的局部作用域中。

### 脚本没有返回 DP

`skip` 不是 `true`，但 `reports` 为空。需要返回至少一个 DP，或明确设置 `skip: true`。

### 脚本返回了未知 DP

`code` 不在当前 Debugfile 中。注意应填写 DP code，而不是 DP 数字 ID 或页面显示名称。

```javascript
// 正确：code 是 Debugfile 的 code 字段。
{ code: "sensor_value", value: 50 }

// 错误：不能用数字 DP ID 代替 code。
{ code: "101", value: 50 }
```

### 脚本返回了重复 DP

同一次执行的 `reports` 中出现相同 code。应在脚本中先计算最终值，每个 DP 只返回一次。

### 脚本返回的 DP 值无效

依次检查：

1. Bool 是否为真正的 `true/false`。
2. Value/Bitmap 是否为整数，是否越界，是否从 `min` 起按 `step` 对齐。
3. Enum 是否存在于 `range`，数字下标是否越界。
4. String 是否为字符串或 `json(object)`。
5. Raw 是否为偶数长度 hex、合法字节数组或 `raw(bytes)`。

### 脚本返回的 DP 数据过长

String 使用 UTF-8 字节数，Raw 使用实际字节数。检查 Debugfile 的 `maxlen`，精简 JSON 字段或拆分数据包。

### 定时脚本执行失败

检查 Monaco 标出的语法错误、异常信息、死循环、递归和过大的临时数组。脚本环境不是浏览器或 Node.js，不能使用 `fetch`、`window`、`document`、`process` 或 `require`。

### 预览成功但正式发送失败

预览不会打开串口。正式执行前确认：

- Debugfile 仍是预览时使用的文件。
- 串口已打开且未被其他程序占用。
- 网络门槛已经满足。
- 模组仍在线并能接收完整上报帧。

发送失败时脚本状态不会推进，可以修复连接后从原序号重试。

## 15. 启动前检查清单

- 已加载正确的 Debugfile，PID 与目标设备一致。
- 所有 `reports[].code` 都是 Debugfile 中的 DP code。
- Bool、Value、Enum、Bitmap、String、Raw 类型与 Debugfile 一致。
- Value/Bitmap 满足 `min/max/step`。
- String/Raw 长度不超过 `maxlen`。
- Raw 字节序、长度字段和 CRC 覆盖范围符合业务协议。
- `initialState` 是 JSON 对象，关键字段有缺省值。
- 已通过“测试生成”检查 patches、state 和 summary。
- 已确认任务的合并/逐个上报方式、网络条件和执行次数限制。
- 串口已打开，并先以较长间隔进行小次数验证。

## 16. 完整通用模板

下面的模板演示范围随机、枚举随机、状态序号、JSON String、Raw 和多 DP 同步上报。请根据自己的 Debugfile 删除不存在的 DP，并修改 Raw 业务格式。

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
  const statusRange = Array.isArray(statusPoint.property?.range) ? statusPoint.property.range : [];
  if (statusRange.length === 0) throw new Error("status has no enum range");

  const sensorValue = randomSteppedValue(valuePoint);
  const status = randomChoice(statusRange);
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

建议先保留一个 DP 完成预览和串口验证，再逐步加入 JSON、Raw 和其他关联 DP。这样更容易定位是 DP 定义、业务组包还是串口连接导致的问题。
