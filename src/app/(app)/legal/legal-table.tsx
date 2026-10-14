"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FilterX, Loader2, RefreshCw, Ban, Paperclip, ExternalLink, Lock, FolderInput, Check, Undo2 } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { LEGAL_DOC_KIND, LEGAL_DOC_STATUS, LEGAL_EXPIRY_LEVEL, natureLegale } from "@/lib/labels";
import { renewLegalDocument, cancelLegalDocument, restoreLegalDocument } from "@/lib/actions/legal-actions";
import { setInvoicePaid } from "@/lib/actions/invoice-actions";
import { peutDaterLeReglement } from "@/lib/finances/settlement";
import { moveLegalDocuments } from "@/lib/actions/legal-folder-actions";
import { PartagerButton } from "@/components/shared/partager-button";
import { invoiceSettlementState, INVOICE_SETTLEMENT, isInvoice } from "@/lib/labels";
import { legalWriteAllowed } from "@/lib/lecteurs/legal";
import {
  EMPTY_FILTERS, URGENT_EXPIRY,
  initialLegalListState, syncLegalListState, visibleLegalRows, hasActiveFilter, describeActiveFilters,
  type LegalColumnFilters, type LegalListRow,
} from "@/lib/legal/list-view";

/**
 * LES ENGAGEMENTS DE LA SOCIÉTÉ, EN TABLEAU FILTRABLE.
 *
 * Ce qu'on vient chercher ici, à 90 %, c'est « qu'est-ce qui arrive à échéance ? ». La colonne
 * ÉCHÉANCE porte donc son urgence en couleur, et le filtre « à surveiller » isole en un clic ce
 * qui expire dans les trois mois. Les documents SANS date ne sont jamais rangés dans l'urgence :
 * ils n'expirent pas, et les faire clignoter apprendrait à ignorer les vrais.
 */

/**
 * La ligne AFFICHÉE — définie une seule fois, dans `lib/legal/list-view`, avec la règle de
 * filtrage qui la consomme. Deux définitions de la même ligne finissent toujours par diverger.
 */
export type LegalRow = LegalListRow;

const cellInput = "h-9 w-full rounded-md border border-input bg-card px-2 text-base sm:h-8 sm:text-xs font-normal normal-case tracking-normal outline-none focus:ring-1 focus:ring-ring";

const URGENT = URGENT_EXPIRY;

export function LegalTable({
  rows, canEdit, droitsEcriture, watchByDefault = false, folders = [], currentFolderId = null, scope, initialKind = "",
}: {
  rows: LegalRow[];
  canEdit: boolean;
  /**
   * LES DROITS QUI DÉCIDENT DES GESTES DE LIGNE (audit 360°, R16) — les mêmes que lisent les actions
   * (`legalWriteAllowed`) : « Renouveler », « Annuler », « Rétablir » étaient offerts aux Finances sur
   * des pièces que l'action leur refusait. Un bouton qu'une action refuse fait chercher une panne.
   */
  droitsEcriture: { legal: { creer: boolean; modifier: boolean }; finances: { creer: boolean; modifier: boolean } };
  watchByDefault?: boolean;
  /**
   * La NATURE demandée par l'URL (`?nature=INVOICE`). Elle se pose comme un filtre de colonne
   * ORDINAIRE — visible, et retirable d'un clic : « les factures » est une vue de cette liste,
   * pas un écran verrouillé.
   */
  initialKind?: string;
  /** Dossiers de classement disponibles — vide : le classement n'est pas proposé. */
  folders?: { id: string; name: string }[];
  currentFolderId?: string | null;
  /**
   * LE PÉRIMÈTRE de la liste servie — dossier ouvert, arrivée par un rappel d'échéance.
   *
   * C'est LUI qui ferme le bogue des documents « disparus » : la navigation par dossier passe
   * par `<Link>`, donc le composant reste monté et son état de filtrage survivrait au
   * changement de liste. Quand le périmètre change, les filtres de la liste précédente
   * tombent — voir `lib/legal/list-view`.
   */
  scope: string;
}) {
  const peutSurLaPiece = (verbe: "creer" | "modifier", kind: string) =>
    legalWriteAllowed({ onLegal: droitsEcriture.legal[verbe], onFinances: droitsEcriture.finances[verbe], kind });
  // « Réglée » / « À régler » ÉCRIVENT AU LIVRE : le geste de qui règle aux Finances, la même règle que l'action.
  const dateLeReglement = peutDaterLeReglement({ financesModifier: droitsEcriture.finances.modifier });
  const router = useRouter();
  const [state, setState] = React.useState(() => initialLegalListState(scope, watchByDefault, initialKind));
  const [busy, setBusy] = React.useState<string | null>(null);

  // AJUSTEMENT PENDANT LE RENDU (motif recommandé par React pour un état dérivé d'une
  // propriété) : pas d'effet, donc pas d'affichage intermédiaire où la liste apparaîtrait vide
  // le temps d'un battement.
  const synced = syncLegalListState(state, scope, watchByDefault, initialKind);
  if (synced !== state) setState(synced);

  const f = synced.filters;
  const watchOnly = synced.watchOnly;
  const unpaidOnly = synced.unpaidOnly;
  const setF = (next: (p: LegalColumnFilters) => LegalColumnFilters) =>
    setState((p) => ({ ...p, filters: next(p.filters) }));
  const setWatchOnly = (next: (v: boolean) => boolean) =>
    setState((p) => ({ ...p, watchOnly: next(p.watchOnly) }));
  const setUnpaidOnly = (next: (v: boolean) => boolean) =>
    setState((p) => ({ ...p, unpaidOnly: next(p.unpaidOnly) }));

  const set = (k: keyof LegalColumnFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value;
    setF((p) => ({ ...p, [k]: v }));
  };

  const shown = visibleLegalRows(rows, synced);
  const active = hasActiveFilter(synced);
  const watchCount = rows.filter((r) => URGENT.has(r.expiry)).length;
  // LE RESTE À RÉGLER, sur les lignes servies — et son TOTAL, qui suit ce qui est AFFICHÉ :
  // filtrer puis additionner est le geste attendu, et un total qui répondrait pour autre chose
  // que le tableau sous les yeux ferait douter des deux.
  const impayee = (r: LegalRow) => isInvoice(r.kind) && !r.paidDate && r.status !== "CANCELLED";
  const unpaidCount = rows.filter(impayee).length;
  const shownInvoiceTotal = shown.filter(impayee).reduce((a, r) => a + (r.amount ?? 0), 0);

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (r.ok) {
      // Ce que le geste a ENTRAÎNÉ se dit (§118.185) : annuler une facture partie au règlement annule
      // aussi son ordre de dépense — le taire laisserait croire que le paiement attend toujours.
      if (r.message) window.alert(r.message);
      router.refresh();
    } else window.alert(r.error ?? "Échec.");
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{shown.length} / {rows.length} document{rows.length > 1 ? "s" : ""}</span>
        <button
          type="button" onClick={() => setWatchOnly((v) => !v)}
          className={cn("inline-flex min-h-9 items-center gap-1 rounded-md border px-2.5 py-1 font-medium sm:min-h-0 sm:px-2",
            watchOnly ? "border-warning/60 bg-warning/10 text-warning" : "border-input hover:bg-secondary")}
        >
          À surveiller ({watchCount})
        </button>
        {/* CE QUI RESTE À PAYER — l'unique bouton que l'écran dédié aux factures apportait
            vraiment. Il ne s'affiche que là où il y a des factures : un bouton à zéro sur une
            liste de baux n'est que du bruit. */}
        {unpaidCount > 0 && (
          <button
            type="button" onClick={() => setUnpaidOnly((v) => !v)}
            className={cn("inline-flex min-h-9 items-center gap-1 rounded-md border px-2.5 py-1 font-medium sm:min-h-0 sm:px-2",
              unpaidOnly ? "border-warning/60 bg-warning/10 text-warning" : "border-input hover:bg-secondary")}
          >
            Factures à régler ({unpaidCount})
          </button>
        )}
        {shownInvoiceTotal > 0 && (
          <span className="font-semibold text-foreground tabular-nums">Reste à payer affiché&nbsp;: {formatCurrency(shownInvoiceTotal)}</span>
        )}
        {active && (
          <button
            type="button"
            onClick={() => setState((p) => ({ ...p, filters: { ...EMPTY_FILTERS }, watchOnly: false, unpaidOnly: false }))}
            className="inline-flex min-h-9 items-center gap-1 rounded-md border border-input px-2.5 py-1 font-medium hover:bg-secondary sm:min-h-0 sm:px-2"
          >
            <FilterX className="h-3.5 w-3.5" /> Réinitialiser
          </button>
        )}
        {/* RANGER CE QU'ON VOIT. On classe depuis la liste, là où l'on constate qu'un engagement
            n'est pas au bon endroit — pas en rouvrant sa fiche une par une. Le classement ne
            change RIEN à qui peut lire le document. */}
        {canEdit && folders.length > 0 && shown.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <FolderInput className="h-3.5 w-3.5" />
            <select
              value="" disabled={busy === "move"}
              onChange={(e) => {
                const target = e.target.value;
                if (!target) return;
                e.target.value = "";
                const name = target === "none" ? "Non classés" : folders.find((x) => x.id === target)?.name ?? "";
                if (!window.confirm(`Ranger les ${shown.length} document(s) affiché(s) dans « ${name} » ?`)) return;
                const fd = new FormData();
                for (const r of shown) fd.append("documentId", r.id);
                if (target !== "none") fd.set("folderId", target);
                void run("move", () => moveLegalDocuments(fd));
              }}
              className="h-9 max-w-full rounded-md border border-input bg-background px-2 py-1 text-base font-medium sm:h-auto sm:text-xs"
              aria-label="Ranger les documents affichés dans un dossier"
            >
              <option value="">Ranger les {shown.length} affichés…</option>
              {folders.filter((x) => x.id !== currentFolderId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              {currentFolderId && <option value="none">Sortir du dossier</option>}
            </select>
          </span>
        )}
      </div>

      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[64rem] border-collapse text-sm">
          <thead className="border-b border-border">
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="sticky left-0 z-10 bg-card px-3 pt-2 text-left font-medium">Référence</th>
              <th className="px-3 pt-2 text-left font-medium">Titre exact</th>
              <th className="px-3 pt-2 text-left font-medium">Nature</th>
              <th className="px-3 pt-2 text-left font-medium">Partie</th>
              <th className="px-3 pt-2 text-left font-medium">Début</th>
              <th className="px-3 pt-2 text-left font-medium">Échéance</th>
              <th className="px-3 pt-2 text-right font-medium">Montant</th>
              <th className="px-3 pt-2 text-left font-medium">État</th>
              <th className="px-3 pt-2 text-left font-medium">Pièce</th>
              {canEdit && <th className="px-3 pt-2 text-left font-medium">Actions</th>}
            </tr>
            <tr>
              <th className="sticky left-0 z-10 bg-card px-2 pb-2 pt-1"><input value={f.reference} onChange={set("reference")} placeholder="Filtrer" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1"><input value={f.title} onChange={set("title")} placeholder="Filtrer" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1">
                <select value={f.kind} onChange={set("kind")} className={cellInput}>
                  <option value="">Toutes</option>
                  {Object.entries(LEGAL_DOC_KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </th>
              <th className="px-2 pb-2 pt-1"><input value={f.counterparty} onChange={set("counterparty")} placeholder="Filtrer" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1"><input type="month" value={f.startMonth} onChange={set("startMonth")} title="Mois de début" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1"><input type="month" value={f.endMonth} onChange={set("endMonth")} title="Mois d'échéance" className={cellInput} /></th>
              <th className="px-2 pb-2 pt-1" />
              <th className="px-2 pb-2 pt-1">
                <select value={f.status} onChange={set("status")} className={cellInput}>
                  <option value="">Tous</option>
                  {Object.entries(LEGAL_DOC_STATUS).map(([v, d]) => <option key={v} value={v}>{d.label}</option>)}
                </select>
              </th>
              <th className="px-2 pb-2 pt-1" />
              {canEdit && <th className="px-2 pb-2 pt-1" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.length === 0 ? (
              <tr>
                <td colSpan={canEdit ? 10 : 9} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {rows.length === 0 ? (
                    "Aucun engagement dans cette vue."
                  ) : (
                    // Il Y A des documents : ce sont les filtres qui les masquent. On le DIT, et
                    // on nomme lesquels — « aucun document » devant des colonnes visuellement
                    // vides fait croire à une perte de données.
                    <span className="flex flex-col items-center gap-2">
                      <span>
                        {rows.length} document{rows.length > 1 ? "s" : ""} dans cette vue, masqué
                        {rows.length > 1 ? "s" : ""} par&nbsp;: {describeActiveFilters(synced).join(", ")}.
                      </span>
                      <button
                        type="button"
                        onClick={() => setState((p) => ({ ...p, filters: { ...EMPTY_FILTERS }, watchOnly: false, unpaidOnly: false }))}
                        className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs font-medium hover:bg-secondary"
                      >
                        <FilterX className="h-3.5 w-3.5" /> Tout afficher
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ) : shown.map((r) => {
              const exp = LEGAL_EXPIRY_LEVEL[r.expiry];
              const st = LEGAL_DOC_STATUS[r.status];
              const etatReglement = invoiceSettlementState({ kind: r.kind, paidDate: r.paidDate, expenseOrderId: r.expenseOrderId });
              const reglement = INVOICE_SETTLEMENT[etatReglement];
              return (
                <tr key={r.id} className="align-middle hover:bg-secondary/30">
                  <td className="sticky left-0 z-10 bg-card px-3 py-2 font-mono text-xs text-muted-foreground">{r.reference || "—"}</td>
                  <td className="px-3 py-2">
                    <Link href={`/legal/${r.id}`} className="font-medium hover:underline">{r.title}</Link>
                    {r.restricted && (
                      <Lock className="ml-1 inline h-3 w-3 shrink-0 text-warning" aria-label="Accès restreint aux lecteurs désignés" />
                    )}
                    {r.renewedFromTitle && (
                      <span className="block text-[0.6875rem] text-muted-foreground">renouvelle « {r.renewedFromTitle} »</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{natureLegale(r.kind)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.counterparty || "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.startDate ? formatDate(r.startDate) : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.endDate ? (
                      <span className="flex flex-col">
                        <span>{formatDate(r.endDate)}</span>
                        {URGENT.has(r.expiry) && (
                          <Badge tone={exp?.tone ?? "neutral"} dot={false}>
                            {r.daysLeft !== null && r.daysLeft >= 0 ? `dans ${r.daysLeft} j` : "dépassée"}
                          </Badge>
                        )}
                      </span>
                    ) : (
                      // SANS ÉCHÉANCE : dit explicitement, pour qu'on ne croie pas à un oubli de saisie.
                      <span className="text-xs text-muted-foreground">sans échéance</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{r.amount !== null ? formatCurrency(r.amount) : "—"}</td>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge tone={st?.tone ?? "neutral"} dot={false}>{st?.label ?? r.status}</Badge>
                      {/* LE RÈGLEMENT, sur les seules factures — et en TROIS états : « payée /
                          à payer » ment sur le cas le plus fréquent, celui de la facture partie
                          au circuit dont quelqu'un s'occupe déjà. */}
                      {reglement && <Badge tone={reglement.tone} dot={false}>{reglement.label}</Badge>}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      {r.driveNodeId ? (
                        // Le fichier vit dans le DRIVE : on y renvoie, on n'en sert pas une copie.
                        <Link href={`/drive/${r.driveNodeId}`} title={r.driveName ?? undefined}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          <Paperclip className="h-3 w-3" /> Drive <ExternalLink className="h-3 w-3" />
                        </Link>
                      ) : <span className="text-xs text-muted-foreground">—</span>}
                      {/* PARTAGER DEPUIS LA LIGNE : le geste courant est « envoie-moi ça », pas
                          « ouvre la fiche puis envoie-la ». Il est ouvert à QUI VOIT, pas à qui
                          modifie — d'où sa place ici et non dans la colonne d'actions. */}
                      <PartagerButton
                        iconOnly variant="ghost"
                        refType="LEGAL_DOCUMENT" refId={r.id}
                        refLabel={r.reference ? `${r.reference} — ${r.title}` : r.title}
                        href={`/legal/${r.id}`}
                        driveNodeIds={r.driveNodeId ? [r.driveNodeId] : undefined}
                      />
                    </span>
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap items-center gap-1">
                        {/* LE GESTE LE PLUS FRÉQUENT d'une facture : dire qu'elle est réglée. Il
                            se fait DANS LA LIGNE — rouvrir une fiche pour cocher une date est ce
                            qui faisait tenir les règlements dans un tableur à côté. Une facture
                            partie au circuit n'a pas ce bouton : son paiement la soldera, et le
                            serveur le refuse de toute façon. */}
                        {dateLeReglement && etatReglement === "UNPAID" && (
                          <Button size="sm" variant="outline" disabled={busy === `p:${r.id}`}
                            onClick={() => void run(`p:${r.id}`, () => setInvoicePaid({ id: r.id, paidDate: new Date().toISOString() }))}>
                            {busy === `p:${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Réglée
                          </Button>
                        )}
                        {dateLeReglement && etatReglement === "PAID" && (
                          <Button size="sm" variant="ghost" disabled={busy === `p:${r.id}`}
                            onClick={() => void run(`p:${r.id}`, () => setInvoicePaid({ id: r.id, paidDate: null }))}>
                            {busy === `p:${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} À régler
                          </Button>
                        )}
                        {(r.status === "ACTIVE" || r.status === "EXPIRED") && (
                          <>
                            {/* Une facture ne se RENOUVELLE pas : on n'en réémet pas une pour la
                                période suivante, on en reçoit une autre. L'annulation, elle,
                                vaut pour toutes les natures. */}
                            {!isInvoice(r.kind) && peutSurLaPiece("creer", r.kind) && (
                              <Button size="sm" variant="outline" disabled={busy === `r:${r.id}`}
                                onClick={() => { const fd = new FormData(); fd.set("id", r.id); void run(`r:${r.id}`, () => renewLegalDocument(fd)); }}>
                                {busy === `r:${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Renouveler
                              </Button>
                            )}
                            {peutSurLaPiece("modifier", r.kind) && <Button size="sm" variant="ghost" disabled={busy === `c:${r.id}`}
                              onClick={() => {
                                // ABANDONNER LA BOÎTE NE FAIT RIEN (audit 360°, L04) : `?? ""` annulait le
                                // contrat sur le bouton « Annuler » de la boîte elle-même. Et un motif vide
                                // n'en est pas un — le serveur le refuse aussi.
                                const saisi = window.prompt("Motif de l'annulation (obligatoire) ?");
                                if (saisi === null) return;
                                const reason = saisi.trim();
                                if (!reason) { window.alert("Le motif de l'annulation est obligatoire : rien n'a été annulé."); return; }
                                const fd = new FormData(); fd.set("id", r.id); fd.set("reason", reason);
                                void run(`c:${r.id}`, () => cancelLegalDocument(fd));
                              }}>
                              <Ban className="h-3.5 w-3.5" /> Annuler
                            </Button>}
                          </>
                        )}
                        {/* RÉTABLIR un document annulé : l'annulation n'avait aucun retour (L04). */}
                        {r.status === "CANCELLED" && peutSurLaPiece("modifier", r.kind) && (
                          <Button size="sm" variant="outline" disabled={busy === `t:${r.id}`}
                            onClick={() => {
                              if (!window.confirm(`Rétablir « ${r.title} » ? Il reprendra l'état que sa date de fin lui donne, et ses rappels d'échéance reprendront.`)) return;
                              const fd = new FormData(); fd.set("id", r.id);
                              void run(`t:${r.id}`, () => restoreLegalDocument(fd));
                            }}>
                            {busy === `t:${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} Rétablir
                          </Button>
                        )}
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
