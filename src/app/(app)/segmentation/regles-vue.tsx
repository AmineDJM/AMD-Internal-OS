"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { type CleFrequence, type ExceptionZone, type Grille, type Regles, type RegleProduit, type Capacite } from "@/lib/segmentation/regles";
import { PROPOSITION } from "@/lib/segmentation/charge";
import { apercuRegles, publierRegles, type ApercuRegles } from "@/lib/actions/segmentation-actions";
import { LettreBadge } from "./lettre-badge";

/**
 * LES RÈGLES EN CLAIR (Direction, 07/10) — les chiffres de la Direction marketing et du directeur des opérations,
 * modifiables par qui publie, VERSIONNÉS : on prépare la version suivante, on en voit l'impact, on la publie. Les
 * réglages fins (priorités, méthode d'affinité, source) restent dans « Règles détaillées » (menu ⋯).
 */

interface ProduitVue { productId: string; rang: number; nom: string }
interface SecteurVue { id: string; nom: string }

const COLONNES: { cle: CleFrequence; libelle: string }[] = [
  { cle: "H_IN", libelle: "H — In" }, { cle: "H_OUT", libelle: "H — Out" },
  { cle: "AB_IN", libelle: "A & B — In" }, { cle: "AB_OUT", libelle: "A & B — Out" },
  { cle: "CD_IN", libelle: "C & D — In" }, { cle: "CD_OUT", libelle: "C & D — Out" },
];

const nb = (v: string): number => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));
const txt = (v: number | undefined): string => (v !== undefined && Number.isFinite(v) ? String(v).replace(".", ",") : "");
const txtPct = (v: number | undefined): string => (v !== undefined && Number.isFinite(v) ? String(Math.round(v * 10000) / 100).replace(".", ",") : "");

function produitVide(productId: string): RegleProduit {
  return {
    productId, metrique: "patients / semaine", seuilPotentiel: PROPOSITION.seuilPotentiel, seuilAffinite: PROPOSITION.seuilAffinite,
    comparaisonAffinite: ">", methodeAffinite: "SUR_10", exceptions: [], reference: { ...PROPOSITION.reference },
  };
}

/** Le point de départ : la version en vigueur, sinon les valeurs proposées par la Direction (à publier). */
function depart(contenu: Regles | null, produits: ProduitVue[]): Regles {
  const base: Regles = contenu ? structuredClone(contenu) : {
    produits: [], ciblage: { statutsNonCibles: [], potentielNulNonCible: true }, h: { statuts: ["DECIDEUR"], frequence: PROPOSITION.grille.H_IN },
    priorites: { regles: [], repli: null }, frequences: {},
  };
  base.produits = produits.map((p) => base.produits.find((x) => x.productId === p.productId) ?? produitVide(p.productId));
  base.grille ??= { defaut: { ...PROPOSITION.grille, H_IN: base.h.frequence || PROPOSITION.grille.H_IN, H_OUT: base.h.frequence || PROPOSITION.grille.H_OUT }, secteurs: [] };
  base.capacite ??= { ...PROPOSITION.capacite };
  if (!base.h.statuts.length) base.h.statuts = ["DECIDEUR"];
  return base;
}

export function ReglesVue({ strategieId, produits, version, contenu, secteurs, peutPublier }: {
  strategieId: string; produits: ProduitVue[]; version: number; contenu: Regles | null; secteurs: SecteurVue[]; peutPublier: boolean;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [r, setR] = React.useState<Regles>(() => depart(contenu, produits));
  const [impact, setImpact] = React.useState<ApercuRegles | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [envoi, setEnvoi] = React.useState(false);
  const ro = !peutPublier;
  const maj = (f: (x: Regles) => void) => { setR((x) => { const y = structuredClone(x); f(y); return y; }); setImpact(null); };
  const nomSecteur = (id: string | undefined, repli: string) => secteurs.find((s) => s.id === id)?.nom ?? repli;
  const grille = r.grille as Grille;
  const capacite = r.capacite as Capacite;

  async function preparer() {
    setErreur(null);
    const contenuJson = JSON.stringify({ ...r, h: { ...r.h, frequence: grille.defaut.H_IN } });
    setEnvoi(true);
    try {
      const res = await apercuRegles(strategieId, contenuJson);
      if (!res.ok) { setErreur(res.error); return; }
      setImpact(res.apercu);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(false);
    }
  }
  async function publier() {
    setErreur(null);
    setEnvoi(true);
    try {
      const res = await publierRegles(strategieId, JSON.stringify({ ...r, h: { ...r.h, frequence: grille.defaut.H_IN } }), "");
      if (!res.ok) { setErreur(res.error); return; }
      setImpact(null);
      rafraichir();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <section className="surface min-w-0 rounded-xl">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-[15px] font-semibold">Seuils</h2>
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">Direction marketing · Directeur des opérations</span>
        </header>
        {r.produits.map((p, i) => {
          const nom = produits.find((x) => x.productId === p.productId)?.nom ?? "";
          const plusieurs = r.produits.length > 1;
          return (
            <React.Fragment key={p.productId}>
              <Regle titre={`Haut potentiel à partir de${plusieurs ? ` (${nom})` : ""}`} sous={Number.isFinite(p.seuilPotentiel) ? `≈ ${Math.round((p.seuilPotentiel * 4) / 5) * 5} patients / mois` : ""}>
                <Nombre valeur={txt(p.seuilPotentiel)} ro={ro} label="Seuil de potentiel" onChange={(v) => maj((x) => { x.produits[i].seuilPotentiel = nb(v); })} /> patients / sem.
              </Regle>
              <Regle
                titre={`Affinité au ${nom.toLowerCase() || "produit"} au-delà de`}
                sous={<Reference p={p} ro={ro} onChange={(ref) => maj((x) => { if (ref) x.produits[i].reference = ref; else delete x.produits[i].reference; })} />}
              >
                {p.comparaisonAffinite === ">" ? ">" : "≥"} <Nombre valeur={txtPct(p.seuilAffinite)} ro={ro} label="Seuil d'affinité" onChange={(v) => maj((x) => { x.produits[i].seuilAffinite = nb(v) / 100; })} /> %
              </Regle>
              {p.exceptions.map((e, j) => (
                <Regle
                  key={`${e.secteurId ?? e.zone}-${j}`}
                  titre={`Exception — secteur ${nomSecteur(e.secteurId, e.zone)}`}
                  sous={!e.secteurId ? "zone d'avant les secteurs" : e.seuilPotentiel !== undefined ? `haut potentiel à partir de ${e.seuilPotentiel}` : "seuil réduit"}
                  geste={!ro && <button type="button" className="text-xs text-muted-foreground underline" onClick={() => maj((x) => { x.produits[i].exceptions.splice(j, 1); })}>Retirer</button>}
                >
                  {(e.comparaisonAffinite ?? p.comparaisonAffinite) === ">" ? ">" : "≥"} <Nombre valeur={txtPct(e.seuilAffinite)} ro={ro} label={`Seuil d'affinité ${nomSecteur(e.secteurId, e.zone)}`} onChange={(v) => maj((x) => { const n = nb(v); if (Number.isFinite(n)) x.produits[i].exceptions[j].seuilAffinite = n / 100; else delete x.produits[i].exceptions[j].seuilAffinite; })} /> %
                </Regle>
              ))}
              {!ro && <AjoutException secteurs={secteurs.filter((s) => !p.exceptions.some((e) => e.secteurId === s.id))} onAjouter={(ex) => maj((x) => { x.produits[i].exceptions.push(ex); })} />}
            </React.Fragment>
          );
        })}
        <Regle titre="Contacts par jour et par KAM" sous={<span className="inline-flex items-center gap-1">cycle de <Nombre petit valeur={txt(capacite.joursParCycle)} ro={ro} label="Jours ouvrés par cycle" onChange={(v) => maj((x) => { x.capacite = { ...(x.capacite as Capacite), joursParCycle: nb(v) }; })} /> jours ouvrés</span>}>
          <Nombre valeur={txt(capacite.contactsParJour)} ro={ro} label="Contacts par jour" onChange={(v) => maj((x) => { x.capacite = { ...(x.capacite as Capacite), contactsParJour: nb(v) }; })} /> / jour
        </Regle>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <span>Toute modification crée une version ; les cycles en cours gardent la leur.</span>
          {!ro && !impact && <Button type="button" size="sm" disabled={envoi || enCours} onClick={preparer}>Publier la v{version + 1}</Button>}
        </div>
        {erreur && <p className="border-t border-border px-4 py-2 text-sm text-destructive" role="alert">{erreur}</p>}
        {impact && (
          <div className="space-y-1.5 border-t border-border px-4 py-3 text-sm">
            <p className="font-medium">{impact.praticiens === 0 ? "Aucun praticien ne change." : `${impact.praticiens} praticien(s) changent (${impact.total} changement(s)).`}</p>
            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {impact.changements.slice(0, 50).map((c, i) => <p key={i} className="text-xs [overflow-wrap:anywhere]">{c.nom}{c.produit ? ` · ${c.produit}` : ""} : {c.avant} → {c.apres}</p>)}
              {impact.total > 50 && <p className="text-xs text-muted-foreground">… et {impact.total - 50} autre(s).</p>}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="button" size="sm" disabled={envoi || enCours} onClick={publier}>Confirmer la v{version + 1}</Button>
              <Button type="button" size="sm" variant="ghost" disabled={envoi} onClick={() => setImpact(null)}>Revenir</Button>
            </div>
          </div>
        )}
      </section>

      <section className="surface min-w-0 rounded-xl">
        <header className="border-b border-border px-4 py-3"><h2 className="text-[15px] font-semibold">Qui reçoit quelle lettre</h2></header>
        <div className="py-1 text-sm">
          <Statut nom="Décideur"><LettreBadge lettre="H" /> d&apos;office — chef de service ou pharmacien. Fréquence au moins égale à A et B.</Statut>
          <Statut nom="Influenceur">Segmenté A à D selon ses réponses. Un référent qui influence est classé influenceur.</Statut>
          <Statut nom="Référent">Segmenté A à D selon ses réponses.</Statut>
          <Statut nom="Prescripteur">
            <LettreBadge lettre="A" /> élevé + affinité · <LettreBadge lettre="B" /> élevé sans affinité · <LettreBadge lettre="C" /> faible + affinité · <LettreBadge lettre="D" /> faible sans affinité. Un résident qui ne consulte pas (Q1 = 0) n&apos;est pas ciblé.
          </Statut>
          <Statut nom="Sans réponse"><LettreBadge lettre="NA" /> tant que Q1 ou Q2 manque — jamais D par défaut.</Statut>
        </div>
      </section>

      <section className="surface min-w-0 rounded-xl lg:col-span-2">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-[15px] font-semibold">Fréquence de visite par cycle</h2>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            par défaut · un secteur peut avoir la sienne
            <InfoBulle label="Fréquence des décideurs">H se règle à part : au moins égale à A &amp; B, jamais en dessous.</InfoBulle>
          </span>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/40 text-muted-foreground">
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">Secteur</th>
                {COLONNES.map((c) => <th key={c.cle} className="whitespace-nowrap px-2 py-1.5 text-center font-medium">{c.libelle}</th>)}
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border">
                <td className="whitespace-nowrap px-2 py-1.5 font-semibold">Par défaut</td>
                {COLONNES.map((c) => (
                  <td key={c.cle} className="px-2 py-1.5 text-center">
                    <Freq valeur={txt(grille.defaut[c.cle])} ro={ro} label={`Par défaut ${c.libelle}`} onChange={(v) => maj((x) => {
                      const g = x.grille as Grille;
                      const n = nb(v);
                      // H suit A & B tant qu'on ne l'a pas réglé autrement.
                      if (c.cle === "AB_IN" && g.defaut.H_IN === g.defaut.AB_IN) g.defaut.H_IN = n;
                      if (c.cle === "AB_OUT" && g.defaut.H_OUT === g.defaut.AB_OUT) g.defaut.H_OUT = n;
                      g.defaut[c.cle] = n;
                    })} />
                  </td>
                ))}
                <td />
              </tr>
              {grille.secteurs.map((s, j) => (
                <tr key={s.secteurId} className="border-t border-border">
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {nomSecteur(s.secteurId, s.nom)} <span className="ml-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">exception</span>
                  </td>
                  {COLONNES.map((c) => (
                    <td key={c.cle} className="px-2 py-1.5 text-center">
                      <Freq
                        valeur={txt(s.valeurs[c.cle])} defaut={txt(grille.defaut[c.cle])} ro={ro} label={`${nomSecteur(s.secteurId, s.nom)} ${c.libelle}`}
                        onChange={(v) => maj((x) => { const n = nb(v); const cible = (x.grille as Grille).secteurs[j]; if (Number.isFinite(n)) cible.valeurs[c.cle] = n; else delete cible.valeurs[c.cle]; })}
                      />
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right">
                    {!ro && <button type="button" className="text-muted-foreground underline" onClick={() => maj((x) => { (x.grille as Grille).secteurs.splice(j, 1); })}>Retirer</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!ro && (
          <div className="border-t border-border px-4 py-2.5">
            <select
              value="" aria-label="Ajouter un secteur" className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
              onChange={(e) => { const s = secteurs.find((x) => x.id === e.target.value); if (s) maj((x) => { (x.grille as Grille).secteurs.push({ secteurId: s.id, nom: s.nom, valeurs: {} }); }); }}
            >
              <option value="">+ Fréquence propre à un secteur…</option>
              {secteurs.filter((s) => !grille.secteurs.some((x) => x.secteurId === s.id)).map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
            </select>
          </div>
        )}
        <div className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">In : même wilaya que la ville pivot du secteur · Out : hors wilaya. Calculé, modifiable par praticien.</div>
      </section>
    </div>
  );
}

function Regle({ titre, sous, geste, children }: { titre: string; sous?: React.ReactNode; geste?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0">
      <div className="min-w-0">
        <b className="block font-medium">{titre}</b>
        {sous && <small className="block text-xs text-muted-foreground">{sous}</small>}
        {geste}
      </div>
      <span className="inline-flex items-center gap-1 whitespace-nowrap">{children}</span>
    </div>
  );
}

function Nombre({ valeur, ro, label, onChange, petit }: { valeur: string; ro: boolean; label: string; onChange: (v: string) => void; petit?: boolean }) {
  const [t, setT] = React.useState(valeur);
  React.useEffect(() => { setT(valeur); }, [valeur]);
  if (ro) return <b className="font-medium tabular-nums">{valeur || "—"}</b>;
  return (
    <input
      value={t} inputMode="decimal" aria-label={label} required
      onChange={(e) => setT(e.target.value)} onBlur={() => { if (t !== valeur) onChange(t); }}
      className={cn("rounded-md border border-border bg-background px-2 py-1 text-right tabular-nums", petit ? "w-12 text-xs" : "w-16")}
    />
  );
}

function Freq({ valeur, defaut, ro, label, onChange }: { valeur: string; defaut?: string; ro: boolean; label: string; onChange: (v: string) => void }) {
  const [t, setT] = React.useState(valeur);
  React.useEffect(() => { setT(valeur); }, [valeur]);
  if (ro) return <span className={cn("tabular-nums", !valeur && "text-muted-foreground")}>{valeur || defaut || "—"}</span>;
  return (
    <input
      value={t} inputMode="decimal" aria-label={label} placeholder={defaut}
      onChange={(e) => setT(e.target.value)} onBlur={() => { if (t !== valeur) onChange(t); }}
      className="w-11 rounded-md border border-border bg-background px-1 py-0.5 text-center tabular-nums placeholder:text-muted-foreground/60"
    />
  );
}

/** « moyenne nationale 2026 : 7,21 % » — un repère, réglable, qui ne classe personne. */
function Reference({ p, ro, onChange }: { p: RegleProduit; ro: boolean; onChange: (ref: { valeur: number; annee: number } | undefined) => void }) {
  const ref = p.reference;
  if (ro) return ref ? <>moyenne nationale {ref.annee} : {txtPct(ref.valeur)} %</> : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      moyenne nationale
      <Nombre petit valeur={ref ? String(ref.annee) : ""} ro={false} label="Année de la moyenne nationale" onChange={(v) => { const a = Math.round(nb(v)); if (Number.isFinite(a)) onChange({ valeur: ref?.valeur ?? NaN, annee: a }); else onChange(undefined); }} />
      :
      <Nombre petit valeur={txtPct(ref?.valeur)} ro={false} label="Moyenne nationale (%)" onChange={(v) => { const n = nb(v) / 100; if (Number.isFinite(n)) onChange({ valeur: n, annee: ref?.annee ?? new Date().getFullYear() }); else onChange(undefined); }} />
      %
    </span>
  );
}

/** Ajouter un seuil d'affinité propre à un secteur — la valeur part VIDE : ce sont les responsables qui la fixent. */
function AjoutException({ secteurs, onAjouter }: { secteurs: SecteurVue[]; onAjouter: (e: ExceptionZone) => void }) {
  const [secteurId, setSecteurId] = React.useState("");
  const [valeur, setValeur] = React.useState("");
  if (secteurs.length === 0) return null;
  const n = nb(valeur);
  const ok = !!secteurId && Number.isFinite(n) && n >= 0 && n <= 100;
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-xs"
      onSubmit={(e) => { e.preventDefault(); const s = secteurs.find((x) => x.id === secteurId); if (!s || !ok) return; onAjouter({ zone: s.nom, secteurId: s.id, seuilAffinite: n / 100 }); setSecteurId(""); setValeur(""); }}
    >
      <span className="text-muted-foreground">Seuil propre à un secteur</span>
      <select value={secteurId} onChange={(e) => setSecteurId(e.target.value)} aria-label="Secteur de l'exception" className="rounded-lg border border-border bg-background px-2 py-1">
        <option value="">Secteur…</option>
        {secteurs.map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
      </select>
      <span>&gt;</span>
      <input value={valeur} onChange={(e) => setValeur(e.target.value)} inputMode="decimal" required aria-label="Seuil d'affinité du secteur (%)" className="w-14 rounded-md border border-border bg-background px-2 py-1 text-right" />
      <span>%</span>
      <Button type="submit" size="sm" variant="outline" disabled={!ok}>Ajouter</Button>
    </form>
  );
}

function Statut({ nom, children }: { nom: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2.5 border-b border-border px-4 py-2.5 last:border-b-0">
      <b className="font-semibold">{nom}</b>
      <span className="leading-relaxed">{children}</span>
    </div>
  );
}

