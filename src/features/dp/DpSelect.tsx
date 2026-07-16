import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DpPoint } from "../../types";

export function DpSelect({
  points,
  value,
  onChange,
  invalid,
  compact = false,
}: {
  points: DpPoint[];
  value: string;
  onChange: (code: string) => void;
  invalid?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({ top: 0, left: 0, width: 320 });
  const selected = points.find((point) => point.code === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return points;
    return points.filter((point) => `${point.id} ${point.code} ${point.name}`.toLowerCase().includes(needle));
  }, [points, query]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const closeOnResize = () => setOpen(false);
    const closeOnOuterScroll = (event: Event) => {
      const target = event.target;
      // 下拉列表使用 Portal 挂到 body，内部滚动同样会冒泡到 window；仅外层滚动时关闭，
      // 否则用户拖动滚动条或使用滚轮浏览较长 DP 列表时弹层会立即消失。
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    window.addEventListener("resize", closeOnResize);
    window.addEventListener("scroll", closeOnOuterScroll, true);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("resize", closeOnResize);
      window.removeEventListener("scroll", closeOnOuterScroll, true);
    };
  }, [open]);

  function toggle() {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 340), window.innerWidth - 24);
      const left = Math.min(rect.left, window.innerWidth - width - 12);
      const below = rect.bottom + 6;
      const top = below + 330 > window.innerHeight ? Math.max(12, rect.top - 330) : below;
      setPosition({ top, left: Math.max(12, left), width });
      setQuery("");
    }
    setOpen((current) => !current);
  }

  const label = selected
    ? `DP${selected.id} ${selected.code}${compact ? "" : ` · ${selected.name}`}`
    : t("dp.select");
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`dp-picker-button ${invalid ? "invalid-control" : ""}`}
        aria-expanded={open}
        onClick={toggle}
      >
        <span title={label}>{label}</span>
        <ChevronsUpDown size={15} />
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="dp-picker-popover"
              style={{ top: position.top, left: position.left, width: position.width }}
            >
              <label className="dp-picker-search">
                <Search size={15} />
                <input
                  autoFocus
                  value={query}
                  placeholder={t("dp.searchSelect")}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="dp-picker-options">
                {filtered.length ? (
                  filtered.map((point) => {
                    const active = point.code === value;
                    return (
                      <button
                        type="button"
                        className={active ? "active" : ""}
                        key={point.code}
                        onClick={() => {
                          onChange(point.code);
                          setOpen(false);
                        }}
                      >
                        <b>DP{point.id}</b>
                        <span>{point.code}</span>
                        <em>{point.name}</em>
                        {active ? <Check size={15} /> : null}
                      </button>
                    );
                  })
                ) : (
                  <div className="dp-picker-empty">{t("dp.noSearchResult")}</div>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
