"use client";

import { CHEMIN_STOCK_PROMO, MENU_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import * as React from "react";
import Link from "next/link";
import { Boxes, Loader2, Plus, CheckCircle2, Trash2 } from "lucide-react";
import type { AdProStockLineStatut } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FAMILLE_LABEL, type PromoFamille } from "@/lib/promo/catalogue";
import { STATUT_LIGNE_LABEL } from "@/lib/promo/reservations";
import { ajouterArticleStockAuPoste, confirmerMaterielStock } from "../actions-postes-materiel";

/** Une ligne de matériel d'un poste, telle que l'écran la montre. */
export interface LigneStockVue {
  id: string;
  stockItemId: string;
  libelle: string;
  famille: PromoFamille;
  unite: string;
  quantite: number;
  statut: AdProStockLineStatut;
  utilisee: number | null;
  rendue: number | null;
  abimee: number | null;
  perdue: number | null;
  confirmeeLe: string | null;
  note: string | null;
}

/** Un article du magasin qu'un poste peut demander. */
export interface ArticleMagasinVue {
  itemId: string;
  libelle: string;
  famille: PromoFamille;
  unite: string;
  /** Ce qui s'y distribue aujourd'hui (lots non périmés) — une indication : l'accord relit tout. */
  distribuable: number;
}

export interface ContexteMaterielStock {
  /** Le magasin de la société de l'opération. */
  magasin: ArticleMagasinVue[];
  /** Cette personne confirme-t-elle le matériel après l'événement ? */
  peutConfirmer: boolean;
}

const nombre = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });
const TON: Record<AdProStockLineStatut, "neutral" | "warning" | "success"> = { DEMANDEE: "neutral", RESERVEE: "warning", CONFIRMEE: "success" };

/** « 120 remis, 30 revenus » / « 2 rendus, 1 abîmé » — ce que la confirmation a dit. */
function resultat(l: LigneStockVue): string {
  if (l.statut !== "CONFIRMEE") return "";
  if (l.famille === "DURABLE") {
    const parts = [`${nombre(l.rendue ?? 0)} rendu(s)`];
    if ((l.abimee ?? 0) > 0) parts.push(`${nombre(l.abimee ?? 0)} abîmé(s)`);
    if ((l.perdue ?? 0) > 0) parts.push(`${nombre(l.perdue ?? 0)} perdu(s)`);
    return parts.join(", ");
  }
  return `${nombre(l.utilisee ?? 0)} remis, ${nombre(l.rendue ?? 0)} revenu(s) au magasin`;
}

/**
 * LE MATÉRIEL DU STOCK D'UN POSTE (§118.167) — réserver avant, confirmer après, et le reste revient
 * tout seul. Le demandeur LISTE les articles du magasin (rien ne bouge) ; l'accord du poste les
 * RÉSERVE (ils quittent le magasin, personne ne peut plus les doter ailleurs) ; après l'événement,
 * on dit ce qui a été remis — ou, pour un durable PRÊTÉ, ce qui revient, s'abîme ou se perd — et le
 * reste rentre au magasin par la même écriture.
 *
 * Le formulaire de confirmation envoie, pour CHAQUE ligne, les quatre champs dans le même ordre
 * (les inutiles vides) : l'action les lit par rang, et une ligne qui en omettrait un décalerait
 * toutes les suivantes — la quantité remise d'une brochure lue comme celle d'un kakémono.
 */
export function BlocMaterielStock({
  itemId, lignes, magasin, editable, peutConfirmer, busy, run,
}: {
  itemId: string;
  lignes: LigneStockVue[];
  magasin: ArticleMagasinVue[];
  /** La liste se compose (brouillon, à revoir, refusé — et la personne décrit les postes). */
  editable: boolean;
  peutConfirmer: boolean;
  busy: string | null;
  run: (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, okText: string) => Promise<void>;
}) {
  const [article, setArticle] = React.useState("");
  const [quantite, setQuantite] = React.useState("");
  const [confirmant, setConfirmant] = React.useState(false);
  const reservees = lignes.filter((l) => l.statut === "RESERVEE");
  const deja = new Set(lignes.map((l) => l.stockItemId));
  const choisi = magasin.find((a) => a.itemId === article) ?? null;

  const ajouter = (stockItemId: string, q: string, okText: string) => {
    const fd = new FormData();
    fd.set("itemId", itemId);
    fd.set("stockItemId", stockItemId);
    fd.set("quantite", q);
    return run(`stock:${itemId}`, () => ajouterArticleStockAuPoste(fd), okText);
  };

  return (
    <div className="space-y-2 rounded-lg border border-border px-2.5 py-2 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <Boxes className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> Matériel pris au magasin
      </p>

      {lignes.length === 0 ? (
        <p className="text-muted-foreground">
          Aucun article listé. Choisissez ce qu&apos;il faut sortir du magasin pour l&apos;événement : rien n&apos;en sort avant l&apos;accord du poste.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {lignes.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm text-foreground">{l.libelle}</p>
                <p className="text-muted-foreground">
                  {nombre(l.quantite)} {l.unite} · {FAMILLE_LABEL[l.famille]}
                  {l.famille === "DURABLE" && l.statut !== "CONFIRMEE" && " — prêté : il revient après l'événement"}
                  {l.statut === "CONFIRMEE" && <> · {resultat(l)}</>}
                </p>
              </div>
              <Badge tone={TON[l.statut]} dot={false}>{STATUT_LIGNE_LABEL[l.statut]}</Badge>
              {editable && l.statut === "DEMANDEE" && (
                <button
                  type="button"
                  onClick={() => void ajouter(l.stockItemId, "0", "Article retiré du poste.")}
                  disabled={busy === `stock:${itemId}`}
                  className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 py-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:min-h-0"
                  aria-label={`Retirer ${l.libelle}`}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Retirer
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ── Lister un article : rien ne bouge au magasin avant l'accord ── */}
      {editable && (
        magasin.length === 0 ? (
          <p className="text-muted-foreground">
            Le magasin de cette société n&apos;a aucun article qui se compte. Il se garnit depuis{" "}
            <Link href={CHEMIN_STOCK_PROMO} className="text-primary hover:underline">{MENU_STOCK_PROMO}</Link>.
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!article || !quantite) return;
              void ajouter(article, quantite, "Article ajouté au poste.").then(() => { setArticle(""); setQuantite(""); });
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <label className="w-full min-w-0 sm:w-auto sm:flex-1">
              <span className="text-muted-foreground">Article du magasin</span>
              <select
                value={article} onChange={(e) => setArticle(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary/60"
              >
                <option value="">Choisir…</option>
                {magasin.map((a) => (
                  <option key={a.itemId} value={a.itemId}>
                    {a.libelle} — {nombre(a.distribuable)} {a.unite} au magasin{deja.has(a.itemId) ? " (déjà listé : la quantité sera remplacée)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 flex-1 sm:w-28 sm:flex-none">
              <span className="text-muted-foreground">Quantité</span>
              <input
                type="number" inputMode="decimal" min={0} step="any" value={quantite} onChange={(e) => setQuantite(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-right text-sm tabular-nums outline-none focus:border-primary/60"
              />
            </label>
            <Button size="sm" type="submit" variant="outline" className="h-10 sm:h-8" disabled={!article || !quantite || busy === `stock:${itemId}`}>
              {busy === `stock:${itemId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Lister
            </Button>
            {choisi && Number(quantite) > choisi.distribuable && (
              <p className="w-full text-warning">
                Le magasin n&apos;en a que {nombre(choisi.distribuable)} aujourd&apos;hui : l&apos;accord du poste sera refusé tant que la quantité dépasse ce qui s&apos;y distribue.
              </p>
            )}
          </form>
        )
      )}

      {/* ── Après l'événement : ce qui a été remis, ce qui revient ── */}
      {reservees.length > 0 && peutConfirmer && (
        confirmant ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              fd.set("itemId", itemId);
              void run(`confirm:${itemId}`, () => confirmerMaterielStock(fd), "Matériel confirmé.").then(() => setConfirmant(false));
            }}
            className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-2"
          >
            <p className="text-muted-foreground">
              Dites ce qui s&apos;est passé pendant l&apos;événement. Ce qui n&apos;a pas été remis revient au magasin, dans les lots d&apos;où il était sorti.
              Avant l&apos;événement, confirmer « 0 remis » annule la réservation.
            </p>
            {reservees.map((l) => (
              <fieldset key={l.id} className="rounded-lg border border-border bg-background p-2">
                <legend className="px-1 text-sm text-foreground">{l.libelle} — {nombre(l.quantite)} {l.unite} réservé(s)</legend>
                <input type="hidden" name="ligneId" value={l.id} />
                {l.famille === "DURABLE" ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <input type="hidden" name="utilisee" value="" />
                    <label>Rendus en état
                      <input name="rendue" type="number" inputMode="decimal" min={0} step="any" defaultValue={String(l.quantite)} className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-2 text-right tabular-nums sm:py-1" />
                    </label>
                    <label>Abîmés
                      <input name="abimee" type="number" inputMode="decimal" min={0} step="any" defaultValue="0" className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-2 text-right tabular-nums sm:py-1" />
                    </label>
                    <label>Perdus
                      <input name="perdue" type="number" inputMode="decimal" min={0} step="any" defaultValue="0" className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-2 text-right tabular-nums sm:py-1" />
                    </label>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="w-full sm:w-40">Remis pendant l&apos;événement
                      <input name="utilisee" type="number" inputMode="decimal" min={0} step="any" required className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-2 text-right tabular-nums sm:py-1" />
                    </label>
                    <input type="hidden" name="rendue" value="" />
                    <input type="hidden" name="abimee" value="" />
                    <input type="hidden" name="perdue" value="" />
                    <span className="text-muted-foreground">le reste revient au magasin</span>
                  </div>
                )}
              </fieldset>
            ))}
            <input name="note" placeholder="Précision (facultatif)" className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5" />
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button size="sm" type="submit" className="h-10 w-full sm:h-8 sm:w-auto" disabled={busy === `confirm:${itemId}`}>
                {busy === `confirm:${itemId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Confirmer
              </Button>
              <Button size="sm" type="button" variant="ghost" className="h-10 w-full sm:h-8 sm:w-auto" onClick={() => setConfirmant(false)}>Annuler</Button>
            </div>
          </form>
        ) : (
          <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => setConfirmant(true)}>
            <CheckCircle2 className="h-4 w-4" /> Confirmer le matériel après l&apos;événement
          </Button>
        )
      )}
      {reservees.length > 0 && !peutConfirmer && (
        <p className="text-muted-foreground">
          Le matériel réservé attend sa confirmation après l&apos;événement — par le demandeur, la gestionnaire du magasin ou la Direction.
        </p>
      )}
    </div>
  );
}
