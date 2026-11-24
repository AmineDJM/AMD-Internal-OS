"use client";

import * as React from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useAction } from "@/components/shared/use-action";
import { decidePayment, respondToPaymentCentre } from "@/modules/finances/actions-centre";
import {
  alerteCourte, applyDecision, applyResubmission, awaitsCentre, awaitsRequester, CENTRAL_STATUS_LABEL, MOTIFS_REFUS_RAPIDES,
  type CentralDecision, type CentralStatus, type ContexteDecision,
} from "@/modules/finances/partage";
import { useRetours } from "@/components/ui/retours-porteur";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { EmptyState } from "@/components/shared/empty-state";
import { ItemAskPanel } from "@/modules/ad-pro/ecrans/item-ask-panel";
import { cn, formatCurrency } from "@/lib/utils";
import { statutAffiche, type DecisionsLocales } from "./decisions-locales";
import { FicheDecision, phraseEcheance } from "./fiche-decision";

/**
 * LE CENTRE DE PAIEMENT — la file « À décider » à gauche, la fiche de décision à droite (maquette du 24/11/2026).
 *
 * La file ne montre que ce qui ATTEND le centre (les décidés passent au menu ⋯), une ligne par ordre : l'objet, le
 * montant, l'origine et le bénéficiaire, l'échéance, et l'alerte en une phrase rouge. Au téléphone, la file d'abord ;
 * toucher une ligne ouvre la fiche en plein écran, « Retour à la file » la referme.
 *
 * DEUX ISSUES (Direction, 02/09/2026) : « Autoriser le paiement » et « Refuser », motif en un clic — c'est ce que lira
 * le demandeur. L'écran renvoie ce qu'il AFFICHAIT (`montantVu`, `beneficiaireVu`, §118.191) : un montant ou un
 * bénéficiaire corrigé pendant la lecture ne s'autorise pas sans avoir été vu. La décision passe par `useAction` (une
 * coupure ne perd rien, les gestes restent fermés jusqu'à l'arrivée des nouvelles données, §118.172) ; confirmée,
 * elle se montre AUSSITÔT sur la ligne (`decisions-locales.ts`) et la fiche suivante s'ouvre.
 */
export function CentreBoard({ file, canDecide, initiale }: { file: ContexteDecision[]; canDecide: boolean; initiale: string | null }) {
  const { busy, err, setErr, run } = useAction();
  const retours = useRetours();
  const [decisions, setDecisions] = React.useState<DecisionsLocales>({});
  const statutDe = React.useCallback(
    (f: ContexteDecision): CentralStatus => statutAffiche(f.id, f.centralStatus as CentralStatus, decisions),
    [decisions],
  );
  const designe = initiale && file.some((f) => f.id === initiale) ? initiale : null;
  const [choisi, setChoisi] = React.useState<string | null>(designe ?? file[0]?.id ?? null);
  // Au téléphone, la fiche s'ouvre en plein écran au toucher (et d'emblée quand l'adresse désigne un ordre).
  const [pleinEcran, setPleinEcran] = React.useState(Boolean(designe));
  const [refusOuvert, setRefusOuvert] = React.useState(false);
  const [motif, setMotif] = React.useState("");
  const [echeance, setEcheance] = React.useState("");
  const [note, setNote] = React.useState("");
  const [reponse, setReponse] = React.useState("");

  const courant = file.find((f) => f.id === choisi) ?? null;
  // L'ordre choisi a quitté la file (décidé, les nouvelles données sont là) : la fiche passe au premier qui attend.
  React.useEffect(() => {
    if (courant || file.length === 0) return;
    setChoisi(file.find((f) => awaitsCentre(statutDe(f)))?.id ?? file[0].id);
  }, [courant, file, statutDe]);
  // L'échéance proposée est celle que le demandeur a souhaitée ; le centre peut en imposer une autre.
  React.useEffect(() => { setEcheance(courant?.echeance?.slice(0, 10) ?? ""); }, [courant?.id, courant?.echeance]);

  const choisir = (id: string) => {
    setChoisi(id);
    setPleinEcran(true);
    setRefusOuvert(false);
    setMotif("");
    setNote("");
    setReponse("");
    setErr(null);
  };

  const nbAttente = file.filter((f) => awaitsCentre(statutDe(f))).length;

  async function decider(f: ContexteDecision, decision: Extract<CentralDecision, "APPROVE" | "REFUSE">) {
    const fd = new FormData();
    fd.set("id", f.id);
    fd.set("decision", decision);
    fd.set("body", decision === "REFUSE" ? motif.trim() : note.trim());
    // CE QUE L'ÉCRAN AFFICHAIT (§118.191) : l'action compare, et dit l'écart avec les deux valeurs.
    fd.set("montantVu", String(f.montant));
    fd.set("beneficiaireVu", f.beneficiaire ?? "");
    if (decision === "APPROVE" && echeance) fd.set("dueDate", echeance);
    const depuis = f.centralStatus as CentralStatus;
    await run(async () => {
      const r = await decidePayment(fd);
      const suivant = r.ok ? applyDecision(depuis, decision) : null;
      if (suivant) setDecisions((avant) => ({ ...avant, [f.id]: { depuis, statut: suivant, montant: f.montant } }));
      if (r.ok) retours.succes(r.message ?? "Décision enregistrée.");
      return r;
    }, () => {
      setRefusOuvert(false);
      setMotif("");
      // LA FICHE SUIVANTE S'OUVRE — le temps de lire que la ligne est passée « Autorisé ».
      const prochain = file.find((x) => x.id !== f.id && awaitsCentre(statutDe(x)));
      window.setTimeout(() => { if (prochain) setChoisi(prochain.id); else setPleinEcran(false); }, 900);
    });
  }

  async function repondre(f: ContexteDecision) {
    const fd = new FormData();
    fd.set("id", f.id);
    fd.set("body", reponse);
    const depuis = f.centralStatus as CentralStatus;
    await run(async () => {
      const r = await respondToPaymentCentre(fd);
      const suivant = r.ok ? applyResubmission(depuis) : null;
      if (suivant) setDecisions((avant) => ({ ...avant, [f.id]: { depuis, statut: suivant, montant: f.montant } }));
      if (r.ok) retours.succes(r.message ?? "Réponse envoyée — le paiement retourne au centre.");
      return r;
    }, () => setReponse(""));
  }

  if (file.length === 0) {
    return (
      <EmptyState
        icon="ShieldCheck"
        title="Rien à décider pour cette entité"
        description="Les paiements déjà décidés sont dans le menu ⋯ de l'en-tête. Changez de société en haut pour voir les autres."
      />
    );
  }

  const statutCourant = courant ? statutDe(courant) : null;
  const peutDecider = Boolean(courant && canDecide && statutCourant && awaitsCentre(statutCourant));

  return (
    <div className="flex flex-col items-start gap-4 lg:flex-row">
      <section aria-labelledby="file-centre" className="w-full min-w-0 overflow-hidden rounded-xl border border-border bg-card lg:max-w-[440px] lg:flex-[1_1_380px]">
        <h2 id="file-centre" className="px-4 pb-2.5 pt-4 text-base font-semibold">{canDecide ? "À décider" : "Mes paiements au centre"} · {nbAttente}</h2>
        <ul>
          {file.map((f) => {
            const statut = statutDe(f);
            const decide = !awaitsCentre(statut);
            const actif = f.id === choisi;
            const alerte = alerteCourte(f.alertes);
            return (
              <li key={f.id} className="border-t border-border">
                <button
                  type="button" onClick={() => choisir(f.id)} aria-current={actif ? "true" : undefined}
                  className={cn(
                    "flex w-full flex-col gap-1 px-4 py-3.5 text-left transition-colors hover:bg-secondary/60",
                    actif && "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]",
                    decide && "opacity-55",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 text-[15px] font-semibold [overflow-wrap:anywhere]">{f.objet}</span>
                    <span className="whitespace-nowrap text-[15px] font-bold tabular-nums">{formatCurrency(f.montant)}</span>
                  </span>
                  <span className="flex justify-between gap-3 text-[13px] text-muted-foreground">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{f.origine}{f.beneficiaire ? ` · ${f.beneficiaire}` : ""}</span>
                    <span className={cn("whitespace-nowrap", f.echeanceFixe && !decide && "font-semibold text-destructive")}>
                      {decide || !canDecide ? CENTRAL_STATUS_LABEL[statut] : phraseEcheance(f, true) ?? ""}
                    </span>
                  </span>
                  {alerte && !decide && <span className="text-[13px] font-semibold text-destructive">{alerte}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {courant && (
        <section
          aria-labelledby="fiche-centre"
          className={cn(
            "min-w-0 bg-card p-4 sm:p-5 lg:static lg:block lg:flex-[999_1_560px] lg:rounded-xl lg:border lg:border-border",
            pleinEcran ? "fixed inset-0 z-40 overflow-y-auto" : "hidden",
          )}
        >
          <button type="button" onClick={() => setPleinEcran(false)} className="mb-3 inline-flex min-h-10 items-center gap-1.5 text-sm font-semibold text-primary lg:hidden">
            <ArrowLeft className="h-4 w-4" /> Retour à la file
          </button>
          <FicheDecision
            f={courant}
            decision={
              <>
                {statutCourant && !awaitsCentre(statutCourant) && (
                  <div role="status" className={cn("rounded-[10px] px-3.5 py-3 font-semibold", statutCourant === "APPROVED" ? "bg-success/10 text-success" : statutCourant === "REFUSED" ? "bg-destructive/10 text-destructive" : "bg-secondary text-foreground")}>
                    {statutCourant === "APPROVED" ? "Autorisé — le paiement part chez les Finances (Banque & paiements)."
                      : statutCourant === "REFUSED" ? "Refusé — le demandeur est prévenu, avec votre motif."
                      : CENTRAL_STATUS_LABEL[statutCourant]}
                  </div>
                )}
                {peutDecider && (
                  <div className="flex flex-col gap-2.5 border-t border-border pt-4">
                    {refusOuvert ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-sm font-semibold">Motif du refus — c&apos;est ce que lira le demandeur</p>
                        <div className="flex flex-wrap gap-1.5">
                          {MOTIFS_REFUS_RAPIDES.map((m) => (
                            <button
                              key={m} type="button" onClick={() => setMotif(m)} aria-pressed={motif === m}
                              className={cn("min-h-9 rounded-full border px-3 text-[13px]", motif === m ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border hover:bg-secondary")}
                            >{m}</button>
                          ))}
                        </div>
                        <Textarea aria-label="Motif du refus" rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Ou écrivez le vôtre…" />
                      </div>
                    ) : (
                      <details className="text-sm">
                        <summary className="cursor-pointer text-muted-foreground">Échéance imposée aux Finances, note</summary>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <div className="space-y-1">
                            <Label htmlFor="pc-due">Échéance à tenir</Label>
                            <Input id="pc-due" type="date" value={echeance} onChange={(e) => setEcheance(e.target.value)} />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="pc-note">Note (facultative)</Label>
                            <Input id="pc-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="À quelles conditions vous autorisez…" />
                          </div>
                        </div>
                      </details>
                    )}
                    {/* LA SÉPARATION DES TÂCHES DITE AVANT LE CLIC — le bouton reste fermé, et la phrase dit pourquoi. */}
                    {courant.refusAutoriser && !refusOuvert && <p className="text-[13px] text-muted-foreground">{courant.refusAutoriser}</p>}
                    {err && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={() => { setErr(null); setMotif(""); setRefusOuvert((o) => !o); }}>
                        {refusOuvert ? "Annuler" : "Refuser"}
                      </Button>
                      {refusOuvert ? (
                        <BoutonDecisif type="button" variant="destructive" className="h-11" disabled={busy || !motif.trim()} onClick={() => void decider(courant, "REFUSE")}>
                          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Confirmer le refus
                        </BoutonDecisif>
                      ) : (
                        <BoutonDecisif type="button" className="h-11" disabled={busy || Boolean(courant.refusAutoriser)} title={courant.refusAutoriser ?? undefined} onClick={() => void decider(courant, "APPROVE")}>
                          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Autoriser le paiement
                        </BoutonDecisif>
                      )}
                    </div>
                  </div>
                )}
              </>
            }
            repli={
              <>
                {/* RÉCLAMER CE QUI MANQUE plutôt que refuser faute de pièce : la demande arrive dans « Pièces demandées ». */}
                {peutDecider && (
                  <ItemAskPanel
                    entityType="EXPENSE_ORDER" entityId={courant.id} link="/centre-de-paiement"
                    subject={`${courant.reference} — ${courant.objet}`} moduleLibelle={null} canAskValidation={false}
                  />
                )}
                {/* LES DOSSIERS D'AVANT LE 02/09/2026 (« révision », « argumentation ») : leur demandeur répond ici, et le
                    paiement revient au centre. Le centre ne pose plus ces états. */}
                {courant.estLeDemandeur && statutCourant && awaitsRequester(statutCourant) && (
                  <div className="space-y-1.5">
                    <Label htmlFor="pc-reponse">Répondre au centre</Label>
                    <Textarea id="pc-reponse" rows={3} value={reponse} onChange={(e) => setReponse(e.target.value)} placeholder="Votre réponse, ou le montant corrigé et ce qui le justifie…" />
                    <Button type="button" size="sm" disabled={busy || !reponse.trim()} onClick={() => void repondre(courant)}>Envoyer</Button>
                  </div>
                )}
              </>
            }
          />
        </section>
      )}
    </div>
  );
}
