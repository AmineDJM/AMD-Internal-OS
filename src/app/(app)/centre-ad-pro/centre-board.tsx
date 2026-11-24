"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Paperclip } from "lucide-react";
import { useAction } from "@/components/shared/use-action";
import { EmptyState } from "@/components/shared/empty-state";
import { SurlignerCible } from "@/components/shared/surligner-cible";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn, formatCurrency } from "@/lib/utils";
import { ancreLigneCentre } from "@/lib/chemins/ad-pro";
import type { ActionResult } from "@/lib/actions/types";
import { statuerTotalDg } from "@/lib/actions/porte-dg-actions";
import { deciderVisaCentreAdPro } from "@/modules/ad-pro/actions-centre";
import { approveAdProItemOrder } from "@/modules/ad-pro/actions-postes";
import { addAdProComment } from "@/modules/ad-pro/actions-discussion";
import {
  alertesDeLaLigne, alerteCourte, cleLigne, CONTEXTE_VIDE, DORMANTE_JOURS, etatApresDecision, gestesDeLaForme,
  joursDAttente, natureDeLaLigneCourte, phraseApresDecision, phraseAttente, phraseSeuils, societesDuCentre, trierCentre,
  type ChoixCentre, type ContexteLigneCentre, type LigneCentre,
} from "@/modules/ad-pro/partage";
import { FicheCentre } from "./fiche-centre";

/**
 * LE CENTRE DE VALIDATION AD & PRO — la file « À décider » à gauche, la fiche de décision à droite (maquette validée
 * le 24/11/2026). Une ligne : l'objet et le montant, la société, la nature et le demandeur, depuis quand elle attend,
 * le budget restant de la ligne imputée et le nombre de pièces, l'alerte en une phrase rouge. Le seuil se dit UNE fois,
 * dans la bulle ⓘ de la file ; il se règle dans le menu ⋯. Au téléphone, la file d'abord ; toucher une ligne ouvre la
 * fiche en plein écran.
 *
 * LES GESTES SONT CEUX D'HIER, par les MÊMES actions serveur — le centre est une lentille, jamais une seconde
 * autorisation :
 *   • le TOTAL d'une demande : `statuerTotalDg` (valider, ou renvoyer en révision, motif exigé) ;
 *   • le BC d'un POSTE : `approveAdProItemOrder`, qui reçoit le montant et le prestataire AFFICHÉS (§118.187) ;
 *   • une demande à visa et un BC du registre Legal : `deciderVisaCentreAdPro` (viser, renvoyer, refuser) ;
 *   • les étapes de circuit et l'ancien parcours promo se décident sur leur dossier (lien).
 * « Demander une précision » écrit dans le fil de la demande (ou du poste) par `addAdProComment`, sans décider.
 * Confirmée, une décision se montre AUSSITÔT sur la ligne, puis la fiche suivante s'ouvre.
 */

type Mode = "RENVOYER" | "REFUSER" | "PRECISION" | null;
interface Decide { choix: ChoixCentre | "PRECISION"; motif: string | null; row: LigneCentre; c: ContexteLigneCentre }

export function CentreAdProBoard({ rows, contextes, societes, seuil, seuilBC, ligneAOuvrir, menu }: {
  rows: LigneCentre[];
  contextes: Record<string, ContexteLigneCentre>;
  societes: { id: string; nom: string }[];
  seuil: number;
  seuilBC: number;
  /** La ligne dont parle la notification (`?ligne=`) : elle s'ouvre d'emblée et s'entoure. */
  ligneAOuvrir?: string | null;
  menu: React.ReactNode;
}) {
  const { busy, err, setErr, run } = useAction();
  const [decides, setDecides] = React.useState<Record<string, Decide>>({});
  const [societe, setSociete] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<Mode>(null);
  const [motif, setMotif] = React.useState("");
  const maintenant = React.useMemo(() => new Date(), []);

  // Une ligne décidée quitte la file au rechargement ; elle reste visible, grisée, le temps de la session.
  const toutes = React.useMemo(() => {
    const presentes = new Set(rows.map(cleLigne));
    return trierCentre([...rows, ...Object.entries(decides).filter(([k]) => !presentes.has(k)).map(([, d]) => d.row)]);
  }, [rows, decides]);
  // Le contexte d'une ligne décidée survit au rechargement de la file avec elle.
  const ctx = React.useCallback((r: LigneCentre) => contextes[cleLigne(r)] ?? decides[cleLigne(r)]?.c ?? CONTEXTE_VIDE, [contextes, decides]);
  const visibles = societe ? toutes.filter((r) => ctx(r).societeId === societe) : toutes;
  const pastilles = societesDuCentre(societes, rows.map((r) => ({ societeId: ctx(r).societeId })));

  const designe = ligneAOuvrir ? toutes.find((r) => r.entityId === ligneAOuvrir) : undefined;
  const [choisi, setChoisi] = React.useState<string | null>(designe ? cleLigne(designe) : toutes[0] ? cleLigne(toutes[0]) : null);
  const [pleinEcran, setPleinEcran] = React.useState(Boolean(designe));
  const enAttente = (k: string) => !decides[k] || decides[k].choix === "PRECISION";
  const courant = visibles.find((r) => cleLigne(r) === choisi) ?? visibles.find((r) => enAttente(cleLigne(r))) ?? visibles[0] ?? null;
  const nbAttente = visibles.filter((r) => enAttente(cleLigne(r))).length;

  const choisir = (k: string) => { setChoisi(k); setPleinEcran(true); setMode(null); setMotif(""); setErr(null); };

  async function decider(choix: ChoixCentre | "PRECISION") {
    const row = courant;
    if (!row) return;
    const k = cleLigne(row);
    const note = motif.trim();
    const fd = new FormData();
    await run(async () => {
      let r: ActionResult;
      if (choix === "PRECISION") {
        const cible = ctx(row).filCible;
        if (!cible) return { ok: false, error: "Cette ligne n'a pas de fil où écrire : ouvrez le dossier." };
        fd.set("entityType", cible.entityType); fd.set("entityId", cible.entityId); fd.set("body", note);
        r = await addAdProComment(fd);
      } else if (row.forme === "BC_POSTE") {
        // LE BC D'UN POSTE se décide par l'action du poste — la même que le bouton de la fiche. CE QUE LE CENTRE A LU
        // (§118.187) part avec le visa : un montant ou un prestataire changé pendant la lecture ne se vise pas.
        fd.set("id", row.entityId);
        fd.set("decision", choix === "VALIDER" ? "APPROVE" : "REFUSE");
        fd.set("note", note);
        if (row.montant != null) fd.set("montantVu", String(row.montant));
        fd.set("prestataireVu", row.prestataire ?? "");
        r = await approveAdProItemOrder(undefined, fd);
      } else if (row.forme === "TOTAL_DG") {
        // Le total que l'écran affichait : s'il a bougé depuis, l'action le dit au lieu de valider un autre montant.
        fd.set("parent", row.entityType); fd.set("parentId", row.entityId);
        fd.set("decision", choix === "VALIDER" ? "VALIDEE" : "A_REVOIR");
        fd.set("totalVu", String(row.montant ?? 0));
        if (note) fd.set("note", note);
        r = await statuerTotalDg(fd);
      } else {
        fd.set("entityType", row.entityType); fd.set("entityId", row.entityId); fd.set("decision", choix); fd.set("note", note);
        r = await deciderVisaCentreAdPro(fd);
      }
      if (r.ok) { const cx = ctx(row); setDecides((avant) => ({ ...avant, [k]: { choix, motif: note || null, row, c: cx } })); }
      return r;
    }, () => {
      setMode(null); setMotif("");
      if (choix === "PRECISION") return;
      // LA FICHE SUIVANTE S'OUVRE — le temps de lire que la ligne est passée « Visé ».
      const prochain = visibles.find((x) => cleLigne(x) !== k && enAttente(cleLigne(x)));
      window.setTimeout(() => { if (prochain) setChoisi(cleLigne(prochain)); else setPleinEcran(false); }, 900);
    });
  }

  const c = courant ? ctx(courant) : CONTEXTE_VIDE;
  const g = courant ? gestesDeLaForme(courant.forme) : null;
  const dec = courant ? decides[cleLigne(courant)] : undefined;
  const peutDecider = Boolean(courant && g?.ok && (!dec || dec.choix === "PRECISION"));
  const statut = courant && dec ? {
    texte: phraseApresDecision(courant.forme, dec.choix, dec.motif),
    ton: dec.choix === "VALIDER" ? "ok" as const : dec.choix === "PRECISION" ? "attente" as const : "ko" as const,
  } : null;

  return (
    <div className="space-y-4">
      <SurlignerCible ids={[ligneAOuvrir ? ancreLigneCentre(ligneAOuvrir) : null]} />
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Centre de validation Ad &amp; Pro</h1>
        <div className="flex min-w-0 max-w-full items-center gap-2">
          {pastilles.length > 2 && (
            <nav aria-label="Société" className="min-w-0 overflow-x-auto rounded-[10px] border border-border bg-card p-1">
              <ul className="flex min-w-max gap-1">
                {pastilles.map((s) => (
                  <li key={s.cle ?? "toutes"}>
                    <button
                      type="button" onClick={() => setSociete(s.cle)} aria-pressed={societe === s.cle}
                      className={cn("flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-3 text-sm transition-colors", societe === s.cle ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}
                    >
                      {s.nom} <span className={cn("text-xs tabular-nums", s.enAttente > 0 ? "font-semibold" : "opacity-60")}>{s.enAttente}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {menu}
        </div>
      </header>

      {visibles.length === 0 ? (
        <EmptyState icon="ShieldCheck" title="Rien à décider." description="Les décisions passées et le réglage des seuils sont dans le menu ⋯." />
      ) : (
        <div className="flex flex-col items-start gap-4 lg:flex-row">
          <section aria-labelledby="file-centre" className="w-full min-w-0 overflow-hidden rounded-xl border border-border bg-card lg:max-w-[440px] lg:flex-[1_1_380px]">
            <h2 id="file-centre" className="flex items-center gap-1.5 px-4 pb-2.5 pt-4 text-base font-semibold">
              À décider · {nbAttente}
              <InfoBulle label="Ce qui passe par le centre" align="left">{phraseSeuils(seuil, seuilBC)}</InfoBulle>
            </h2>
            <ul>
              {visibles.map((r) => {
                const k = cleLigne(r);
                const cx = ctx(r);
                const d = decides[k];
                const tranche = Boolean(d && d.choix !== "PRECISION");
                const jours = joursDAttente(r.depuis, maintenant);
                const alerte = alerteCourte(alertesDeLaLigne(r, cx));
                const actif = Boolean(courant && cleLigne(courant) === k);
                return (
                  <li key={k} id={ancreLigneCentre(r.entityId)} className="border-t border-border">
                    <button
                      type="button" onClick={() => choisir(k)} aria-current={actif ? "true" : undefined}
                      className={cn(
                        "flex w-full flex-col gap-1 px-4 py-3.5 text-left transition-colors hover:bg-secondary/60",
                        actif && "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]",
                        tranche && "opacity-55",
                      )}
                    >
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 text-[15px] font-semibold [overflow-wrap:anywhere]">{r.intitule}</span>
                        <span className="whitespace-nowrap text-[15px] font-bold tabular-nums">{r.montant != null ? formatCurrency(r.montant) : "—"}</span>
                      </span>
                      <span className="flex justify-between gap-3 text-[13px] text-muted-foreground">
                        <span className="min-w-0 [overflow-wrap:anywhere]">{[cx.societe, natureDeLaLigneCourte(r), r.demandeur].filter(Boolean).join(" · ")}</span>
                        <span className={cn("whitespace-nowrap", !d && jours >= DORMANTE_JOURS && "font-semibold text-destructive", d?.choix === "PRECISION" && "font-semibold text-warning")}>
                          {d ? etatApresDecision(r.forme, d.choix) : phraseAttente(jours)}
                        </span>
                      </span>
                      <span className="flex justify-between gap-3 text-[13px] text-muted-foreground">
                        <span className={cn("min-w-0 [overflow-wrap:anywhere]", cx.budget && cx.budget.disponible < 0 && "text-destructive")}>
                          {cx.budget ? `Reste ${formatCurrency(cx.budget.disponible)} · ${cx.budget.ligne}` : "Aucune ligne imputée"}
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1" title={`${cx.pieces.length} pièce(s)`}>
                          <Paperclip className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">Pièces :</span>{cx.pieces.length}
                        </span>
                      </span>
                      {alerte && !tranche && <span className="text-[13px] font-semibold text-destructive">{alerte}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {courant && g && (
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
              <FicheCentre
                row={courant} c={c} alertes={alertesDeLaLigne(courant, c)} statut={statut}
                decision={!g.ok ? (
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
                    <Link href={courant.href} className="inline-flex h-11 items-center rounded-[var(--radius)] bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
                      Décider dans le dossier
                    </Link>
                  </div>
                ) : peutDecider ? (
                  <div className="flex flex-col gap-2.5 border-t border-border pt-4">
                    {(mode === "RENVOYER" || mode === "REFUSER") && (
                      <div className="flex flex-col gap-2">
                        <p className="text-sm font-semibold">{g.titreMotif}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {g.motifs.map((m) => (
                            <button
                              key={m} type="button" onClick={() => setMotif(m)} aria-pressed={motif === m}
                              className={cn("min-h-9 rounded-full border px-3 text-[13px]", motif === m ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border hover:bg-secondary")}
                            >{m}</button>
                          ))}
                        </div>
                        <Textarea id="motif-centre" aria-label="Motif" rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Ou écrivez le vôtre…" />
                      </div>
                    )}
                    {mode === "PRECISION" && (
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="question-centre" className="text-sm font-semibold">Votre question{courant.demandeur ? ` à ${courant.demandeur}` : ""}</label>
                        <Textarea id="question-centre" rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} />
                      </div>
                    )}
                    {err && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
                    <div className="flex flex-wrap justify-end gap-2">
                      {mode ? (
                        <>
                          <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={() => { setMode(null); setMotif(""); setErr(null); }}>Annuler</Button>
                          {mode === "RENVOYER" && (
                            <BoutonDecisif type="button" className="h-11" disabled={busy || !motif.trim()} onClick={() => void decider("RENVOYER")}>
                              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Confirmer le renvoi
                            </BoutonDecisif>
                          )}
                          {mode === "REFUSER" && (
                            <BoutonDecisif type="button" variant="destructive" className="h-11" disabled={busy || !motif.trim()} onClick={() => void decider("REFUSER")}>
                              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Confirmer le refus
                            </BoutonDecisif>
                          )}
                          {mode === "PRECISION" && (
                            <Button type="button" className="h-11" disabled={busy || !motif.trim()} onClick={() => void decider("PRECISION")}>
                              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer la question
                            </Button>
                          )}
                        </>
                      ) : (
                        <>
                          {g.precision && c.filCible && (
                            <Button type="button" variant="ghost" className="h-11 text-primary" onClick={() => { setMode("PRECISION"); setErr(null); }}>Demander une précision</Button>
                          )}
                          {g.refuser && <Button type="button" variant="outline" className="h-11" onClick={() => { setMode("REFUSER"); setErr(null); }}>{g.refuser}</Button>}
                          {g.renvoyer && <Button type="button" variant="outline" className="h-11" onClick={() => { setMode("RENVOYER"); setErr(null); }}>{g.renvoyer}</Button>}
                          <BoutonDecisif type="button" className="h-11" disabled={busy} onClick={() => void decider("VALIDER")}>
                            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {g.ok}
                          </BoutonDecisif>
                        </>
                      )}
                    </div>
                  </div>
                ) : null}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
