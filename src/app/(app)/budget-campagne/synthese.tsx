"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Tuile } from "@/components/shared/tuile";
import { cn } from "@/lib/utils";
import { MOIS_COURTS } from "@/lib/budget-campagne/recettes";
import {
  CLES_IMPOTS, LIBELLE_IMPOT, LIBELLE_NATURE_TVA, MOIS_EXERCICE_SUIVANT, NATURES_TVA, TAUX_TVA_PCT, calendrierEnTexte,
  type CleImpot, type NatureTva, type PrevisionSociete,
} from "@/lib/budget-campagne/impots";
import type { VueSynthese } from "@/lib/budget-campagne/recettes-requetes";
import { ajusterImpotCampagne, reglerParametresImpotsCampagne, reglerTvaLigneDepense } from "@/lib/actions/budget-campagne-recettes-actions";
import { useActions, th, td, num, btn, btnPrimaire, champ, m } from "./commun";

type Vue = Extract<VueSynthese, { kind: "ok" }>;
const COLONNES = [...MOIS_COURTS, "N+1"];
/** Le champ du formulaire de chaque nature (nommé en clair côté serveur). */
const CHAMP_TVA: Record<NatureTva, string> = { RECETTES: "tvaRecettes", DEPENSES: "tvaDepenses", MASSE_SALARIALE: "tvaMasseSalariale", VERSEMENTS_ETAT: "tvaVersementsEtat" };

/**
 * LE RÉSULTAT PRÉVISIONNEL (Super Admin, DG) — ventes HT − achats HT = résultat avant impôt ; − IBS = résultat net, par
 * société et par mois ; la masse salariale en trois (net + primes, IRG, CNAS) face au coût employeur des fiches ; la TVA
 * à reverser en trésorerie ; le volet Impôts & taxes (TVA nette, IBS : calcul, ajustements tracés) et ses taux. Les dépenses annuelles
 * des pôles se lisent selon leur profil (primes au mois de leur versement), sinon en douzièmes.
 */
export function SyntheseCampagne({ campaignId, vue }: { campaignId: string; vue: Vue }) {
  const { run, busy, info } = useActions();
  const modifiable = !vue.figeesLe;
  const nom = (id: string | null) => (id === null ? "Hors société" : vue.societes.find((s) => s.id === id)?.label ?? "—");
  const g = vue.groupe.totaux;
  const [societe, setSociete] = React.useState<string>(vue.previsions.find((p) => p.companyId)?.companyId ?? "");
  const choisie = vue.previsions.find((p) => p.companyId === societe) ?? null;

  return (
    <div className="space-y-4">
      {info && <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{info}</p>}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        <Tuile label="Ventes HT" valeur={m(g.recettesHT)} />
        <Tuile label="Achats HT" valeur={m(g.depenses)} info={<InfoBulle label="Achats">Budgétés TTC ; la TVA de chaque ligne, à son taux, en est retirée.</InfoBulle>} />
        <Tuile label="Résultat avant impôt" valeur={m(g.resultatAvantImpot)} ton={g.resultatAvantImpot < 0 ? "danger" : "defaut"} />
        <Tuile label="Résultat net" valeur={m(g.resultatNet)} ton={g.resultatNet < 0 ? "danger" : "ok"} contexte={`IBS ${m(g.ibs)}`} />
        <Tuile label="Impôts & taxes" valeur={m(g.enveloppeImpotsTaxes)} contexte={`dont TVA à reverser ${m(g.tvaAReverser)}`}
          info={<InfoBulle label="TVA">La TVA est un flux de caisse : elle entre dans l&apos;enveloppe Impôts &amp; taxes et la trésorerie, jamais dans le résultat.</InfoBulle>} />
      </div>
      {!vue.parametres.confirmesParCabinet && <Badge tone="warning" dot={false}>Taux préréglés — à confirmer par le cabinet</Badge>}

      <section className="surface overflow-hidden">
        <header className="border-b border-border px-4 py-3"><h2 className="text-base font-semibold">Résultat prévisionnel {vue.annee}</h2></header>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr><th className={th}>Société</th>{COLONNES.map((c) => <th key={c} className={cn(th, num)}>{c}</th>)}<th className={cn(th, num)}>Total</th></tr></thead>
            <tbody>
              {vue.previsions.length === 0 && <tr><td className={td} colSpan={15}><span className="text-muted-foreground">Rien de prévu : saisissez les recettes, les pôles leurs dépenses.</span></td></tr>}
              {vue.previsions.map((p) => <BlocSociete key={p.companyId ?? "_"} nom={nom(p.companyId)} p={p} />)}
              {vue.previsions.length > 1 && (
                <>
                  <Rangee libelle="Groupe — résultat avant impôt" valeurs={[...vue.groupe.resultatAvantImpot, null]} total={g.resultatAvantImpot} fort />
                  <Rangee libelle="Groupe — résultat net" valeurs={vue.groupe.resultatNet} total={g.resultatNet} fort />
                </>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="surface overflow-hidden">
        <header className="border-b border-border px-4 py-3"><h2 className="text-base font-semibold">Masse salariale {vue.annee}</h2></header>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr>
              <th className={th}>Société</th><th className={cn(th, num)}>Net + primes</th><th className={cn(th, num)}>IRG</th><th className={cn(th, num)}>CNAS</th>
              <th className={cn(th, num)}>Masse salariale</th><th className={cn(th, num)}>Coût employeur des fiches</th>
            </tr></thead>
            <tbody>
              {vue.previsions.map((p) => {
                const c = p.controleMasseSalariale;
                return (
                  <tr key={p.companyId ?? "_"}>
                    <td className={td}>{nom(p.companyId)}</td>
                    <td className={cn(td, num)}>{m(p.masseSalariale.netEtPrimes)}</td>
                    <td className={cn(td, num)}>{m(p.masseSalariale.irg)}</td>
                    <td className={cn(td, num)}>{m(p.masseSalariale.cnas)}</td>
                    <td className={cn(td, num, "font-medium")}>{m(p.masseSalariale.total)}</td>
                    <td className={cn(td, num, c && !c.boucle && "text-warning")} title={c && !c.boucle ? `écart ${m(c.ecart)}` : undefined}>{c ? m(c.coutEmployeur) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="surface overflow-hidden">
        <header className="border-b border-border px-4 py-3"><h2 className="text-base font-semibold">Trésorerie — TVA à reverser</h2></header>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr><th className={th}>Société</th>{MOIS_COURTS.map((c) => <th key={c} className={cn(th, num)}>{c}</th>)}<th className={cn(th, num)}>Total</th><th className={cn(th, num)}>Crédit fin d&apos;année</th></tr></thead>
            <tbody>
              {vue.previsions.map((p) => (
                <tr key={p.companyId ?? "_"}>
                  <td className={td}>{nom(p.companyId)}</td>
                  {p.tvaAReverser.map((v, i) => <td key={i} className={cn(td, num)}>{m(v)}</td>)}
                  <td className={cn(td, num, "font-medium")}>{m(p.totaux.tvaAReverser)}</td>
                  <td className={cn(td, num)}>{p.creditTvaFinDAnnee ? m(p.creditTvaFinDAnnee) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="surface overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">Impôts &amp; taxes</h2>
          <select className={champ} aria-label="Société" value={societe} onChange={(e) => setSociete(e.target.value)}>
            {vue.previsions.filter((p) => p.companyId).map((p) => <option key={p.companyId!} value={p.companyId!}>{nom(p.companyId)}</option>)}
          </select>
        </header>
        {choisie ? <Enveloppe campaignId={campaignId} p={choisie} modifiable={modifiable} run={run} busy={busy} /> : <p className="px-4 py-3 text-sm text-muted-foreground">Aucune société.</p>}
      </section>

      {modifiable && <Parametres campaignId={campaignId} vue={vue} run={run} busy={busy} />}
    </div>
  );
}

function Rangee({ libelle, valeurs, total, fort }: { libelle: string; valeurs: (number | null)[]; total: number; fort?: boolean }) {
  return (
    <tr className={cn(fort && "font-semibold")}>
      <td className={td}>{libelle}</td>
      {COLONNES.map((c, i) => <td key={c} className={cn(td, num, (valeurs[i] ?? 0) < 0 && "text-destructive")}>{valeurs[i] === null || valeurs[i] === undefined || (i === 12 && !valeurs[i]) ? "" : m(valeurs[i])}</td>)}
      <td className={cn(td, num, "font-medium", total < 0 && "text-destructive")}>{m(total)}</td>
    </tr>
  );
}

function BlocSociete({ nom, p }: { nom: string; p: PrevisionSociete }) {
  return (
    <>
      <tr><td className={cn(td, "bg-secondary/30 font-semibold")} colSpan={15}>{nom}</td></tr>
      <Rangee libelle="Ventes HT" valeurs={[...p.recettesHT, null]} total={p.totaux.recettesHT} />
      <Rangee libelle="Achats HT" valeurs={[...p.depenses, null]} total={p.totaux.depenses} />
      <Rangee libelle="Résultat avant impôt" valeurs={[...p.resultatAvantImpot, null]} total={p.totaux.resultatAvantImpot} fort />
      <Rangee libelle="IBS" valeurs={p.impots.IBS.map((c) => c.retenu)} total={p.totaux.ibs} />
      <Rangee libelle="Résultat net" valeurs={p.resultatNet} total={p.totaux.resultatNet} fort />
    </>
  );
}

type Run = ReturnType<typeof useActions>["run"];

function Enveloppe({ campaignId, p, modifiable, run, busy }: { campaignId: string; p: PrevisionSociete; modifiable: boolean; run: Run; busy: boolean }) {
  const [cellule, setCellule] = React.useState<{ cle: CleImpot; mois: number } | null>(null);
  const [montant, setMontant] = React.useState("");
  const [motif, setMotif] = React.useState("");
  const envoyer = (valeur: string | null) => {
    if (!cellule) return;
    void run(ajusterImpotCampagne, { campaignId, companyId: p.companyId, cle: cellule.cle, mois: String(cellule.mois), montant: valeur, motif })
      .then((r) => { if (r.ok) { setCellule(null); setMontant(""); setMotif(""); } });
  };
  return (
    <>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead><tr><th className={th}>Ligne</th>{COLONNES.map((c) => <th key={c} className={cn(th, num)}>{c}</th>)}</tr></thead>
          <tbody>
            {CLES_IMPOTS.map((cle) => (
              <tr key={cle}>
                <td className={td}>{LIBELLE_IMPOT[cle]}</td>
                {p.impots[cle].map((c, i) => {
                  const hors = i === MOIS_EXERCICE_SUIVANT - 1 && cle !== "IBS";
                  if (hors) return <td key={i} className={td} />;
                  const texte = c.ajuste || c.calcule !== null ? m(c.retenu) : "—";
                  const titre = c.ajuste ? (c.calcule !== null ? `calcul ${m(c.calcule)} · écart ${m(Math.round((c.retenu - c.calcule) * 100) / 100)}` : "saisie directe") : undefined;
                  return (
                    <td key={i} className={cn(td, num, c.ajuste && "text-primary")} title={titre}>
                      {modifiable && p.companyId ? (
                        <button type="button" className="hover:underline" onClick={() => { setCellule({ cle, mois: i + 1 }); setMontant(c.ajuste ? String(c.retenu) : ""); }}>{texte}</button>
                      ) : texte}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cellule && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <span className="text-sm">{LIBELLE_IMPOT[cellule.cle]} — {COLONNES[cellule.mois - 1]}</span>
          <input className={cn(champ, "w-36")} inputMode="decimal" autoFocus placeholder="Montant" aria-label="Montant" value={montant} onChange={(e) => setMontant(e.target.value)} />
          <input className={cn(champ, "min-w-40 flex-1")} placeholder="Motif" aria-label="Motif" value={motif} onChange={(e) => setMotif(e.target.value)} />
          <button type="button" className={btnPrimaire} disabled={busy || !montant.trim()} onClick={() => envoyer(montant)}>Ajuster</button>
          <button type="button" className={btn} disabled={busy} onClick={() => envoyer(null)}>Revenir au calcul</button>
          <button type="button" className={btn} onClick={() => setCellule(null)}>Fermer</button>
        </div>
      )}
    </>
  );
}

function Parametres({ campaignId, vue, run, busy }: { campaignId: string; vue: Vue; run: Run; busy: boolean }) {
  const p = vue.parametres;
  const [v, setV] = React.useState<Record<string, string>>(() => ({
    ...Object.fromEntries(NATURES_TVA.map((n) => [CHAMP_TVA[n], String(p.tvaParNature[n])])),
    ibsTauxDefaut: String(p.ibsTauxDefaut),
    calendrierIbs: calendrierEnTexte(p.calendrierIbs),
  }));
  const [ibs, setIbs] = React.useState<Record<string, string>>(() => Object.fromEntries(vue.societes.map((s) => [s.id, p.ibsParSociete[s.id] === undefined ? "" : String(p.ibsParSociete[s.id])])));
  const [confirme, setConfirme] = React.useState(p.confirmesParCabinet);
  const maj = (k: string, x: string) => setV((o) => ({ ...o, [k]: x }));
  return (
    <details className="surface">
      <summary className="cursor-pointer px-4 py-3 text-base font-semibold">Taux et calendrier</summary>
      <div className="space-y-3 border-t border-border px-4 py-3 text-sm">
        <div className="flex flex-wrap gap-3">
          {NATURES_TVA.map((n) => (
            <label key={n} className="flex items-center gap-1.5">TVA {LIBELLE_NATURE_TVA[n].toLowerCase()}
              <select className={champ} value={v[CHAMP_TVA[n]]} onChange={(e) => maj(CHAMP_TVA[n], e.target.value)}>
                {TAUX_TVA_PCT.map((t) => <option key={t} value={String(t)}>{t} %</option>)}
              </select>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1.5">IBS par défaut (%)<input className={cn(champ, "w-20")} inputMode="decimal" value={v.ibsTauxDefaut} onChange={(e) => maj("ibsTauxDefaut", e.target.value)} /></label>
          {vue.societes.map((s) => (
            <label key={s.id} className="flex items-center gap-1.5">IBS {s.label} (%)<input className={cn(champ, "w-20")} inputMode="decimal" placeholder={String(p.ibsTauxDefaut)} value={ibs[s.id] ?? ""} onChange={(e) => setIbs((o) => ({ ...o, [s.id]: e.target.value }))} /></label>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1.5">Calendrier IBS (mois:%, + = N+1)<input className={cn(champ, "w-52")} value={v.calendrierIbs} onChange={(e) => maj("calendrierIbs", e.target.value)} /></label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={confirme} onChange={(e) => setConfirme(e.target.checked)} /> Confirmés par le cabinet</label>
        </div>
        <button type="button" className={btnPrimaire} disabled={busy}
          onClick={() => void run(reglerParametresImpotsCampagne, {
            ...v, campaignId, confirmesParCabinet: confirme ? "true" : "false",
            ibsSociete: vue.societes.map((s) => s.id), ibsTaux: vue.societes.map((s) => ibs[s.id] ?? ""),
          })}>Enregistrer les taux</button>
        {vue.depenses.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr><th className={th}>Dépense (pôle)</th><th className={th}>Nature</th><th className={cn(th, num)}>Montant TTC</th><th className={th}>TVA contenue</th></tr></thead>
              <tbody>
                {vue.depenses.map((d) => (
                  <tr key={d.id}>
                    <td className={cn(td, "whitespace-normal")}>{d.label} <span className="text-xs text-muted-foreground">· {d.pole}</span></td>
                    <td className={td}>{LIBELLE_NATURE_TVA[d.nature]}</td>
                    <td className={cn(td, num)}>{m(d.montant)}</td>
                    <td className={td}>
                      <select className={champ} aria-label={`TVA de ${d.label}`} disabled={busy} value={d.tvaPct === null ? "" : String(d.tvaPct)}
                        onChange={(e) => void run(reglerTvaLigneDepense, { lineId: d.id, tvaPct: e.target.value })}>
                        <option value="">{p.tvaParNature[d.nature]} % (défaut)</option>
                        {TAUX_TVA_PCT.map((t) => <option key={t} value={String(t)}>{t} %</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}
