"use client";

import * as React from "react";
import Link from "next/link";
import { FilterX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Table } from "@/components/ui/table";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import {
  AD_PRO_KINDS, AD_PRO_STATE, AD_PRO_ENTITY_TYPE, kindSpec,
  type AdProRequest, type AdProState, type AdProKind,
} from "@/modules/ad-pro/partage";
import { PartagerButton } from "@/components/shared/partager-button";

/**
 * LA LISTE UNIFIÉE. Ce qui ATTEND une décision est en tête (le tri vient du module pur) — une
 * liste rangée par date seule enterre les demandes bloquées depuis trois semaines sous celles de
 * ce matin, or ce sont précisément celles-là qu'il faut voir.
 *
 * On filtre DANS LES COLONNES, comme une vraie feuille : chaque en-tête porte son filtre (texte
 * pour la référence, l'objet, le bénéficiaire, le demandeur ; menu pour la nature et l'état ;
 * montant minimum ; date « à partir du »). Ils se COMBINENT — « Sponsoring » + « en attente » +
 * « ≥ 100 000 » répond à une question précise sans quitter le tableau.
 */

interface Filters {
  reference: string;
  kind: AdProKind | "";
  title: string;
  beneficiary: string;
  minAmount: string;
  requester: string;
  dateFrom: string;
  state: AdProState | "";
}

const EMPTY: Filters = {
  reference: "", kind: "", title: "", beneficiary: "", minAmount: "", requester: "", dateFrom: "", state: "",
};

const cellInput = "h-8 w-full rounded-md border border-input bg-card px-2 text-xs font-normal normal-case tracking-normal outline-none focus:ring-1 focus:ring-ring";
/** Le même filtre au téléphone : plus haut, police ≥ 16 px (pas de zoom iOS). */
const pastille = "inline-flex min-h-9 items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors sm:min-h-0";

export function AdProList({ rows }: { rows: AdProRequest[] }) {
  const [f, setF] = React.useState<Filters>(EMPTY);
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));

  const has = (hay: string | null, needle: string) => (hay ?? "").toLowerCase().includes(needle.toLowerCase());
  const shown = rows.filter((r) => {
    if (f.reference && !has(r.reference, f.reference)) return false;
    if (f.kind && r.kind !== f.kind) return false;
    if (f.title && !has(r.title, f.title)) return false;
    if (f.beneficiary && !has(r.beneficiary, f.beneficiary)) return false;
    if (f.minAmount && !(r.amount !== null && r.amount >= Number(f.minAmount))) return false;
    if (f.requester && !has(r.requester, f.requester)) return false;
    if (f.dateFrom && new Date(r.createdAt) < new Date(f.dateFrom)) return false;
    if (f.state && r.state !== f.state) return false;
    return true;
  });

  // Les valeurs proposées dans les menus se limitent à ce qui EXISTE dans la liste — inutile de
  // proposer « Consulting » s'il n'y a aucune demande de ce type.
  const kindsPresent = AD_PRO_KINDS.filter((k) => rows.some((r) => r.kind === k.kind));
  const statesPresent = (Object.keys(AD_PRO_STATE) as AdProState[]).filter((s) => rows.some((r) => r.state === s));
  const active = Object.values(f).some(Boolean);

  return (
    <div className="space-y-2">
      {/* LA VUE PAR CATÉGORIE — en plus du grand tableau où il y a tout. Une pastille par nature
          présente, avec son compte : un clic isole les demandes de matériel promotionnel, de
          consulting, de prise en charge… C'est le MÊME filtre que le menu de la colonne Nature —
          deux portes, une seule règle. */}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button" onClick={() => setF((p) => ({ ...p, kind: "" }))}
          className={`${pastille} ${
            !f.kind ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-secondary"
          }`}
        >
          Toutes ({rows.length})
        </button>
        {kindsPresent.map((k) => {
          const count = rows.filter((r) => r.kind === k.kind).length;
          const isOn = f.kind === k.kind;
          return (
            <button
              key={k.kind} type="button"
              onClick={() => setF((p) => ({ ...p, kind: isOn ? "" : k.kind }))}
              className={`${pastille} ${
                isOn ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-secondary"
              }`}
            >
              {k.label} ({count})
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{shown.length} / {rows.length} demande{rows.length > 1 ? "s" : ""}</span>
        {active && (
          <button type="button" onClick={() => setF(EMPTY)} className="inline-flex min-h-9 items-center gap-1 rounded-md border border-input px-2 py-1 font-medium hover:bg-secondary sm:min-h-0">
            <FilterX className="h-3.5 w-3.5" /> Réinitialiser les filtres
          </button>
        )}
      </div>

      <div className="surface overflow-x-auto">
        <Table className="table-clean min-w-[64rem]">
          <thead className="border-b border-border">
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 pt-2 text-left font-medium">Référence</th>
              <th className="px-3 pt-2 text-left font-medium">Nature</th>
              <th className="px-3 pt-2 text-left font-medium">Objet</th>
              <th className="px-3 pt-2 text-left font-medium">Bénéficiaire</th>
              <th className="px-3 pt-2 text-right font-medium">Montant</th>
              <th className="px-3 pt-2 text-left font-medium">Demandeur</th>
              <th className="px-3 pt-2 text-left font-medium">Date</th>
              <th className="px-3 pt-2 text-left font-medium">État</th>
            </tr>
            {/* La rangée de filtres, alignée sous chaque colonne. */}
            <tr>
              <th className="px-2 pb-2 pt-1"><input value={f.reference} onChange={set("reference")} placeholder="Filtrer" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1">
                <select value={f.kind} onChange={set("kind")} className={cellInput}>
                  <option value="">Toutes</option>
                  {kindsPresent.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </select>
              </th>
              <th className="px-2 pb-2 pt-1"><input value={f.title} onChange={set("title")} placeholder="Filtrer" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1"><input value={f.beneficiary} onChange={set("beneficiary")} placeholder="Filtrer" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1"><input type="number" value={f.minAmount} onChange={set("minAmount")} placeholder="≥" className={cn(cellInput, "text-right")} /></th>
              <th className="px-2 pb-2 pt-1"><input value={f.requester} onChange={set("requester")} placeholder="Filtrer" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1"><input type="date" value={f.dateFrom} onChange={set("dateFrom")} className={cellInput} title="À partir du" /></th>
              <th className="px-2 pb-2 pt-1">
                <select value={f.state} onChange={set("state")} className={cellInput}>
                  <option value="">Tous</option>
                  {statesPresent.map((s) => <option key={s} value={s}>{AD_PRO_STATE[s].label}</option>)}
                </select>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.length === 0 ? (
              <tr>
                <td colSpan={8} data-sans-etiquette className="px-3 py-8 text-center text-sm text-muted-foreground">Aucune demande ne correspond à ces filtres.</td>
              </tr>
            ) : (
              shown.map((r) => {
                const spec = kindSpec(r.kind);
                const st = AD_PRO_STATE[r.state];
                return (
                  <tr key={`${r.kind}-${r.id}`} className="hover:bg-secondary/50">
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.reference}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <Icon name={spec?.icon ?? "PartyPopper"} className="h-3.5 w-3.5 shrink-0 text-primary/80" />
                        {spec?.label ?? r.kind}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={r.href} className="font-medium hover:underline [overflow-wrap:anywhere]">{r.title}</Link>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{r.beneficiary || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.amount !== null ? formatCurrency(r.amount) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{r.requester || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatDate(r.createdAt)}</td>
                    <td className="px-3 py-2">
                      <span className="flex items-center justify-end gap-2 sm:justify-start">
                        <Badge tone={st.tone} dot={false}>{st.label}</Badge>
                        {/* « Envoie la demande de sponsoring de Benali à la Direction » : le geste
                            part de la LIGNE, sur la nature réelle du dossier — le serveur vérifie
                            l'accès à CET enregistrement, pas au module. */}
                        <PartagerButton
                          iconOnly variant="ghost"
                          refType={AD_PRO_ENTITY_TYPE[r.kind]} refId={r.id}
                          refLabel={`${r.reference} — ${r.title}`}
                          href={r.href}
                        />
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
