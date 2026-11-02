"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Download,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  header: string;
  className?: string;
  align?: "left" | "right" | "center";
  sortable?: boolean;
  /** Cell renderer. Defaults to the string value of `accessor`. */
  render?: (row: T) => React.ReactNode;
  /** Primitive value used for sorting, searching and CSV export. */
  accessor?: (row: T) => string | number | null | undefined;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  searchPlaceholder?: string;
  getRowHref?: (row: T) => string | undefined;
  filename?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  toolbar?: React.ReactNode;
  pageSize?: number;
  enableExport?: boolean;
}

function accessorValue<T>(col: Column<T>, row: T): string {
  if (col.accessor) {
    const v = col.accessor(row);
    return v === null || v === undefined ? "" : String(v);
  }
  const raw = (row as Record<string, unknown>)[col.key];
  return raw === null || raw === undefined ? "" : String(raw);
}

function toCsv<T>(columns: Column<T>[], rows: T[]): string {
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const header = columns.map((c) => escape(c.header)).join(",");
  const body = rows
    .map((row) => columns.map((c) => escape(accessorValue(c, row))).join(","))
    .join("\n");
  return `﻿${header}\n${body}`; // BOM for Excel UTF-8
}

export function DataTable<T>({
  columns,
  rows,
  searchPlaceholder = "Rechercher…",
  getRowHref,
  filename = "export",
  emptyTitle = "Aucune donnée",
  emptyDescription,
  toolbar,
  pageSize = 12,
  enableExport = true,
}: DataTableProps<T>) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [sortKey, setSortKey] = React.useState<string | null>(null);
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("asc");
  const [page, setPage] = React.useState(0);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.toLowerCase();
    return rows.filter((row) =>
      columns.some((col) => accessorValue(col, row).toLowerCase().includes(q)),
    );
  }, [rows, columns, query]);

  const sorted = React.useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return filtered;
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = accessorValue(col, a);
      const bv = accessorValue(col, b);
      const an = Number(av);
      const bn = Number(bv);
      const bothNumeric = av !== "" && bv !== "" && !Number.isNaN(an) && !Number.isNaN(bn);
      const cmp = bothNumeric ? an - bn : av.localeCompare(bv, "fr");
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDir, columns]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const paged = sorted.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  React.useEffect(() => setPage(0), [query, sortKey, sortDir]);

  function toggleSort(key: string) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortKey(null);
    }
  }

  function exportCsv() {
    const csv = toCsv(columns, sorted);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          {toolbar}
          {enableExport && (
            <Button variant="outline" size="sm" onClick={exportCsv} title="Exporter en CSV (Excel)">
              <Download className="h-4 w-4" />
              Export
            </Button>
          )}
        </div>
      </div>

      <div className="surface overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  className={cn(
                    col.align === "right" && "text-right",
                    col.align === "center" && "text-center",
                    col.className,
                  )}
                  aria-sort={col.sortable ? (sortKey === col.key ? (sortDir === "asc" ? "ascending" : "descending") : "none") : undefined}
                >
                  {/* UN VRAI BOUTON (audit 27/10/2026, FRONTEND-UX-03) : un `<th onClick>` ne se trie
                      ni au clavier ni au lecteur d'écran — Tab ne s'y arrête pas. */}
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="inline-flex select-none items-center gap-1 rounded focus-ring hover:text-foreground"
                    >
                      {col.header}
                      {sortKey === col.key ? (
                        sortDir === "asc" ? (
                          <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((row, i) => {
              const href = getRowHref?.(row);
              return (
                <TableRow
                  key={i}
                  className={href ? "cursor-pointer focus-ring" : undefined}
                  onClick={href ? () => router.push(href) : undefined}
                  // La ligne cliquable s'ouvre AUSSI au clavier : Tab s'y arrête, Entrée l'ouvre.
                  tabIndex={href ? 0 : undefined}
                  onKeyDown={href ? (e) => { if (e.key === "Enter" && e.target === e.currentTarget) router.push(href); } : undefined}
                >
                  {columns.map((col) => (
                    <TableCell
                      key={col.key}
                      className={cn(
                        col.align === "right" && "text-right",
                        col.align === "center" && "text-center",
                        col.className,
                      )}
                    >
                      {col.render ? col.render(row) : accessorValue(col, row) || "—"}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {sorted.length === 0 && (
          <div className="p-4">
            <EmptyState title={emptyTitle} description={emptyDescription} icon="SearchX" />
          </div>
        )}
      </div>

      {sorted.length > pageSize && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {sorted.length} résultat{sorted.length > 1 ? "s" : ""}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={currentPage === 0}
              aria-label="Page précédente"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-2">
              {currentPage + 1} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={currentPage >= pageCount - 1}
              aria-label="Page suivante"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
