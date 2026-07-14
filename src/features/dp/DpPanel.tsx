import type { DpPoint, DpSchema } from "../../types";
import { DpRow } from "./DpEditors";
import { useTranslation } from "react-i18next";

export function DpPanel({
  schema,
  groups,
  values,
  filter,
  onFilterChange,
  onReport,
}: {
  schema: DpSchema | null;
  groups: Array<[string, DpPoint[]]>;
  values: Record<string, unknown>;
  filter: string;
  onFilterChange: (value: string) => void;
  onReport: (point: DpPoint, value: unknown) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="panel dp-panel">
      <div className="panel-head">
        <h2>{t("dp.title")}</h2>
        <input
          className="search"
          placeholder={t("dp.search")}
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
        />
      </div>
      <div className="dp-table">
        {!schema ? (
          <div className="empty-state">{t("dp.empty")}</div>
        ) : (
          groups.map(([group, points]) => (
            <div className="group" key={group}>
              <h3>{group}</h3>
              {points.map((point) => (
                <DpRow
                  key={point.id}
                  point={point}
                  value={values[point.code]}
                  onChange={(value) => onReport(point, value)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
