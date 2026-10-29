import * as React from "react"; // le banc rend ce composant hors de Next (JSX classique) : React doit être en portée
import Link from "next/link";
import { ArrowRight, BadgeCheck, CircleDollarSign, Clock, Hourglass, ShieldCheck, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { natureLegale } from "@/lib/labels";
import { delayDays, delayLabel, missingKinds, amountDrift, CHAIN_KIND_LABEL } from "@/lib/legal/chain";
import type { ChainLink, ChainSettlement } from "@/lib/queries/legal-chain";
import { SendToSettlementButton } from "./send-to-settlement";
import { ordreClos } from "@/modules/finances/partage";

/**
 * LA CHAÎNE DU DOSSIER D'ACHAT — devis → bon de commande → facture → règlement, d'un seul écran.
 *
 * Chaque maillon montre SA date, SON montant et SES validateurs ; entre deux maillons, le DÉLAI en
 * jours — la question que pose la Direction et que personne ne calcule de tête. Au bout, le
 * règlement : son état, et s'il attend encore le centre de paiement. Un maillon que la personne ne
 * lit pas (`lisible: false`, décidé par le chargeur) garde sa place et sa nature, rien d'autre.
 *
 * L'écart devis / facture s'affiche dès qu'il existe : une facture au-dessus du devis n'est pas
 * forcément une erreur, mais elle doit se VOIR avant que l'argent parte.
 */
export function LegalChainCard({
  links, settlement, canSettle, settleBlocked = null,
}: {
  links: ChainLink[]; settlement: ChainSettlement | null; canSettle: boolean;
  /**
   * POURQUOI LA FACTURE NE PEUT PAS ENCORE PARTIR — dit AVANT le clic (§118.148).
   *
   * Une facture qui découle d'un bon de commande que son centre n'a pas validé ne part pas au
   * règlement. Offrir le bouton puis refuser après la confirmation ferait découvrir la règle au
   * pire moment ; la phrase vient du MÊME module que le refus de l'action (`blocageParLeBC`),
   * donc elle ne peut pas dire autre chose que lui.
   */
  settleBlocked?: string | null;
}) {
  if (links.length <= 1 && !settlement && !links.some((l) => ["QUOTE", "PURCHASE_ORDER", "INVOICE"].includes(l.kind))) {
    return null; // pièce isolée hors chaîne d'achat : la carte n'a rien à dire
  }

  const missing = missingKinds(links);
  const quote = links.find((l) => l.kind === "QUOTE");
  const invoice = [...links].reverse().find((l) => l.kind === "INVOICE");
  const drift = amountDrift(quote?.amount, invoice?.amount);
  const current = links.find((l) => l.isCurrent);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleDollarSign className="h-4 w-4" /> Chaîne du dossier d&apos;achat
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-3">
          {links.map((l, i) => {
            const prev = i > 0 ? links[i - 1] : null;
            const delay = prev ? delayLabel(delayDays(prev.date, l.date)) : null;
            return (
              <li key={l.id} className="space-y-1">
                {/* Le DÉLAI entre deux maillons — « +11 j » se lit, deux dates se calculent. */}
                {delay && (
                  <p className="flex items-center gap-1.5 pl-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" /> {delay} après {natureLegale(prev!.kind)}
                  </p>
                )}
                <div className={`rounded-lg border p-3 ${l.isCurrent ? "border-primary/40 bg-primary/5" : "border-border"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                      <Badge tone={l.kind === "INVOICE" ? "warning" : l.kind === "QUOTE" ? "info" : "purple"} dot={false}>
                        {natureLegale(l.kind)}
                      </Badge>
                      {/* Un maillon que la personne ne lit pas garde sa place, sous un libellé neutre et SANS lien ;
                          celui que seule une exception de lecture ouvre se lit sans lien vers une fiche refusée. */}
                      {l.isCurrent || !l.ouvrable ? (
                        <span className={l.lisible ? "font-medium" : "italic text-muted-foreground"}>{l.reference ? `${l.reference} · ` : ""}{l.title}</span>
                      ) : (
                        <Link href={`/legal/${l.id}`} className="font-medium hover:underline">
                          {l.reference ? `${l.reference} · ` : ""}{l.title}
                        </Link>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {l.date ? formatDate(l.date) : "—"}{l.amount != null ? ` · ${formatCurrency(l.amount)}` : ""}
                    </span>
                  </div>
                  {/* SES validateurs — qui a signé ce maillon-là, et quand. */}
                  {l.validators.length > 0 && (
                    <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      {l.validators.map((v, j) => (
                        <li key={j} className="flex items-center gap-1">
                          {v.state === "APPROVED" ? <BadgeCheck className="h-3 w-3 text-emerald-600" />
                            : v.state === "REJECTED" ? <XCircle className="h-3 w-3 text-destructive" />
                            : <Hourglass className="h-3 w-3" />}
                          {v.name}{v.decidedAt ? ` · ${formatDate(v.decidedAt)}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}

          {/* LE RÈGLEMENT — le bout de la chaîne. Son état dit s'il attend encore le centre. */}
          {settlement && (
            <li className="space-y-1">
              {invoice && (
                <p className="flex items-center gap-1.5 pl-1 text-xs text-muted-foreground">
                  <ArrowRight className="h-3 w-3" /> Règlement
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
                <span className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  {settlement.centralStatus === "AWAITING" || settlement.centralStatus === "CHANGES_REQUESTED" || settlement.centralStatus === "INFO_REQUESTED" ? (
                    <Badge tone="warning" dot={false}>Au centre de paiement</Badge>
                  ) : settlement.centralStatus === "REFUSED" ? (
                    <Badge tone="danger" dot={false}>Refusé par le centre</Badge>
                  ) : settlement.status === "PAID" ? (
                    <Badge tone="success" dot={false}>Réglé{settlement.paidAt ? ` le ${formatDate(settlement.paidAt)}` : ""}</Badge>
                  ) : (
                    <Badge tone="info" dot={false}>Aux Finances — à régler</Badge>
                  )}
                </span>
                <span className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{formatCurrency(settlement.amount)}</span>
              </div>
            </li>
          )}
        </ol>

        {/* L'écart devis / facture — LE chiffre qu'on vérifie avant de payer. */}
        {drift != null && drift !== 0 && (
          <p className={`text-xs ${drift > 0 ? "text-warning" : "text-muted-foreground"}`}>
            Écart devis → facture : {drift > 0 ? "+" : "−"}{formatCurrency(Math.abs(drift))}
            {drift > 0 && " — la facture dépasse le devis, vérifiez l'avenant avant paiement."}
          </p>
        )}

        {/* Ce qu'il reste à produire, nommé — « en cours » tout seul ne dit pas quoi relancer. */}
        {missing.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Manque encore : {missing.map((k) => CHAIN_KIND_LABEL[k]).join(" · ")}
          </p>
        )}

        {/* La facture part au règlement D'ICI — et passe par le centre de paiement. */}
        {/* Un ordre REFUSÉ par le centre, ou annulé, ne paiera jamais : la facture repart (§118.185). */}
        {canSettle && current?.kind === "INVOICE" && (!settlement || ordreClos(settlement)) && (
          settleBlocked
            ? <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-foreground">{settleBlocked}</p>
            : <SendToSettlementButton id={current.id} amount={current.amount} renvoi={Boolean(settlement)} />
        )}
      </CardContent>
    </Card>
  );
}
