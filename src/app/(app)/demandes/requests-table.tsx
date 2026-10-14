"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FilterX, Paperclip, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { ADMIN_REQUEST_TYPE, ADMIN_REQUEST_STATUS, PRIORITY } from "@/lib/labels";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { typeRetire } from "@/lib/secretariat/traitement";
import { TUILES, dansLaTuile, enRetard, LIBELLE_ETAPE_MONTANT, type CleTuile, type ChezQui, type EtapeMontant } from "@/lib/secretariat/bureau";

/**
 * LE TABLEAU DU BUREAU (maquette validée, 10/2026) — des tuiles qui COMPTENT et FILTRENT, une
 * recherche, le type et le département ; puis une ligne par demande, cliquable en entier.
 * Les filtres se cumulent ; recliquer une tuile la retire. Rien ne recharge la page.
 */

export interface RequestRow {
  id: string;
  reference: string;
  title: string;
  type: string;
  priority: string;
  status: string;
  createdAt: string;
  deadline: string | null;
  completedAt: string | null;
  requester: string | null;
  department: string | null;
  chez: ChezQui | null;
  montant: number | null;
  montantEtape: EtapeMontant | null;
  pieces: number;
  batch: boolean;
}

/** Ce que le serveur a chargé, et ce qu'il a laissé — pour que la liste ne se lise jamais comme exhaustive à tort. */
export interface TotauxDemandes { ouvertes: number; terminees: number; terminesMontrees: number; coupe: boolean }

const POINT_PRIORITE: Record<string, string> = {
  LOW: "bg-muted-foreground/60", MEDIUM: "bg-primary", HIGH: "bg-warning", CRITICAL: "bg-destructive",
};
const champ = "h-9 rounded-md border border-input bg-card px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring";
const court = (iso: string) => formatDate(iso, { day: "2-digit", month: "short" });

export function RequestsTable({ rows, totaux, maintenant }: {
  rows: RequestRow[];
  totaux?: TotauxDemandes;
  /** L'heure du rendu SERVEUR : le serveur et le navigateur comptent les retards sur la même minute. */
  maintenant: number;
}) {
  const router = useRouter();
  const [tuile, setTuile] = React.useState<CleTuile | null>(null);
  const [q, setQ] = React.useState("");
  const [type, setType] = React.useState("");
  const [dep, setDep] = React.useState("");

  const ligneTuile = (r: RequestRow) => ({ statut: r.status, echeance: r.deadline, termineeLe: r.completedAt });
  const compte = (t: CleTuile) => rows.filter((r) => dansLaTuile(ligneTuile(r), t, maintenant)).length;
  const aiguille = q.trim().toLowerCase();
  const shown = rows.filter((r) => {
    if (tuile && !dansLaTuile(ligneTuile(r), tuile, maintenant)) return false;
    if (type && r.type !== type) return false;
    if (dep && r.department !== dep) return false;
    if (aiguille && !`${r.reference} ${r.title} ${r.requester ?? ""}`.toLowerCase().includes(aiguille)) return false;
    return true;
  });
  const actif = Boolean(tuile || q || type || dep);
  // Un type retiré (« Mission chauffeur », « Demande RH ») ne se propose au filtre que s'il reste des demandes à relire.
  const typesPresents = new Set(rows.map((r) => r.type));
  const typesFiltre = Object.entries(ADMIN_REQUEST_TYPE).filter(([v]) => !typeRetire(v) || typesPresents.has(v));
  const departements = [...new Set(rows.map((r) => r.department).filter((d): d is string => Boolean(d)))].sort((a, b) => a.localeCompare(b, "fr"));
  const ouvrir = (id: string) => router.push(`/demandes/${id}`);

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Filtrer par étape" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {TUILES.map((t) => {
          const n = compte(t.cle);
          const on = tuile === t.cle;
          return (
            <button
              key={t.cle} type="button" aria-pressed={on} onClick={() => setTuile(on ? null : t.cle)}
              className={cn("surface grid gap-0.5 rounded-xl px-3.5 py-3 text-left transition-colors hover:bg-secondary/40", on && "border-primary bg-primary/5 ring-1 ring-primary")}
            >
              <span className={cn("text-2xl font-bold tabular-nums", t.alerte && n > 0 && "text-destructive")}>{n}</span>
              <span className="text-xs font-medium text-muted-foreground">{t.libelle}</span>
            </button>
          );
        })}
      </div>

      <div className="surface overflow-hidden rounded-xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
          <label className="relative min-w-0 flex-[1_1_14rem]">
            <span className="sr-only">Rechercher</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher : référence, titre, demandeur…" className={cn(champ, "w-full pl-8")} />
          </label>
          <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className={cn(champ, "min-w-0 max-w-full")}>
            <option value="">Tous les types</option>
            {typesFiltre.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select aria-label="Département" value={dep} onChange={(e) => setDep(e.target.value)} className={cn(champ, "min-w-0 max-w-full")}>
            <option value="">Tous les départements</option>
            {departements.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          {actif && (
            <button type="button" onClick={() => { setTuile(null); setQ(""); setType(""); setDep(""); }}
              className="inline-flex h-9 items-center gap-1 rounded-md border border-input px-2.5 text-xs font-medium hover:bg-secondary">
              <FilterX className="h-3.5 w-3.5" /> Réinitialiser
            </button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {shown.length} demande{shown.length > 1 ? "s" : ""} sur {rows.length}
            {totaux && (totaux.coupe ? " — les plus récentes seulement" : "")}
            {totaux && totaux.terminees > totaux.terminesMontrees ? ` · ${totaux.terminesMontrees} dernières terminées sur ${totaux.terminees}` : ""}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[66rem] border-collapse text-sm">
            <thead>
              <tr className="bg-secondary/50 text-left text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
                <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Référence</th>
                <th className="px-3 py-2.5 font-semibold">Demande</th>
                <th className="px-3 py-2.5 font-semibold">Demandeur</th>
                <th className="px-3 py-2.5 font-semibold">Créée</th>
                <th className="px-3 py-2.5 font-semibold">Échéance</th>
                <th className="px-3 py-2.5 font-semibold">Chez qui</th>
                <th className="px-3 py-2.5 text-right font-semibold">Montant</th>
                <th className="px-3 py-2.5 font-semibold">Pièces</th>
                <th className="px-3 py-2.5 font-semibold">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-sm text-muted-foreground">Aucune demande avec ces filtres.</td></tr>
              ) : shown.map((r) => {
                const retard = enRetard({ statut: r.status, echeance: r.deadline }, maintenant);
                const prio = PRIORITY[r.priority]?.label ?? r.priority;
                return (
                  <tr
                    key={r.id} tabIndex={0} role="link" aria-label={`Ouvrir ${r.reference} — ${r.title}`}
                    onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) ouvrir(r.id); }}
                    onKeyDown={(e) => { if (e.key === "Enter") ouvrir(r.id); }}
                    className="cursor-pointer hover:bg-secondary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-muted-foreground">{r.reference}</td>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold">
                        <span className={cn("mr-1.5 inline-block h-2 w-2 rounded-full align-middle", POINT_PRIORITE[r.priority] ?? "bg-muted")} title={`Priorité ${prio}`} aria-label={`Priorité ${prio}`} />
                        <Link href={`/demandes/${r.id}`} className="hover:underline">{r.title}</Link>
                        {r.batch && <Badge tone="info" dot={false} className="ml-2 align-middle">Lot</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground">{ADMIN_REQUEST_TYPE[r.type] ?? r.type}{r.department ? ` · ${r.department}` : ""}</div>
                    </td>
                    <td className="px-3 py-2.5">{r.requester ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">{court(r.createdAt)}</td>
                    <td className={cn("whitespace-nowrap px-3 py-2.5 text-xs", retard ? "font-semibold text-destructive" : "text-muted-foreground")}>
                      {r.deadline ? court(r.deadline) : "—"}{retard ? " · en retard" : ""}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {r.chez ? <><span className="font-semibold">{r.chez.etape}</span>{r.chez.personne && <div className="text-muted-foreground">{r.chez.personne}</div>}</> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                      {r.montant != null ? <><span>{formatCurrency(r.montant)}</span>{r.montantEtape && <div className="text-[0.6875rem] text-muted-foreground">{LIBELLE_ETAPE_MONTANT[r.montantEtape]}</div>}</> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground"><Paperclip className="mr-0.5 inline h-3 w-3" />{r.pieces}</td>
                    <td className="px-3 py-2.5"><StatusBadge map={ADMIN_REQUEST_STATUS} value={r.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
