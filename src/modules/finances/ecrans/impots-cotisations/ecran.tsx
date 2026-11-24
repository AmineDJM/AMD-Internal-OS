"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  AUCUNE_PROPOSITION, decomposer, ETATS_ECHEANCE, FILTRES_ECHEANCES, formatDzd, type EtatEcheance, type SaisiesFiscales,
} from "../../domaine/impots";
import type { DonneesImpots } from "../../infra/impots";
import { dateCourte, nomSociete, Pastille, saisiesDe, type Ligne } from "./commun";
import { PanneauPreparer } from "./preparer";
import { PanneauSuivi } from "./suivi";
import { PanneauCalendrier } from "./calendrier";
import { PanneauPonctuel } from "./ponctuel";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * FINANCES › IMPÔTS & COTISATIONS — l'écran de la maquette validée (Super Admin, 24/11/2026).
 *
 * En tête : les sociétés (toutes celles du groupe que la personne voit), le menu ⋯ (calendrier, paiement ponctuel), le
 * circuit en quatre temps. À gauche les échéances, filtrées par état ; à droite la ligne choisie : « Préparer » (la
 * décomposition) tant qu'elle n'est pas partie, son suivi ensuite. Les montants viennent de la base, jamais d'exemples.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Vue = { type: "ligne"; id: string | null } | { type: "calendrier" } | { type: "ponctuel" };

const ENCART = [
  { badge: "Proposé par la paie", classe: "bg-primary/10 text-primary", titre: "IRG et CNAS", texte: " : la plateforme additionne les retenues fixes inscrites par les RH sur chaque fiche salarié (IRG, sécurité sociale 9 %, sécurité sociale 35 %). Elle ne les recalcule pas. Le virement de paie ne paie que les nets : ces retenues partent d'ici, imputées à la masse salariale des départements." },
  { badge: "Proposé par les factures", classe: "bg-primary/10 text-primary", titre: "TVA du mois", texte: " : collectée sur les ventes − déductible sur les achats, tirée des factures du mois dès qu'elles portent leur TVA ; d'ici là, recopiée de la G50. Modifiable, l'écart est tracé." },
  { badge: "À saisir depuis la déclaration", classe: "bg-warning/10 text-warning", titre: "Acomptes et solde d'IBS, autres lignes", texte: " : les Finances recopient les montants de la G50 ou du bordereau, qu'elles joignent obligatoirement." },
  { badge: "Aucun calcul fiscal", classe: "bg-secondary text-foreground", titre: "Ni taux ni assiette", texte: " : la plateforme additionne ce qui est inscrit (fiches, factures) et ne contient pas de calendrier fiscal — les jours limites sont ceux que vous paramétrez (menu ⋯ › Calendrier des échéances)." },
  { badge: "Modifiable et tracé", classe: "bg-success/10 text-success", titre: "Tout montant proposé se corrige avant l'envoi", texte: ". Le montant proposé, le montant envoyé, l'auteur et la date restent dans l'historique, visibles du centre de paiement." },
];

export function EcranImpotsCotisations({ donnees, peutModifier, peutCreer, moi, ligneInitiale }: {
  donnees: DonneesImpots; peutModifier: boolean; peutCreer: boolean; moi: string; ligneInitiale: string | null;
}) {
  const { societes, lignes, calendrier, paies } = donnees;
  const initiale = ligneInitiale ? lignes.find((l) => l.id === ligneInitiale) : undefined;
  const [soc, setSoc] = React.useState<string>(initiale?.companyId && societes.length > 1 ? "TOUS" : societes.length === 1 ? societes[0]!.id : "TOUS");
  const [filtre, setFiltre] = React.useState<"TOUS" | EtatEcheance>("TOUS");
  const [menu, setMenu] = React.useState(false);
  const [encart, setEncart] = React.useState(true);
  const [toast, setToast] = React.useState<string | null>(null);
  const [brouillons, setBrouillons] = React.useState<Record<string, SaisiesFiscales>>({});
  const [fichiers, setFichiers] = React.useState<Record<string, File | null>>({});
  const parSociete = React.useMemo(() => lignes.filter((l) => soc === "TOUS" || l.companyId === soc), [lignes, soc]);
  const premiere = (ls: Ligne[]) => (ls.find((l) => l.etat === "A_PREPARER") ?? ls[0])?.id ?? null;
  const [vue, setVue] = React.useState<Vue>({ type: "ligne", id: initiale?.id ?? premiere(parSociete) });
  const societe = (id: string) => nomSociete(societes.find((s) => s.id === id));
  const annoncer = (m: string) => setToast(m);
  const fermer = () => setVue({ type: "ligne", id: null });

  const choisirSoc = (k: string) => {
    setSoc(k);
    setFiltre("TOUS");
    setMenu(false);
    setVue({ type: "ligne", id: premiere(lignes.filter((l) => k === "TOUS" || l.companyId === k)) });
  };
  const visibles = parSociete
    .filter((l) => filtre === "TOUS" || l.etat === filtre)
    .sort((a, b) => ETATS_ECHEANCE[a.etat].ordre - ETATS_ECHEANCE[b.etat].ordre);
  const courante = vue.type === "ligne" && vue.id ? lignes.find((l) => l.id === vue.id) ?? null : null;
  const socTitre = soc === "TOUS" ? "toutes vos sociétés" : societe(soc);
  const organismesConnus = [...new Set([...calendrier.map((c) => c.organisme), ...lignes.map((l) => l.organisme)])].sort();

  const montantDeLaLigne = (l: Ligne): { montant: string; sous: string } => {
    if (l.etat !== "A_PREPARER") return { montant: `${formatDzd(l.montant)} DZD`, sous: "" };
    const p = paies[`${l.companyId}|${l.periode ?? ""}`]?.propositions ?? AUCUNE_PROPOSITION;
    const d = decomposer(l.composition, saisiesDe(l, brouillons), p);
    const sous = d.manque.length
      ? `+ ${d.manque.map((m) => (m === "TVA collectée et déductible" ? "TVA" : m)).join(", ")} à saisir`
      : d.dePaie + d.deFactures > 0 ? (d.deDeclaration > 0 ? "proposé + déclaration" : "proposé par la plateforme") : "saisi";
    return { montant: d.total > 0 ? `${formatDzd(d.total)} DZD` : "—", sous };
  };

  return (
    <div className="mx-auto flex max-w-[1232px] flex-col gap-3.5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Finances › Impôts &amp; cotisations</p>
          <h1 className="mt-0.5 text-2xl font-bold">Impôts &amp; cotisations</h1>
        </div>
        <div className="relative flex flex-wrap items-center gap-2">
          {societes.length > 1 && (
            <nav aria-label="Société" className="flex flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
              {[{ id: "TOUS", nom: "Toutes" }, ...societes.map((s) => ({ id: s.id, nom: nomSociete(s) }))].map((s) => (
                <button key={s.id} type="button" aria-pressed={soc === s.id} onClick={() => choisirSoc(s.id)}
                  className={cn("h-9 rounded-lg px-3 text-sm", soc === s.id ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-secondary")}>
                  {s.nom}
                </button>
              ))}
            </nav>
          )}
          <button type="button" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} aria-label="Autres : calendrier des échéances, ajouter un paiement ponctuel"
            className="h-11 w-11 rounded-lg border border-border bg-card text-lg hover:bg-secondary">⋯</button>
          {menu && (
            <div role="menu" className="absolute right-0 top-12 z-10 flex w-72 max-w-[calc(100vw-32px)] flex-col gap-0.5 rounded-xl border border-border bg-card p-1.5 shadow-lg">
              <button type="button" role="menuitem" onClick={() => { setMenu(false); setVue({ type: "calendrier" }); }} className="flex flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left hover:bg-secondary">
                <span className="text-sm font-semibold">Calendrier des échéances</span>
                <span className="text-xs text-muted-foreground">Organismes, natures, jours limites, rappels J-7</span>
              </button>
              {peutCreer && (
                <button type="button" role="menuitem" onClick={() => { setMenu(false); setVue({ type: "ponctuel" }); }} className="flex flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left hover:bg-secondary">
                  <span className="text-sm font-semibold">Ajouter un paiement ponctuel</span>
                  <span className="text-xs text-muted-foreground">Taxe foncière, pénalité, régularisation…</span>
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <ol aria-label="Circuit" className="flex flex-wrap gap-1.5 text-sm text-muted-foreground">
        <li className="rounded-lg bg-primary/10 px-2.5 py-1.5 font-semibold text-primary">1 · Les Finances préparent ici</li>
        <li className="px-1 py-1.5" aria-hidden>→</li>
        <li className="rounded-lg border border-border bg-card px-2.5 py-1.5">2 · Le centre de paiement autorise</li>
        <li className="px-1 py-1.5" aria-hidden>→</li>
        <li className="rounded-lg border border-border bg-card px-2.5 py-1.5">3 · Banque &amp; paiements paie</li>
        <li className="px-1 py-1.5" aria-hidden>→</li>
        <li className="rounded-lg border border-border bg-card px-2.5 py-1.5">4 · La quittance revient ici</li>
      </ol>

      {toast && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-foreground px-4 py-3 text-sm text-background">
          <span>{toast}</span>
          <button type="button" onClick={() => setToast(null)} className="font-semibold text-primary-foreground/80 hover:text-primary-foreground">Fermer</button>
        </div>
      )}

      <section aria-label="Comment la plateforme remplit ces montants" className="rounded-xl border border-border bg-card">
        <button type="button" aria-expanded={encart} onClick={() => setEncart(!encart)} className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3.5 text-left">
          <span className="font-bold">Comment la plateforme remplit ces montants</span>
          <span className="whitespace-nowrap text-sm font-semibold text-primary">{encart ? "Replier" : "Déplier"}</span>
        </button>
        {encart && (
          <ul className="grid grid-cols-1 gap-3 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {ENCART.map((e) => (
              <li key={e.badge} className="flex flex-col gap-1.5 rounded-lg bg-secondary/50 p-3">
                <span className={cn("self-start rounded-full px-2.5 py-0.5 text-xs font-semibold", e.classe)}>{e.badge}</span>
                <span className="text-sm leading-relaxed text-muted-foreground"><strong className="text-foreground">{e.titre}</strong>{e.texte}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap items-start gap-4">
        <section aria-labelledby="liste-echeances" className="min-w-0 flex-[1_1_600px] overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-col gap-2.5 px-4 pb-3 pt-4">
            <h2 id="liste-echeances" className="text-base font-bold">Échéances · {socTitre}</h2>
            <div role="group" aria-label="Filtrer par état" className="flex flex-wrap gap-1.5">
              {FILTRES_ECHEANCES.map((f) => (
                <Pastille key={f.cle} actif={filtre === f.cle} onClick={() => setFiltre(f.cle)}>
                  {f.label} · {f.cle === "TOUS" ? parSociete.length : parSociete.filter((l) => l.etat === f.cle).length}
                </Pastille>
              ))}
            </div>
          </div>
          <div className="hidden grid-cols-[minmax(0,1fr)_108px_136px_118px] gap-2.5 border-t border-border bg-secondary/50 px-4 py-2 text-xs font-semibold text-muted-foreground md:grid">
            <span>Nature · organisme · période</span><span>Société</span><span className="text-right">Montant · échéance</span><span>État</span>
          </div>
          {visibles.length === 0 && (
            <p className="border-t border-border px-4 py-6 text-sm text-muted-foreground">
              {lignes.length === 0 ? "Aucune échéance : réglez le calendrier (menu ⋯ › Calendrier des échéances) ou ajoutez un paiement ponctuel." : `Aucune ligne dans cet état pour ${socTitre}.`}
            </p>
          )}
          <ul>
            {visibles.map((l) => {
              const actif = vue.type === "ligne" && vue.id === l.id;
              const { montant, sous } = montantDeLaLigne(l);
              const paye = l.etat === "PAYE" && l.ordre?.payeLe;
              return (
                <li key={l.id} className="border-t border-border">
                  <button type="button" aria-current={actif} onClick={() => setVue({ type: "ligne", id: l.id })}
                    className={cn("grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 px-4 py-3 text-left md:grid-cols-[minmax(0,1fr)_108px_136px_118px]",
                      actif ? "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]" : "hover:bg-secondary/40")}>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-semibold [overflow-wrap:anywhere]">{l.nature}</span>
                      <span className="text-xs text-muted-foreground">{l.organisme} · {l.periodeLibelle}</span>
                      {l.etat === "REFUSE" && l.motifRefus && <span className="text-xs font-semibold text-destructive">Motif : {l.motifRefus}</span>}
                    </span>
                    <span className="hidden text-sm text-muted-foreground md:block">{societe(l.companyId)}</span>
                    <span className="flex flex-col gap-0.5 text-right">
                      <span className="whitespace-nowrap text-sm font-bold">{montant}</span>
                      {sous && <span className="text-xs text-muted-foreground">{sous}</span>}
                      <span className={cn("text-xs", paye ? "text-success" : l.etat === "A_PREPARER" ? "font-semibold text-foreground/80" : "text-muted-foreground")}>
                        {paye ? `payé le ${dateCourte(l.ordre?.payeLe)}` : l.echeanceTexte}
                      </span>
                    </span>
                    <span><Badge tone={ETATS_ECHEANCE[l.etat].tone}>{ETATS_ECHEANCE[l.etat].label}</Badge></span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="Détail" className="min-w-0 flex-[1_1_540px] rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
          {vue.type === "calendrier" ? (
            <PanneauCalendrier calendrier={calendrier} societes={societes} societeCourante={soc === "TOUS" ? null : soc} peutModifier={peutModifier} onFermer={fermer} annoncer={annoncer} />
          ) : vue.type === "ponctuel" ? (
            <PanneauPonctuel ligne={null} organismesConnus={organismesConnus} societes={societes} societeParDefaut={soc === "TOUS" ? null : soc}
              peutCreer={peutCreer} peutModifier={peutModifier} onFermer={fermer} annoncer={annoncer}
              onEnvoye={(id) => { if (id) setVue({ type: "ligne", id }); setFiltre("TOUS"); }} />
          ) : !courante ? (
            <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
              <p className="font-semibold">Choisissez une ligne</p>
              <p className="text-sm text-muted-foreground">Une ligne « À préparer » ouvre la décomposition du montant ; les autres ouvrent leur suivi.</p>
            </div>
          ) : courante.etat === "A_PREPARER" && !courante.obligationId ? (
            <PanneauPonctuel key={courante.id} ligne={courante} organismesConnus={organismesConnus} societes={societes} societeParDefaut={courante.companyId}
              peutCreer={peutCreer} peutModifier={peutModifier} onFermer={fermer} annoncer={annoncer} onEnvoye={() => undefined} />
          ) : courante.etat === "A_PREPARER" ? (
            <PanneauPreparer
              key={courante.id} ligne={courante} societe={societe(courante.companyId)} paie={paies[`${courante.companyId}|${courante.periode ?? ""}`] ?? null}
              saisies={saisiesDe(courante, brouillons)} setSaisies={(s) => setBrouillons((b) => ({ ...b, [courante.id]: s }))}
              fichier={fichiers[courante.id] ?? null} setFichier={(f) => setFichiers((x) => ({ ...x, [courante.id]: f }))}
              peutModifier={peutModifier} onFermer={fermer} annoncer={annoncer}
            />
          ) : (
            <PanneauSuivi key={courante.id} ligne={courante} societe={societe(courante.companyId)} peutModifier={peutModifier}
              estDemandeur={Boolean(courante.ordre?.demandeurId) && courante.ordre?.demandeurId === moi} onFermer={fermer} annoncer={annoncer} />
          )}
        </section>
      </div>
    </div>
  );
}
