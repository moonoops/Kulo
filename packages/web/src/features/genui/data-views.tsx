import { translate as tr, useI18n } from "../../moco-i18n";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Modal, Pagination, SearchField, Table, type Selection } from "@heroui/react";
import type { UiValue } from "@moco/protocol";
import { buildTableCsv, tableCsvFileName, type DataColumn, type DataRow } from "./table-csv";
import { displayTableValue, keyedTableRows, selectedTableIds, tableSelectionValue, tableView, type KeyedTableRow, type TableSelectionMode, type TableSort } from "./table-state";

export type { DataColumn, DataRow } from "./table-csv";
const PAGE_SIZE = 8;
interface TableSelection {
  mode: TableSelectionMode; value: UiValue | undefined; onChange: (value: UiValue) => void;
  isDisabled?: boolean; error?: string;
}
interface BodySelection {
  mode: TableSelectionMode; selectedKeys: Set<string>; onChange: (selection: Selection) => void;
  isDisabled?: boolean; error?: string;
}

function TableBody({ columns, rows, caption, sort, onSortChange, selection }: {
  columns: DataColumn[]; rows: KeyedTableRow[]; caption?: string;
  sort?: TableSort; onSortChange: (sort: TableSort) => void;
  selection?: BodySelection;
}) {
  useI18n();
  const errorId = useId();
  return <><Table className="moco-genui-table" variant="secondary">
    <Table.ScrollContainer>
      <Table.Content aria-label={caption || tr("数据表", "Data table")} sortDescriptor={sort} onSortChange={onSortChange}
        selectionMode={selection?.mode ?? "none"} selectionBehavior="toggle" selectedKeys={selection?.selectedKeys}
        onSelectionChange={selection?.onChange} disabledKeys={selection?.isDisabled ? rows.map((row) => row.id) : undefined}
        disabledBehavior="selection" aria-invalid={selection?.error ? true : undefined} aria-describedby={selection?.error ? errorId : undefined}>
        <Table.Header>
          {selection && <Table.Column id="__moco-selection" textValue={tr("选择", "Select")}>
            {selection.mode === "multiple" ? <Checkbox slot="selection" aria-label={tr("选择本页全部行", "Select all rows on this page")} isDisabled={selection.isDisabled || !rows.length}>
              <Checkbox.Content className="moco-genui-table-check"><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control></Checkbox.Content>
            </Checkbox> : <span>{tr("选择", "Select")}</span>}
          </Table.Column>}
          {columns.map((column, index) => <Table.Column key={column.key} id={column.key} isRowHeader={index === 0} allowsSorting>
            {column.label}
          </Table.Column>)}
        </Table.Header>
        <Table.Body renderEmptyState={() => <span className="moco-genui-note">{tr("暂无数据", "No data")}</span>}>
          {rows.map((row) => <Table.Row key={row.id} id={row.id} textValue={displayTableValue(row.data[columns[0]!.key])}>
            {selection && <Table.Cell><Checkbox slot="selection" variant="secondary"
              aria-label={tr(`选择${displayTableValue(row.data[columns[0]!.key])}`, `Select ${displayTableValue(row.data[columns[0]!.key])}`)} isDisabled={selection.isDisabled}>
              <Checkbox.Content className="moco-genui-table-check"><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control></Checkbox.Content>
            </Checkbox></Table.Cell>}
            {columns.map((column) => <Table.Cell key={column.key}>{displayTableValue(row.data[column.key])}</Table.Cell>)}
          </Table.Row>)}
        </Table.Body>
      </Table.Content>
    </Table.ScrollContainer>
  </Table>{selection?.error && <p id={errorId} className="moco-genui-error">{selection.error}</p>}</>;
}

export function DataTable(props: { columns: DataColumn[]; rows: DataRow[]; caption?: string; rowKey?: string; selection?: TableSelection }) {
  useI18n();
  const [sort, setSort] = useState<TableSort>();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [exportError, setExportError] = useState<string>();
  const downloadUrl = useRef<string | undefined>(undefined);
  const source = useMemo(() => keyedTableRows(props.rows, props.rowKey), [props.rows, props.rowKey]);
  const sourceIds = source.map((row) => row.id);
  const view = useMemo(() => tableView(source, props.columns, query, sort, page, PAGE_SIZE), [source, props.columns, query, sort, page]);
  const visibleIds = view.rows.map((row) => row.id);
  const selected = props.selection ? selectedTableIds(props.selection.value, props.selection.mode, sourceIds) : [];
  const selection: BodySelection | undefined = props.selection ? {
    mode: props.selection.mode, selectedKeys: new Set(selected.filter((id) => visibleIds.includes(id))),
    isDisabled: props.selection.isDisabled, error: props.selection.error,
    onChange: (next) => {
      if (props.selection && !props.selection.isDisabled) props.selection.onChange(tableSelectionValue(next, props.selection.mode, sourceIds, visibleIds, props.selection.value));
    },
  } : undefined;
  useEffect(() => () => { if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current); }, []);
  const exportCsv = () => {
    setExportError(undefined);
    try {
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      const blob = new Blob(["\ufeff", buildTableCsv(props.columns, props.rows)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      downloadUrl.current = url;
      const link = document.createElement("a");
      link.href = url;
      link.download = tableCsvFileName(props.caption);
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
    } catch {
      setExportError(tr("导出失败，请重试", "Export failed. Please retry."));
    }
  };
  const table = <div className="moco-genui-data">
    {props.rows.length > PAGE_SIZE && <SearchField className="moco-context-field" aria-label={tr("筛选表格", "Filter table")} value={query} onChange={(next) => { setQuery(next); setPage(1); }}
      variant="secondary" onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); } }}>
      <SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder={tr("筛选", "Filter")} /><SearchField.ClearButton className="moco-genui-control" /></SearchField.Group>
    </SearchField>}
    <TableBody {...props} rows={view.rows} sort={sort} onSortChange={(next) => { setSort(next); setPage(1); }} selection={selection} />
    {props.rows.length > PAGE_SIZE && <Pagination size="sm" aria-label={tr("表格分页", "Table pagination")}>
      <Pagination.Summary>{view.total} {tr("项 · ", "items · ")}{view.page} / {view.pageCount}</Pagination.Summary>
      <Pagination.Content>
        <Pagination.Item><Pagination.Previous className="moco-genui-control" isDisabled={view.page === 1} onPress={() => setPage(view.page - 1)} aria-label={tr("上一页", "Previous page")}><Pagination.PreviousIcon /></Pagination.Previous></Pagination.Item>
        <Pagination.Item><Pagination.Next className="moco-genui-control" isDisabled={view.page === view.pageCount} onPress={() => setPage(view.page + 1)} aria-label={tr("下一页", "Next page")}><Pagination.NextIcon /></Pagination.Next></Pagination.Item>
      </Pagination.Content>
    </Pagination>}
  </div>;
  return <div className="moco-genui-data">
    <div className="moco-genui-data-heading">
      {props.caption && <span className="moco-genui-label">{props.caption}</span>}
      {selected.length > 0 && <span className="moco-genui-label" role="status">{tr("已选 ", "Selected ")}{selected.length}</span>}
      <div className="moco-genui-data-actions"><Button size="sm" variant="ghost" className="moco-genui-control"
        aria-label={tr(`导出${props.caption || "数据表"} CSV`, `Export ${props.caption || "data table"} as CSV`)} onPress={exportCsv}>{tr("导出", "Export")}</Button><Modal>
        <Button size="sm" variant="ghost" className="moco-genui-control" aria-label={tr(`展开${props.caption || "数据表"}`, `Expand ${props.caption || "data table"}`)}>{tr("展开", "Expand")}</Button>
        <Modal.Backdrop>
          <Modal.Container size="cover" scroll="inside">
            <Modal.Dialog className="moco-genui-table-dialog">
              <Modal.CloseTrigger className="moco-genui-control" />
              <Modal.Header><Modal.Heading>{props.caption || tr("数据表", "Data table")}</Modal.Heading></Modal.Header>
              <Modal.Body>{table}{exportError && <p className="moco-genui-error" role="alert">{exportError}</p>}</Modal.Body>
              <Modal.Footer><Button size="sm" variant="secondary" className="moco-genui-control" onPress={exportCsv}>{tr("导出 CSV", "Export CSV")}</Button></Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal></div>
    </div>
    {table}
    {exportError && <p className="moco-genui-error" role="alert">{exportError}</p>}
  </div>;
}

export function DataChart({ type, data, label }: {
  type: "bar" | "line";
  data: { label: string; value: number }[];
  label?: string;
}) {
  useI18n();
  const [showData, setShowData] = useState(false);
  const low = Math.min(0, ...data.map((item) => item.value));
  const high = Math.max(1, ...data.map((item) => item.value));
  const height = 150;
  const width = 480;
  const y = (value: number) => 12 + (high - value) / (high - low || 1) * (height - 24);
  const step = width / Math.max(data.length, 1);
  const points = data.map((item, index) => `${step * (index + 0.5)},${y(item.value)}`).join(" ");
  return <figure className="moco-genui-chart">
    <figcaption className="moco-genui-data-heading">
      <span className="moco-genui-label">{label || tr("图表", "Chart")}</span>
      <Button size="sm" variant="ghost" className="moco-genui-control" onPress={() => setShowData((value) => !value)} aria-pressed={showData}>
        {showData ? tr("查看图表", "View chart") : tr("查看数据", "View data")}
      </Button>
    </figcaption>
    {showData ? <DataTable columns={[{ key: "label", label: tr("项目", "Item") }, { key: "value", label: tr("数值", "Value") }]} rows={data} />
      : <>
        <svg viewBox={`0 0 ${width} ${height}`} className="moco-genui-chart-image" role="img" aria-label={label || tr("图表", "Chart")}>
          <title>{label || tr("图表", "Chart")}</title>
          <line x1="0" x2={width} y1={y(0)} y2={y(0)} className="moco-genui-chart-baseline" />
          {type === "line" ? <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" /> : null}
          {data.map((item, index) => type === "bar"
            ? <rect key={index} x={step * index + step * 0.22} y={Math.min(y(item.value), y(0))}
              width={step * 0.56} height={Math.max(1, Math.abs(y(item.value) - y(0)))} rx="3" fill="currentColor">
              <title>{`${item.label}：${item.value}`}</title>
            </rect>
            : <circle key={index} cx={step * (index + 0.5)} cy={y(item.value)} r="3.5" fill="currentColor">
              <title>{`${item.label}：${item.value}`}</title>
            </circle>)}
        </svg>
        <div className="moco-genui-chart-labels" aria-hidden="true">
          {data.map((item, index) => <span key={index}>{item.label}</span>)}
        </div>
      </>}
  </figure>;
}
