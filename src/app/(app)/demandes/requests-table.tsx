"use client";

import * as React from "react";
import Link from "next/link";
import { FilterX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { ADMIN_REQUEST_TYPE, ADMIN_REQUEST_STATUS, PRIORITY } from "@/lib/labels";
import { formatDate } from "@/lib/utils";
import { STATUTS_FILTRABLES, typeRetire } from "@/lib/secretariat/traitement";

/**
 * LES DEMANDES DU SECRÉTARIAT — un tableau qui se filtre PAR SES COLONNES.
 *
 * L'ancienne rangée d'onglets de statut (Toutes · Nouvelle · En cours · …) occupait une ligne
 * entière pour un seul critère, et rechargeait la page à chaque clic. Chaque colonne porte
 * désormais son filtre, du type qui lui va : du texte où l'on cherche un mot, un menu là où les
 * valeurs sont finies (type, priorité, statut), un mois pour l'échéance.
 */

export interface RequestRow {
  id: string;
  reference: string;
  title: string;
  type: string;
  priority: string;
  status: string;
  deadline: string | null;
  assignedTo: string | null;
  batch: boolean;
}

const cellInput = "h-8 w-full rounded-md border border-input bg-card px-2 text-xs font-normal normal-case tracking-normal outline-none focus:ring-1 focus:ring-ring";
const EMPTY = { reference: "", title: "", type: "", priority: "", status: "", deadlineMonth: "", assignee: "" };

/** Ce que le serveur a chargé, et ce qu'il a laissé — pour que la liste ne se lise jamais comme exhaustive à tort. */
export interface TotauxDemandes { ouvertes: number; terminees: number; terminesMontrees: number; coupe: boolean }

export function RequestsTable({ rows, totaux }: { rows: RequestRow[]; totaux?: TotauxDemandes }) {
  const [f, setF] = React.useState({ ...EMPTY });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  const has = (hay: string | null, needle: string) => (hay ?? "").toLowerCase().includes(needle.toLowerCase());

  const shown = rows.filter((r) => {
    if (f.reference && !has(r.reference, f.reference)) return false;
    if (f.title && !has(r.title, f.title)) return false;
    if (f.type && r.type !== f.type) return false;
    if (f.priority && r.priority !== f.priority) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.deadlineMonth && !(r.deadline ?? "").startsWith(f.deadlineMonth)) return false;
    if (f.assignee && !has(r.assignedTo, f.assignee)) return false;
    return true;
  });
  const active = Object.values(f).some(Boolean);
  // Un type retiré (« Mission chauffeur », « Demande RH ») ne se propose au filtre que s'il reste des demandes à relire.
  const typesPresents = new Set(rows.map((r) => r.type));
  const typesFiltre = Object.entries(ADMIN_REQUEST_TYPE).filter(([v]) => !typeRetire(v) || typesPresents.has(v));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{shown.length} / {rows.length} demande{rows.length > 1 ? "s" : ""}</span>
        {totaux && (
          <span>
            · {totaux.ouvertes} ouverte{totaux.ouvertes > 1 ? "s" : ""}{totaux.coupe ? " (les plus récentes seulement — affinez par statut ou par type)" : ", toutes chargées"}
            {totaux.terminees > totaux.terminesMontrees ? ` · les ${totaux.terminesMontrees} dernières terminées sur ${totaux.terminees}` : ""}
          </span>
        )}
        {active && (
          <button type="button" onClick={() => setF({ ...EMPTY })}
            className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 font-medium hover:bg-secondary">
            <FilterX className="h-3.5 w-3.5" /> Réinitialiser
          </button>
        )}
      </div>

      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[56rem] border-collapse text-sm">
          <thead className="border-b border-border">
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 pt-2 text-left font-medium">Référence</th>
              <th className="px-3 pt-2 text-left font-medium">Titre</th>
              <th className="px-3 pt-2 text-left font-medium">Type</th>
              <th className="px-3 pt-2 text-left font-medium">Priorité</th>
              <th className="px-3 pt-2 text-left font-medium">Statut</th>
              <th className="px-3 pt-2 text-left font-medium">Échéance</th>
              <th className="px-3 pt-2 text-left font-medium">Responsable</th>
            </tr>
            <tr>
              <th className="px-2 pb-2 pt-1"><input value={f.reference} onChange={set("reference")} placeholder="Filtrer" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1"><input value={f.title} onChange={set("title")} placeholder="Filtrer" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1">
                <select value={f.type} onChange={set("type")} className={cellInput}>
                  <option value="">Tous</option>
                  {typesFiltre.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </th>
              <th className="px-2 pb-2 pt-1">
                <select value={f.priority} onChange={set("priority")} className={cellInput}>
                  <option value="">Toutes</option>
                  {Object.entries(PRIORITY).map(([v, d]) => <option key={v} value={v}>{d.label}</option>)}
                </select>
              </th>
              <th className="px-2 pb-2 pt-1">
                <select value={f.status} onChange={set("status")} className={cellInput}>
                  <option value="">Tous</option>
                  {STATUTS_FILTRABLES.map((v) => <option key={v} value={v}>{ADMIN_REQUEST_STATUS[v]?.label ?? v}</option>)}
                </select>
              </th>
              <th className="px-2 pb-2 pt-1"><input type="month" value={f.deadlineMonth} onChange={set("deadlineMonth")} title="Mois d'échéance" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1"><input value={f.assignee} onChange={set("assignee")} placeholder="Nom" className={cellInput} /></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">Aucune demande ne correspond à ces filtres.</td></tr>
            ) : shown.map((r) => (
              <tr key={r.id} className="hover:bg-secondary/30">
                <td className="px-3 py-2 font-mono text-xs">{r.reference}</td>
                <td className="px-3 py-2 font-medium">
                  <Link href={`/demandes/${r.id}`} className="hover:underline">{r.title}</Link>
                  {r.batch && <Badge tone="info" dot={false} className="ml-2 align-middle">Lot</Badge>}
                </td>
                <td className="px-3 py-2">{ADMIN_REQUEST_TYPE[r.type] ?? r.type}</td>
                <td className="px-3 py-2"><StatusBadge map={PRIORITY} value={r.priority} dot={false} /></td>
                <td className="px-3 py-2"><StatusBadge map={ADMIN_REQUEST_STATUS} value={r.status} /></td>
                <td className="px-3 py-2 text-muted-foreground">{r.deadline ? formatDate(r.deadline) : "—"}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.assignedTo ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
