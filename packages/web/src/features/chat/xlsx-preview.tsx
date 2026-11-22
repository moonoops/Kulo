import { Button, Spinner, Tabs } from "@heroui/react";
import { useEffect, useState } from "react";
import type { ChatAttachment } from "@kulo/protocol";
import { translate as tr, useI18n } from "../../kulo-i18n";
import { fetchOfficeArchive, normalizeOfficeError, type OfficePreviewError } from "./office-archive";
import { columnIndexToLabel, XlsxWorkbookSession, type XlsxSheetData } from "./xlsx-parser";
import "./office-preview.css";

export default function XlsxPreview({ asset }: { asset: ChatAttachment }) {
  useI18n();
  const [session, setSession] = useState<XlsxWorkbookSession>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [sheet, setSheet] = useState<XlsxSheetData>();
  const [sheetLoading, setSheetLoading] = useState(false);
  const [error, setError] = useState<OfficePreviewError>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setSession(undefined);
    setSheet(undefined);
    setActiveIndex(0);
    setError(undefined);
    void (async () => {
      const archive = await fetchOfficeArchive(asset.id, controller.signal);
      const opened = await XlsxWorkbookSession.open(archive, undefined, controller.signal);
      if (controller.signal.aborted) return;
      setSession(opened);
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setError(normalizeOfficeError(reason, tr("表格预览失败", "Unable to preview spreadsheet")));
      }
    });
    return () => controller.abort();
  }, [asset.id, attempt]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    setSheetLoading(true);
    setError(undefined);
    void session.loadSheet(activeIndex, controller.signal).then(
      (loaded) => {
        if (!controller.signal.aborted) {
          setSheet(loaded);
          setSheetLoading(false);
        }
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setSheetLoading(false);
          setError(normalizeOfficeError(reason, tr("工作表解析失败", "Unable to parse worksheet")));
        }
      },
    );
    return () => controller.abort();
  }, [session, activeIndex]);

  if (error) {
    return (
      <div className="kulo-artifact-feedback" role="alert">
        <span>{error.message}</span>
        {error.retryable && (
          <Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>
            {tr("重试", "Retry")}
          </Button>
        )}
      </div>
    );
  }

  if (!session) {
    return (
      <div className="kulo-artifact-feedback" role="status">
        <Spinner size="sm" />
        <span>{tr("正在加载表格", "Loading spreadsheet")}</span>
      </div>
    );
  }

  const singleSheet = session.meta.sheets.length === 1;
  const metaSummary = sheet && (
    <div className="kulo-xlsx-meta">
      <span>{tr(`${sheet.totalRows} 行 × ${sheet.totalCols} 列`, `${sheet.totalRows} × ${sheet.totalCols}`)}</span>
      {sheet.hasUncalculatedFormulas && <span>· {tr("含未计算公式", "Uncalculated formulas")}</span>}
      {session.meta.truncatedSheets && (
        <span>· {tr(`仅展示前 ${session.meta.sheets.length} 个工作表`, `First ${session.meta.sheets.length} sheets`)}</span>
      )}
    </div>
  );

  const sheetBody = sheetLoading || !sheet ? (
    <div className="kulo-artifact-feedback" role="status">
      <Spinner size="sm" />
      <span>{tr("正在加载工作表", "Loading worksheet")}</span>
    </div>
  ) : sheet.renderedRows === 0 || sheet.renderedCols === 0 ? (
    <p className="kulo-office-empty">{tr("空工作表", "Empty worksheet")}</p>
  ) : (
    <>
      <div className="kulo-xlsx-scroll" role="region" aria-label={sheet.name} tabIndex={0}>
        <table className="kulo-xlsx-table">
          <thead>
            <tr>
              <th scope="col" className="kulo-xlsx-axis kulo-xlsx-axis--corner" aria-label={tr("行号", "Row")} />
              {Array.from({ length: sheet.renderedCols }, (_, colIndex) => (
                <th key={colIndex} scope="col" className="kulo-xlsx-axis kulo-xlsx-axis--col">
                  {columnIndexToLabel(colIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, rowIndex) => {
              const isHeader = sheet.hasHeaderRow && rowIndex === 0;
              return (
                <tr key={rowIndex}>
                  <th scope="row" className="kulo-xlsx-axis kulo-xlsx-axis--row">
                    {rowIndex + 1}
                  </th>
                  {row.map((cell, colIndex) => {
                    if (!cell) return null;
                    const CellTag = isHeader ? "th" : "td";
                    const classes = [
                      "kulo-xlsx-cell",
                      isHeader ? "kulo-table-header kulo-xlsx-cell--header" : "",
                      !isHeader && cell.align === "right" ? "kulo-xlsx-cell--number" : "",
                      !isHeader && cell.align === "center" ? "kulo-xlsx-cell--center" : "",
                      cell.kind === "formula" ? "kulo-xlsx-cell--formula" : "",
                      cell.kind === "error" ? "kulo-xlsx-cell--error" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <CellTag
                        key={colIndex}
                        scope={isHeader ? "col" : undefined}
                        rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                        colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                        title={cell.formula}
                        className={classes}
                      >
                        {cell.text}
                      </CellTag>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(sheet.truncatedRows || sheet.truncatedCols) && (
        <p className="kulo-office-notice">
          {tr(
            `仅预览前 ${sheet.renderedRows} 行 × ${sheet.renderedCols} 列（共 ${sheet.totalRows} 行 × ${sheet.totalCols} 列），完整数据请下载或在默认应用打开。`,
            `Showing first ${sheet.renderedRows} × ${sheet.renderedCols} of ${sheet.totalRows} × ${sheet.totalCols}. Download or open in default app for the full sheet.`,
          )}
        </p>
      )}
    </>
  );

  if (singleSheet) {
    return (
      <div className="kulo-xlsx-preview">
        <div className="kulo-xlsx-bar">
          <span className="kulo-xlsx-sheet-title">{session.meta.sheets[0]!.name}</span>
          {metaSummary}
        </div>
        {sheetBody}
      </div>
    );
  }

  return (
    <div className="kulo-xlsx-preview">
      <Tabs
        selectedKey={String(activeIndex)}
        onSelectionChange={(key) => {
          const next = Number(key);
          if (Number.isInteger(next) && next >= 0 && next < session.meta.sheets.length) {
            setActiveIndex(next);
          }
        }}
        className="kulo-xlsx-tabs w-full min-w-0"
      >
        <div className="kulo-xlsx-bar">
          <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0">
            <Tabs.List aria-label={tr("工作表", "Worksheets")} className="w-max">
              {session.meta.sheets.map((item) => (
                <Tabs.Tab key={item.index} id={String(item.index)} className="w-auto shrink-0 whitespace-nowrap">
                  {item.name}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
          {metaSummary}
        </div>
        {session.meta.sheets.map((item) => (
          <Tabs.Panel key={item.index} id={String(item.index)} className="kulo-xlsx-panel w-full min-w-0 flex-1">
            {item.index === activeIndex ? sheetBody : null}
          </Tabs.Panel>
        ))}
      </Tabs>
    </div>
  );
}
