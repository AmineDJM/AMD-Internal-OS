"use client";

import * as React from "react";
import Link from "next/link";
import { useAction } from "@/components/shared/use-action";
import { ShieldCheck, ShieldX, MessageSquare, Coins, Loader2, Send, ChevronDown, ExternalLink, Paperclip, Pill } from "lucide-react";
import { decidePayment, respondToPaymentCentre } from "@/lib/actions/payment-centre-actions";
import {
  CENTRAL_STATUS_LABEL, CENTRAL_DECISION_LABEL, MOTIFS_REFUS_RAPIDES, awaitsCentre, awaitsRequester,
  type CentralStatus, type CentralDecision,
} from "@/lib/payments/authorization";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/lib/labels";
import { EmptyState } from "@/components/shared/empty-state";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { deadlineNatureLabel, deadlineNatureOf } from "@/lib/finance/deadline-nature";
import { ItemAskPanel } from "@/components/ad-pro/item-ask-panel";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

export interface CentreMessage {
  id: string;
  decision: string | null;
  body: string;
  author: string | null;
  createdAt: string;
}

export interface CentreOrder {
  id: string;
  reference: string;
  label: string;
  beneficiary: string | null;
  amount: number;
  proposedAmount: number | null;
  centralStatus: CentralStatus;
  requestedBy: string | null;
  companyLabel: string | null;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  /** L'échéance DEMANDÉE par le demandeur — un souhait, formé sans voir la trésorerie. */
  dueDate: string | null;
  /**
   * CE QUE CETTE ÉCHÉANCE PÈSE — `FIXED`, `IMPORTANT`, `MODERATE`. C'est ICI qu'elle compte le
   * plus : le centre POSE la date que la comptabilité devra tenir, et poser une date en ignorant
   * qu'un engagement ferme a été pris auprès du bénéficiaire, c'est arbitrer à l'aveugle.
   */
  deadlineNature: string | null;
  /**
   * LE DOSSIER DU PAIEMENT : son montant, ses pièces, son fil. Autoriser une sortie d'argent sans
   * pouvoir ouvrir la facture, c'est autoriser une ligne de tableau. TOUT ordre en porte un
   * désormais, quelle que soit sa provenance.
   */
  dossierHref: string | null;
  /** LA DEMANDE D'ORIGINE — le sponsoring, le matériel promotionnel, le dossier réglementaire. */
  sourceHref: string | null;
  /** L'origine de la dépense en clair (« Demande administrative », « Avance sur salaire »…). */
  sourceLabel: string | null;
  /**
   * LE PRODUIT D'OÙ VIENT LA DEMANDE — pour un BV de dossier réglementaire (« Demande du BV 25 % »
   * cliquée sur l'étape du processus). Le centre arbitre entre des BV de plusieurs dossiers : sans
   * le produit, il autorise « BV 25 % — REG-2026-014 » sans savoir de quel médicament il s'agit.
   * `href` n'est posé que si la personne peut ouvrir le dossier.
   */
  produit: { reference: string; nom: string; dci: string; nature: string | null; href: string | null } | null;
  /** Le commentaire du demandeur, écrit avec sa demande. */
  note: string | null;
  /**
   * LA MARQUE « DOUBLON POSSIBLE » (Direction, 14/10/2026) : une facture de ce paiement ressemble à une facture déjà
   * connue ailleurs — la phrase, avec la référence de l'autre pièce. Elle ne bloque rien : elle se vérifie avant
   * d'autoriser. `null` sans marque.
   */
  doublonPossible?: string | null;
  /** Les pièces jointes à l'ordre par le demandeur (proforma, courrier…). */
  pieces: { id: string; name: string }[];
  messages: CentreMessage[];
  /** L'utilisateur courant est-il le demandeur ? Il peut alors répondre et resoumettre. */
  isMine: boolean;
}

const TONE: Record<CentralStatus, BadgeTone> = {
  NOT_REQUIRED: "neutral",
  AWAITING: "warning",
  CHANGES_REQUESTED: "info",
  INFO_REQUESTED: "info",
  APPROVED: "success",
  REFUSED: "danger",
};

/**
 * LE CENTRE DE PAIEMENT — ce que le PDG voit avant que l'argent sorte.
 *
 * Une file par entité ET par section (§118.211) : « autoriser un paiement d'Adventum » et
 * « autoriser un paiement de Pharmagène » sont deux gestes comptablement distincts, et la page
 * choisit l'entité en haut puis l'une des trois sections — ce composant ne montre que CETTE file.
 *
 * Deux issues, pas quatre (décision de la Direction, 02/09/2026) : le centre AUTORISE ou REFUSE, et
 * le montant se corrige dans la demande, avant d'arriver ici. Le demandeur répond dans le même fil.
 *
 * `useRafraichir` (§118.172) : après une décision, les gestes restent fermés tant que les nouvelles
 * données ne sont pas à l'écran — un second clic sur l'état d'avant autoriserait deux fois.
 */
export function CentreBoard({
  orders, canDecide, titre, total, nonAffiches,
}: { orders: CentreOrder[]; canDecide: boolean; titre: string; total: number; nonAffiches: number }) {
  // LA DÉCISION PASSE PAR `useAction` (audit 27/10/2026, FRONTEND-UX-01) : un appel qui LÈVE
  // (connexion coupée, redéploiement) ou qui ne revient jamais laissait `busy` à vrai pour toujours —
  // le bouton tournait et la feuille ne se fermait plus (`onClose` exige `!busy`). Le crochet attrape,
  // chronomètre, dit de vérifier avant de recommencer, et garde les gestes fermés jusqu'à l'arrivée
  // des nouvelles données (§118.172) : `busy` couvre aussi le rafraîchissement.
  const { busy, err, setErr, run } = useAction();
  const [acting, setActing] = React.useState<{ order: CentreOrder; decision: CentralDecision } | null>(null);
  const [replying, setReplying] = React.useState<CentreOrder | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  // Le motif, CONTRÔLÉ : les motifs rapides (« Non prioritaire »…) s'y écrivent d'un clic, et l'on complète.
  const [motif, setMotif] = React.useState("");
  const ouvrir = (order: CentreOrder, decision: CentralDecision) => { setErr(null); setMotif(""); setActing({ order, decision }); };

  // UNE seule file : l'entité et la section sont déjà choisies par la page.
  const groups: [string, CentreOrder[]][] = [[titre, orders]];

  if (orders.length === 0) {
    return (
      <EmptyState
        icon="ShieldCheck"
        title="Aucun paiement dans cette section"
        description="Tout paiement de la société arrive ici avant d'atteindre les Finances, quel que soit son montant. Changez d'entité en haut, ou de section, pour voir les autres."
      />
    );
  }

  return (
    <div className="space-y-5">
      {groups.map(([company, list]) => {
        const waiting = list.filter((o) => awaitsCentre(o.centralStatus));
        const total = waiting.reduce((a, o) => a + o.amount, 0);
        return (
          <section key={company} className="surface space-y-3 p-3 sm:p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Coins className="h-4 w-4 text-primary" /> {company}
                <span className="text-xs font-normal text-muted-foreground">({total > list.length ? `${list.length} sur ${total}` : list.length})</span>
              </h2>
              {waiting.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  <span className="font-semibold text-warning">{formatCurrency(total)}</span> en attente d&apos;autorisation
                </p>
              )}
            </div>

            {/* UNE CARTE PAR DEMANDE, et non une ligne de liste séparée d'un filet.
                Autoriser une sortie d'argent se fait une demande à la fois : quand elles se
                touchent, l'œil glisse d'un montant à l'autre et l'on clique « Autoriser » sur la
                ligne d'à côté. L'espace ici n'est pas décoratif, il évite une erreur coûteuse.
                On s'arrête à une bordure et un peu d'air — au-delà, la file cesse de se lire d'un
                coup d'œil, ce qui est le second défaut de cet écran. */}
            <ul className="space-y-2">
              {list.map((o) => {
                const isOpen = open === o.id;
                return (
                  <li key={o.id} className="rounded-xl border border-border bg-background p-3">
                    <div className="flex flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1">
                        {/* LE TITRE EST LE LIEN. Un bouton « Ouvrir le dossier & ses pièces »
                            posé à côté disait deux fois la même chose et allongeait une barre
                            d'actions déjà chargée : ce qu'on veut lire, on clique dessus. */}
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {/* Au téléphone, le libellé se lit en entier (deux lignes) : on autorise ce qu'on lit. */}
                          {o.dossierHref ? (
                            <Link href={o.dossierHref} className="min-w-0 text-primary [overflow-wrap:anywhere] hover:underline sm:truncate" title="Ouvrir le dossier : pièces, demandes de pièces, discussion">
                              {o.label}
                            </Link>
                          ) : (
                            <span className="min-w-0 [overflow-wrap:anywhere] sm:truncate">{o.label}</span>
                          )}
                          <Badge tone={TONE[o.centralStatus]}>{CENTRAL_STATUS_LABEL[o.centralStatus]}</Badge>
                        </p>
                        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                          {o.reference} · {o.beneficiary ?? "bénéficiaire non précisé"} · demandé par {o.requestedBy ?? "—"} · {formatDateTime(o.createdAt)}
                        </p>
                        {o.produit && (
                          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs [overflow-wrap:anywhere]">
                            <Pill className="h-3.5 w-3.5 shrink-0 text-primary" />
                            {o.produit.nature && <Badge tone="info" dot={false}>{o.produit.nature}</Badge>}
                            <span>
                              Produit :{" "}
                              {o.produit.href
                                ? <Link href={o.produit.href} className="font-medium text-primary hover:underline">{o.produit.nom}</Link>
                                : <span className="font-medium text-foreground">{o.produit.nom}</span>}
                              {" · "}<span className="font-mono">{o.produit.reference}</span>
                              {o.produit.dci && o.produit.dci !== o.produit.nom ? <> · {o.produit.dci}</> : null}
                            </span>
                          </p>
                        )}
                        {o.doublonPossible && (
                          <p className="mt-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs [overflow-wrap:anywhere]" data-doublon-possible>
                            <span className="font-medium">Doublon possible — </span>{o.doublonPossible}
                          </p>
                        )}
                        {o.note && (
                          <p className="mt-1 whitespace-pre-wrap rounded-md bg-secondary/50 px-2 py-1 text-xs [overflow-wrap:anywhere]">
                            <span className="font-medium">Commentaire du demandeur : </span>{o.note}
                          </p>
                        )}
                        {o.pieces.length > 0 && (
                          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                            <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                            {o.pieces.map((p) => (
                              <a key={p.id} href={`/api/documents/${p.id}`} target="_blank" rel="noreferrer" className="min-w-0 text-primary [overflow-wrap:anywhere] hover:underline">
                                {p.name}
                              </a>
                            ))}
                          </p>
                        )}
                        {o.proposedAmount != null && (
                          <p className="text-xs text-info tabular-nums">
                            Montant proposé par le centre : {formatCurrency(o.proposedAmount)}
                          </p>
                        )}
                      </div>
                      <p className="shrink-0 whitespace-nowrap text-base font-semibold tabular-nums sm:text-sm">{formatCurrency(o.amount)}</p>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {o.messages.length > 0 && (
                        <button
                          type="button" onClick={() => setOpen(isOpen ? null : o.id)}
                          className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary sm:min-h-0 sm:px-1.5 sm:py-0.5"
                        >
                          <MessageSquare className="h-3 w-3" /> {o.messages.length} échange{o.messages.length > 1 ? "s" : ""}
                          <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                        </button>
                      )}

                      {/* LA DEMANDE D'ORIGINE, à côté du dossier — deux objets distincts : le
                            dossier dit ce qui JUSTIFIE le paiement (facture, bon, discussion),
                            l'origine dit ce qu'on ACHÈTE. */}
                      {o.sourceHref && (
                        <Link href={o.sourceHref} className="inline-flex min-h-9 min-w-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary sm:min-h-0 sm:px-1.5 sm:py-0.5">
                          <ExternalLink className="h-3 w-3" /> {o.sourceLabel ?? "Demande d'origine"}
                        </Link>
                      )}

                      {/* Le bouton d'ouverture a disparu : c'est le TITRE qui ouvre, ci-dessus.
                            Reste à DIRE quand il n'y a rien à ouvrir — un titre qui ne réagit pas
                            au clic se lit comme une panne, on recommence, on abandonne. */}
                      {!o.dossierHref && !o.sourceHref && (
                        <span className="text-xs text-muted-foreground">
                          {o.sourceLabel ? `${o.sourceLabel} — pas de fiche à ouvrir` : "Pas de fiche à ouvrir"}
                        </span>
                      )}

                      {canDecide && awaitsCentre(o.centralStatus) && (
                        <>
                          {/* RÉCLAMER CE QUI MANQUE plutôt que refuser faute de pièce : la
                              demande atterrit dans « Pièces demandées » de la personne, avec son
                              fil — elle dépose sans qu'on lui ouvre le module. */}
                          <ItemAskPanel
                            entityType="EXPENSE_ORDER"
                            entityId={o.id}
                            link="/centre-de-paiement"
                            subject={`${o.reference} — ${o.label}`}
                            moduleLibelle={null}
                            canAskValidation={false}
                          />
                          {/* Au téléphone, les deux issues prennent toute la largeur de la carte, côte à côte,
                              à hauteur de pouce : on ne les cherche pas au bout d'une rangée. */}
                          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
                            <Button size="sm" disabled={busy} className="h-11 text-sm sm:h-8 sm:text-xs" onClick={() => ouvrir(o, "APPROVE")}>
                              <ShieldCheck className="h-4 w-4" /> Autoriser
                            </Button>
                            <Button size="sm" variant="outline" disabled={busy} className="h-11 text-sm text-destructive hover:bg-destructive/10 sm:h-8 sm:text-xs" onClick={() => ouvrir(o, "REFUSE")}>
                              <ShieldX className="h-4 w-4" /> Refuser
                            </Button>
                          </div>
                        </>
                      )}

                      {/* LE DEMANDEUR RÉPOND — c'est ce qui rend les allers-retours possibles. */}
                      {o.isMine && awaitsRequester(o.centralStatus) && (
                        <Button size="sm" disabled={busy} onClick={() => { setErr(null); setReplying(o); }}>
                          <Send className="h-4 w-4" /> Répondre et resoumettre
                        </Button>
                      )}
                    </div>

                    {isOpen && (
                      <ul className="mt-2 space-y-1.5 border-l-2 border-border pl-3">
                        {o.messages.map((m) => (
                          <li key={m.id} className="text-xs">
                            <p className="text-muted-foreground">
                              <span className="font-medium text-foreground">{m.author ?? "—"}</span>
                              {m.decision && ` · ${CENTRAL_DECISION_LABEL[m.decision as CentralDecision] ?? m.decision}`}
                              {" · "}{formatDateTime(m.createdAt)}
                            </p>
                            <p className="whitespace-pre-wrap">{m.body}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* UNE COUPE SE DIT : le compte du titre est exact, la liste s'arrête aux plus récentes. */}
            {nonAffiches > 0 && (
              <p className="text-xs text-muted-foreground">
                {nonAffiches} paiement{nonAffiches > 1 ? "s" : ""} plus ancien{nonAffiches > 1 ? "s" : ""} non affiché{nonAffiches > 1 ? "s" : ""} dans cette section.
              </p>
            )}
          </section>
        );
      })}

      {acting && (
        <Sheet
          open onClose={() => !busy && setActing(null)} width="md"
          title={CENTRAL_DECISION_LABEL[acting.decision]}
          description={`${acting.order.reference} — ${acting.order.label} (${formatCurrency(acting.order.amount)})`}
        >
          <form
            action={async (fd) => {
              fd.set("id", acting.order.id);
              fd.set("decision", acting.decision);
              // CE QUE L'ÉCRAN AFFICHAIT (§118.191) : un montant ou un bénéficiaire corrigé pendant la
              // lecture ne s'autorise pas sans avoir été vu — l'action compare et le dit.
              fd.set("montantVu", String(acting.order.amount));
              fd.set("beneficiaireVu", acting.order.beneficiary ?? "");
              await run(() => decidePayment(fd), () => setActing(null));
            }}
            className="space-y-4"
          >
            {acting.decision === "APPROVE" && (
              <div className="space-y-1.5">
                <Label htmlFor="pc-due">Échéance imposée aux Finances</Label>
                <Input id="pc-due" name="dueDate" type="date" defaultValue={acting.order.dueDate?.slice(0, 10) ?? ""} />
                <p className="text-xs text-muted-foreground">
                  {acting.order.dueDate
                    ? <>Le demandeur a souhaité le <strong>{formatDate(acting.order.dueDate)}</strong>, échéance déclarée <strong>{deadlineNatureLabel(acting.order.deadlineNature).toLowerCase()}</strong>. Vous voyez la file entière : c&apos;est vous qui arbitrez.</>
                    : <>Aucune échéance demandée. Laissez vide si rien ne presse — une date posée est une date que la comptabilité doit tenir.</>}
                </p>
                {deadlineNatureOf(acting.order.deadlineNature) === "FIXED" && acting.order.dueDate && (
                  <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    Le demandeur a déclaré cette échéance <strong>fixe et non négociable</strong> : elle a été engagée auprès du bénéficiaire. La déplacer a un coût que vous seul pouvez arbitrer.
                  </p>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="pc-body">
                {acting.decision === "APPROVE" ? "Note (facultative)" : "Motif"}
                {acting.decision !== "APPROVE" && <span className="ml-0.5 text-destructive">*</span>}
              </Label>
              {/* LES MOTIFS EN UN CLIC — « Non prioritaire » d'abord. Un raccourci d'écriture : le texte
                  reste libre, on complète ou l'on écrit le sien. */}
              {acting.decision === "REFUSE" && (
                <div className="flex flex-wrap gap-1.5">
                  {MOTIFS_REFUS_RAPIDES.map((m) => (
                    <button
                      key={m} type="button"
                      onClick={() => setMotif((prev) => (!prev.trim() ? m : prev.includes(m) ? prev : `${prev.trim()} — ${m}`))}
                      className={`min-h-9 rounded-full border px-3 py-1 text-xs sm:min-h-0 ${motif.includes(m) ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-border text-muted-foreground hover:bg-secondary"}`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
              <Textarea
                id="pc-body" name="body" rows={3}
                value={motif} onChange={(e) => setMotif(e.target.value)}
                required={acting.decision !== "APPROVE"}
                placeholder={
                  acting.decision === "REFUSE" ? "Pourquoi ce paiement ne doit pas partir…"
                        : "À quelles conditions vous autorisez…"
                }
              />
            </div>
            {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setActing(null)} disabled={busy}>Annuler</Button>
              <BoutonDecisif type="submit" disabled={busy} className="h-11 w-full sm:h-10 sm:w-auto" variant={acting.decision === "REFUSE" ? "destructive" : "primary"}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {CENTRAL_DECISION_LABEL[acting.decision]}
              </BoutonDecisif>
            </div>
          </form>
        </Sheet>
      )}

      {replying && (
        <Sheet
          open onClose={() => !busy && setReplying(null)} width="md"
          title="Répondre au centre de paiement"
          description={`${replying.reference} — ${replying.label}. Votre réponse renvoie le dossier au centre.`}
        >
          <form
            action={async (fd) => {
              fd.set("id", replying.id);
              await run(() => respondToPaymentCentre(fd), () => setReplying(null));
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="pc-reply">Votre réponse</Label>
              <Textarea id="pc-reply" name="body" rows={4} required placeholder="Votre argumentation, ou le montant corrigé et ce qui le justifie…" />
            </div>
            {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setReplying(null)} disabled={busy}>Annuler</Button>
              <Button type="submit" className="w-full sm:w-auto" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer</Button>
            </div>
          </form>
        </Sheet>
      )}
    </div>
  );
}
