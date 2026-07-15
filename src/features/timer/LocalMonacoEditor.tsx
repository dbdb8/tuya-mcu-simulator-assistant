import Editor, { loader, type BeforeMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

const SCRIPT_TYPES = `
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type DpReport = { code: string; value: JsonValue | number[] };
type TimerContext = {
  nowMs: number; nowUnix: number; runIndex: number;
  state: Record<string, JsonValue>; values: Record<string, JsonValue>;
  schema: { product_key: string; points: Array<{ id: number; code: string; kind: string; property: Record<string, JsonValue> }> };
  network: { code: number; label: string }; task: { id: string; name: string; runCount: number }; preview: boolean;
};
declare function randomInt(min: number, max: number): number;
declare function randomChoice<T>(values: T[]): T;
declare function clamp(value: number, min: number, max: number): number;
declare function u16le(value: number): number[];
declare function u32le(value: number): number[];
declare function concatBytes(...arrays: number[][]): number[];
declare function crc16Modbus(bytes: number[]): number;
declare function bytesToHex(bytes: number[]): string;
declare function raw(bytes: number[]): { $raw: number[] };
declare function json(value: JsonValue): { $json: JsonValue };
declare function generate(ctx: TimerContext): {
  reports: DpReport[]; state: Record<string, JsonValue>; summary?: string; skip?: boolean;
};
`;

// Monaco 默认从 CDN 加载；桌面调试工具必须在离线现场可用，因此显式绑定本地模块和 Worker。
loader.config({ monaco });
(
  globalThis as unknown as { MonacoEnvironment: { getWorker: (_moduleId: string, label: string) => Worker } }
).MonacoEnvironment = {
  getWorker: (_moduleId, label) =>
    label === "typescript" || label === "javascript" ? new TypeScriptWorker() : new EditorWorker(),
};

const beforeMount: BeforeMount = (instance) => {
  const typescript = instance.languages.typescript as unknown as {
    javascriptDefaults: {
      addExtraLib: (content: string, filePath?: string) => unknown;
      setDiagnosticsOptions: (options: Record<string, unknown>) => void;
      setCompilerOptions: (options: Record<string, unknown>) => void;
    };
    ScriptTarget: { ES2020: number };
  };
  typescript.javascriptDefaults.addExtraLib(SCRIPT_TYPES, "ts:timer-script-api.d.ts");
  typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  typescript.javascriptDefaults.setCompilerOptions({
    allowNonTsExtensions: true,
    checkJs: true,
    target: typescript.ScriptTarget.ES2020,
  });
};

export function LocalMonacoEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Editor
      height="320px"
      language="javascript"
      theme="vs-dark"
      value={value}
      beforeMount={beforeMount}
      onChange={(nextValue) => onChange(nextValue ?? "")}
      options={{
        minimap: { enabled: false },
        automaticLayout: true,
        fontSize: 13,
        tabSize: 2,
        scrollBeyondLastLine: false,
        wordWrap: "on",
      }}
    />
  );
}
