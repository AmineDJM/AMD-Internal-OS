"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Label } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { STATUTS, STATUT_LABELS, SEGMENTS, METHODE_LABELS, SOURCE_AFFINITE_LABELS, pct, type Regles, type RegleProduit, type ReglePriorite, type Segment, type Statut } from "@/lib/segmentation/regles";
import { libelleRegle } from "@/lib/segmentation/moteur";
import { apercuRegles, publierRegles, type ApercuRegles } from "@/lib/actions/segmentation-actions";

/**
 * LES RÈGLES — lues telles qu'elles s'appliquent, modifiables par qui a le droit de les PUBLIER. On ne modifie jamais
 * une version : on prépare la suivante, on en voit l'IMPACT (qui change, de quoi à quoi), puis on la publie.
 */

interface ProduitVue { productId: string; rang: number; nom: string }

const vide = (produits: ProduitVue[]): Regles => ({
  produits: produits.map((p) => ({ productId: p.productId, metrique: "patients / semaine", seuilPotentiel: NaN, seuilAffinite: NaN, comparaisonAffinite: ">", methodeAffinite: "SUR_10", exceptions: [] })),
  ciblage: { statutsNonCibles: [], potentielNulNonCible: true },
  h: { statuts: ["DECIDEUR"], frequence: NaN },
  priorites: { regles: [], repli: null },
  frequences: {},
});

/** Aligne les règles sur le classement en vigueur : un produit nouvellement classé arrive sans seuil (à remplir). */
function aligner(r: Regles, produits: ProduitVue[]): Regles {
  return { ...r, produits: produits.map((p) => r.produits.find((x) => x.productId === p.productId) ?? vide([p]).produits[0]) };
}

const n = (v: string): number => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));
const champ = (v: number): string => (Number.isFinite(v) ? String(v) : "");
const champPct = (v: number | undefined): string => (v !== undefined && Number.isFinite(v) ? String(Math.round(v * 10000) / 100) : "");

export function EditeurRegles({ strategieId, produits, version, contenu, peutPublier }: {
  strategieId: string; produits: ProduitVue[]; version: number; contenu: Regles | null; peutPublier: boolean;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [r, setR] = React.useState<Regles>(() => aligner(contenu ?? vide(produits), produits));
  const [note, setNote] = React.useState("");
  const [impact, setImpact] = React.useState<ApercuRegles | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [envoi, setEnvoi] = React.useState(false);
  const nomDe = (id: string) => produits.find((p) => p.productId === id)?.nom ?? id;
  const maj = (f: (x: Regles) => Regles) => { setR((x) => f(structuredClone(x))); setImpact(null); };
  const majProduit = (i: number, f: (p: RegleProduit) => void) => maj((x) => { f(x.produits[i]); return x; });

  if (!peutPublier) {
    if (!contenu) return <p className="surface p-5 text-sm text-muted-foreground">Aucune règle publiée.</p>;
    return (
      <div className="surface space-y-2 p-5 text-sm">
        <p className="font-semibold">Règles v{version}</p>
        {contenu.produits.map((p) => (
          <p key={p.productId}>{nomDe(p.productId)} : haut potentiel à partir de {p.seuilPotentiel} {p.metrique} ; haute affinité {p.comparaisonAffinite === ">" ? "au-delà de" : "à partir de"} {pct(p.seuilAffinite)} ({METHODE_LABELS[p.methodeAffinite]}).{p.exceptions.map((e) => ` Exception ${e.zone} : ${e.seuilPotentiel ?? p.seuilPotentiel} patients, ${pct(e.seuilAffinite ?? p.seuilAffinite)}.`).join("")}</p>
        ))}
        <p>H ({contenu.h.statuts.map((s) => STATUT_LABELS[s]).join(", ")}) : {contenu.h.frequence} visite(s) par cycle.</p>
        {contenu.priorites.regles.map((x, i) => <p key={i}>{libelleRegle(x)} — {contenu.frequences[x.priorite]} visite(s) par cycle.</p>)}
        {(contenu.exceptionsFrequence ?? []).map((x, i) => <p key={`x${i}`}>{x.priorite === "H" ? "H" : `Priorité ${x.priorite}`} — {x.zone ?? "toutes zones"}{x.inOut ? `, ${x.inOut === "IN" ? "In (wilaya pivot du KAM)" : "Out"}` : ""} : {x.frequence} visite(s) par cycle.</p>)}
      </div>
    );
  }

  async function voirImpact() {
    setEnvoi(true); setErreur(null);
    try {
      const res = await apercuRegles(strategieId, JSON.stringify(r));
      if (!res.ok) { setErreur(res.error); return; }
      setImpact(res.apercu);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(false);
    }
  }
  async function publier() {
    setEnvoi(true); setErreur(null);
    try {
      const res = await publierRegles(strategieId, JSON.stringify(r), note);
      if (!res.ok) { setErreur(res.error); return; }
      setImpact(null); setNote(""); rafraichir();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{version ? `Version en vigueur : v${version}. Vos changements prépareront la v${version + 1} ; la v${version} reste intacte.` : "Aucune version publiée : celle-ci sera la v1."}</p>
      {r.produits.map((p, i) => (
        <section key={p.productId} className="surface space-y-3 p-3 sm:p-4">
          <h3 className="text-sm font-semibold">#{i + 1} {nomDe(p.productId)}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div><Label>Potentiel mesuré</Label><Input value={p.metrique} onChange={(e) => majProduit(i, (x) => { x.metrique = e.target.value; })} /></div>
            <div><Label>Haut potentiel à partir de</Label><Input inputMode="decimal" value={champ(p.seuilPotentiel)} onChange={(e) => majProduit(i, (x) => { x.seuilPotentiel = n(e.target.value); })} /></div>
            <div><Label>Seuil d&apos;affinité (%)</Label><Input inputMode="decimal" value={champPct(p.seuilAffinite)} onChange={(e) => majProduit(i, (x) => { x.seuilAffinite = n(e.target.value) / 100; })} /></div>
            <div><Label>Comparaison</Label><Select value={p.comparaisonAffinite} onChange={(e) => majProduit(i, (x) => { x.comparaisonAffinite = e.target.value === ">=" ? ">=" : ">"; })}><option value=">">au-delà (&gt;)</option><option value=">=">à partir de (≥)</option></Select></div>
            <div><Label>Source de l&apos;affinité</Label><Select value={p.sourceAffinite ?? "DECLAREE"} onChange={(e) => majProduit(i, (x) => { const v = e.target.value; if (v === "ETABLISSEMENT" || v === "DECLAREE_SINON_ETABLISSEMENT") x.sourceAffinite = v; else delete x.sourceAffinite; })}>{(["DECLAREE", "ETABLISSEMENT", "DECLAREE_SINON_ETABLISSEMENT"] as const).map((m) => <option key={m} value={m}>{SOURCE_AFFINITE_LABELS[m]}</option>)}</Select></div>
            <div><Label>Affinité calculée par</Label><Select value={p.methodeAffinite} onChange={(e) => majProduit(i, (x) => { x.methodeAffinite = e.target.value === "RATIO_FICHIER" ? "RATIO_FICHIER" : "SUR_10"; })}>{(["SUR_10", "RATIO_FICHIER"] as const).map((m) => <option key={m} value={m}>{METHODE_LABELS[m]}</option>)}</Select></div>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold">Exceptions par zone</p>
            {p.exceptions.map((ex, j) => (
              <div key={j} className="flex flex-wrap items-end gap-2">
                <Input value={ex.zone} onChange={(e) => majProduit(i, (x) => { x.exceptions[j].zone = e.target.value; })} placeholder="Zone" className="w-28" />
                <Input inputMode="decimal" value={ex.seuilPotentiel === undefined ? "" : String(ex.seuilPotentiel)} onChange={(e) => majProduit(i, (x) => { const v = n(e.target.value); if (Number.isFinite(v)) x.exceptions[j].seuilPotentiel = v; else delete x.exceptions[j].seuilPotentiel; })} placeholder="Potentiel" className="w-24" />
                <Input inputMode="decimal" value={champPct(ex.seuilAffinite)} onChange={(e) => majProduit(i, (x) => { const v = n(e.target.value); if (Number.isFinite(v)) x.exceptions[j].seuilAffinite = v / 100; else delete x.exceptions[j].seuilAffinite; })} placeholder="Affinité %" className="w-24" />
                <Select value={ex.comparaisonAffinite ?? p.comparaisonAffinite} onChange={(e) => majProduit(i, (x) => { x.exceptions[j].comparaisonAffinite = e.target.value === ">=" ? ">=" : ">"; })} className="w-24"><option value=">">&gt;</option><option value=">=">≥</option></Select>
                <button type="button" className="py-2 text-xs text-muted-foreground underline sm:py-0" onClick={() => majProduit(i, (x) => { x.exceptions.splice(j, 1); })}>Retirer</button>
              </div>
            ))}
            <button type="button" className="py-2 text-xs text-primary underline sm:py-0" onClick={() => majProduit(i, (x) => { x.exceptions.push({ zone: "" }); })}>Ajouter une exception</button>
          </div>
        </section>
      ))}

      <section className="surface grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Ciblage</h3>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={r.ciblage.potentielNulNonCible} onChange={(e) => maj((x) => { x.ciblage.potentielNulNonCible = e.target.checked; return x; })} /> Potentiel déclaré à 0 = non ciblé (ne consulte pas)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!r.ciblage.potentielNulNA} onChange={(e) => maj((x) => { if (e.target.checked) x.ciblage.potentielNulNA = true; else delete x.ciblage.potentielNulNA; return x; })} /> Potentiel déclaré à 0 = NA (non applicable, reste au panel)</label>
          <p className="text-xs text-muted-foreground">Statuts jamais ciblés :</p>
          <div className="flex flex-wrap gap-3">{STATUTS.map((s) => <label key={s} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={r.ciblage.statutsNonCibles.includes(s)} onChange={(e) => maj((x) => { x.ciblage.statutsNonCibles = e.target.checked ? [...x.ciblage.statutsNonCibles, s] : x.ciblage.statutsNonCibles.filter((y) => y !== s); return x; })} />{STATUT_LABELS[s]}</label>)}</div>
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Décideurs (H)</h3>
          <div className="flex flex-wrap gap-3">{STATUTS.map((s) => <label key={s} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={r.h.statuts.includes(s)} onChange={(e) => maj((x) => { x.h.statuts = e.target.checked ? [...x.h.statuts, s] : x.h.statuts.filter((y) => y !== s); return x; })} />{STATUT_LABELS[s as Statut]}</label>)}</div>
          <div className="w-full sm:w-48"><Label>Visites H par cycle</Label><Input inputMode="decimal" value={champ(r.h.frequence)} onChange={(e) => maj((x) => { x.h.frequence = n(e.target.value); return x; })} /></div>
        </div>
      </section>

      <section className="surface space-y-3 p-4">
        <h3 className="text-sm font-semibold">Priorités et visites par cycle</h3>
        {r.priorites.regles.map((x, i) => (
          <RegleLigne key={i} regle={x} frequence={r.frequences[x.priorite]} nbProduits={r.produits.length}
            onChange={(nouvelle, freq) => maj((y) => { const ancien = y.priorites.regles[i].priorite; y.priorites.regles[i] = nouvelle; if (ancien !== nouvelle.priorite && !y.priorites.regles.some((z, k) => k !== i && z.priorite === ancien)) delete y.frequences[ancien]; y.frequences[nouvelle.priorite] = freq; return y; })}
            onRetirer={() => maj((y) => { y.priorites.regles.splice(i, 1); return y; })} />
        ))}
        <button type="button" className="py-2 text-xs text-primary underline sm:py-0" onClick={() => maj((y) => { const p = `P${y.priorites.regles.length + 1}`; y.priorites.regles.push({ priorite: p, rang1: ["A"] }); y.frequences[p] = y.frequences[p] ?? 1; return y; })}>Ajouter une règle</button>
        <p className="text-xs text-muted-foreground">Les règles se lisent dans l&apos;ordre ; la première qui s&apos;applique donne la priorité. Une combinaison qu&apos;aucune règle ne couvre reste sans priorité (aucune valeur n&apos;est inventée).</p>
      </section>

      <section className="surface space-y-3 p-4">
        <h3 className="text-sm font-semibold">Fréquences particulières (zone, In / Out)</h3>
        <p className="text-xs text-muted-foreground">« In » : le praticien est dans la wilaya pivot du KAM qui le couvre (la ville pivot de son territoire) ; « Out » : dans une autre wilaya. L&apos;exception la plus précise l&apos;emporte.</p>
        {(r.exceptionsFrequence ?? []).map((x, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 text-sm">
            <Input value={x.priorite} onChange={(e) => maj((y) => { y.exceptionsFrequence![i].priorite = e.target.value.trim(); return y; })} placeholder="P1 ou H" className="w-20" title="Priorité (P1, P2…) ou H" />
            <Input value={x.zone ?? ""} onChange={(e) => maj((y) => { y.exceptionsFrequence![i].zone = e.target.value.trim() || null; return y; })} placeholder="Zone (toutes)" className="w-32" />
            <Select value={x.inOut ?? ""} onChange={(e) => maj((y) => { const v = e.target.value; y.exceptionsFrequence![i].inOut = v === "IN" || v === "OUT" ? v : null; return y; })} className="w-28">
              <option value="">In et Out</option><option value="IN">In</option><option value="OUT">Out</option>
            </Select>
            <Input inputMode="decimal" value={champ(x.frequence)} onChange={(e) => maj((y) => { y.exceptionsFrequence![i].frequence = n(e.target.value); return y; })} className="w-16" title="Visites par cycle" />
            <span className="text-xs text-muted-foreground">visite(s) / cycle</span>
            <button type="button" className="py-2 text-xs text-muted-foreground underline sm:py-0" onClick={() => maj((y) => { y.exceptionsFrequence!.splice(i, 1); if (y.exceptionsFrequence!.length === 0) delete y.exceptionsFrequence; return y; })}>Retirer</button>
          </div>
        ))}
        <button type="button" className="py-2 text-xs text-primary underline sm:py-0" onClick={() => maj((y) => { y.exceptionsFrequence = [...(y.exceptionsFrequence ?? []), { zone: null, inOut: "IN", priorite: "P1", frequence: NaN }]; return y; })}>Ajouter une fréquence particulière</button>
      </section>

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full sm:w-80"><Label>Note de version</Label><Input value={note} onChange={(e) => { setNote(e.target.value); }} placeholder="Ce qui change, et pourquoi" /></div>
        {!impact ? (
          <Button type="button" variant="outline" disabled={envoi || enCours} onClick={voirImpact}>Voir l&apos;impact</Button>
        ) : (
          <Button type="button" disabled={envoi || enCours} onClick={publier}>Publier la v{version + 1}</Button>
        )}
      </div>
      {erreur && <p className="text-sm text-destructive">{erreur}</p>}
      {impact && (
        <div className="surface space-y-1 p-4 text-sm">
          <p className="font-semibold">{impact.praticiens === 0 ? "Aucun praticien ne change." : `${impact.praticiens} praticien(s) changent (${impact.total} changement(s)).`}</p>
          {impact.changements.map((c, i) => <p key={i} className="text-xs [overflow-wrap:anywhere]">{c.nom}{c.produit ? ` · ${c.produit}` : ""} : {c.avant} → {c.apres}</p>)}
          {impact.total > impact.changements.length && <p className="text-xs text-muted-foreground">… et {impact.total - impact.changements.length} autre(s).</p>}
        </div>
      )}
    </div>
  );
}

function RegleLigne({ regle, frequence, nbProduits, onChange, onRetirer }: {
  regle: ReglePriorite; frequence: number | undefined; nbProduits: number;
  onChange: (r: ReglePriorite, freq: number) => void; onRetirer: () => void;
}) {
  const type = regle.combinaison ? "combinaison" : regle.auMoins ? "auMoins" : "rang1";
  const segs: Segment[] = regle.combinaison ?? regle.rang1 ?? (regle.auMoins ? [regle.auMoins.segment] : []);
  const freq = frequence ?? NaN;
  const avec = (t: string, s: Segment[], nb = regle.auMoins?.nombre ?? 2): ReglePriorite =>
    t === "combinaison" ? { priorite: regle.priorite, combinaison: s.slice(0, nbProduits) } : t === "auMoins" ? { priorite: regle.priorite, auMoins: { segment: s[0] ?? "A", nombre: nb } } : { priorite: regle.priorite, rang1: s };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>Si</span>
      <Select value={type} onChange={(e) => onChange(avec(e.target.value, segs.length ? segs : ["A"]), freq)} className="w-44">
        <option value="rang1">produit #1 en</option>
        <option value="auMoins">au moins N produits en</option>
        {nbProduits > 1 && <option value="combinaison">exactement</option>}
      </Select>
      {type === "auMoins" && <Input inputMode="numeric" value={String(regle.auMoins?.nombre ?? 2)} onChange={(e) => onChange(avec("auMoins", segs, Math.max(1, Math.floor(n(e.target.value)) || 1)), freq)} className="w-14" />}
      <div className="flex flex-wrap gap-1">
        {type === "combinaison"
          ? Array.from({ length: nbProduits }, (_, k) => (
              <Select key={k} value={segs[k] ?? "A"} onChange={(e) => { const s = [...segs]; s[k] = e.target.value as Segment; onChange(avec("combinaison", s), freq); }} className="w-16">{SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
            ))
          : SEGMENTS.map((s) => (
              <label key={s} className="flex min-h-9 items-center gap-0.5 px-1 sm:min-h-0 sm:px-0"><input type={type === "auMoins" ? "radio" : "checkbox"} checked={segs.includes(s)} onChange={(e) => onChange(avec(type, type === "auMoins" ? [s] : e.target.checked ? [...segs, s] : segs.filter((x) => x !== s)), freq)} />{s}</label>
            ))}
      </div>
      <span>→</span>
      <Input value={regle.priorite} onChange={(e) => onChange({ ...regle, priorite: e.target.value }, freq)} className="w-16" />
      <Input inputMode="decimal" value={champ(freq)} onChange={(e) => onChange(regle, n(e.target.value))} className="w-16" title="Visites par cycle" />
      <span className="text-xs text-muted-foreground">visite(s) / cycle</span>
      <button type="button" className="py-2 text-xs text-muted-foreground underline sm:py-0" onClick={onRetirer}>Retirer</button>
    </div>
  );
}
