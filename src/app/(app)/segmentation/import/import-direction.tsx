"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { apercuImportClasseurDirection, importerClasseurDirection } from "@/lib/actions/segmentation-actions";
import { actionFailureMessage } from "@/lib/action-outcome";

type Apercu = Extract<Awaited<ReturnType<typeof apercuImportClasseurDirection>>, { ok: true }>;
type Bilan = Extract<Awaited<ReturnType<typeof importerClasseurDirection>>, { ok: true }>;

const LETTRES = ["H", "A", "B", "C", "D", "NA"] as const;
const champ = "rounded-lg border border-border bg-background px-2.5 py-2 text-sm sm:py-1.5";

/**
 * IMPORTER LE FICHIER DE SEGMENTATION, EN UNE FOIS (Direction, 08/10) — un fichier, une BU, un aperçu, « Importer ».
 * Le fichier est lu sur le serveur ; l'aperçu n'écrit rien. Les explications vivent derrière les ⓘ.
 */
export function ImportDirection({ bus, buInitiale, peutForcer }: { bus: { id: string; nom: string }[]; buInitiale: string | null; peutForcer: boolean }) {
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [bu, setBu] = React.useState<string>(buInitiale ?? "");
  const [apercu, setApercu] = React.useState<Apercu | null>(null);
  const [bilan, setBilan] = React.useState<Bilan | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [envoi, setEnvoi] = React.useState<"lecture" | "import" | null>(null);

  const fd = (f: File, buId: string) => { const x = new FormData(); x.set("fichier", f); if (buId) x.set("businessUnitId", buId); return x; };

  async function analyser(f: File | null, buId: string) {
    setApercu(null); setBilan(null); setErreur(null);
    if (!f) return;
    setEnvoi("lecture");
    try {
      const r = await apercuImportClasseurDirection(fd(f, buId));
      if (!r.ok) { setErreur(r.error); return; }
      setApercu(r);
      setBu(r.businessUnit.id);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(null);
    }
  }
  async function importer() {
    if (!fichier || !apercu) return;
    setEnvoi("import"); setErreur(null);
    try {
      const r = await importerClasseurDirection(fd(fichier, apercu.businessUnit.id));
      if (!r.ok) { setErreur(r.error); return; }
      setBilan(r); setApercu(null);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(null);
    }
  }

  const bloqueForcer = !!apercu && !peutForcer && (apercu.ecarts.length > 0 || apercu.decisionsALever > 0);

  return (
    <div className="space-y-4">
      <div className="surface flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:flex-wrap sm:items-center sm:p-4">
        <input
          type="file" accept=".xlsx,.xls,.xlsm" aria-label="Fichier de segmentation" className={cn(champ, "w-full sm:w-80")}
          onChange={(e) => { const f = e.target.files?.[0] ?? null; setFichier(f); void analyser(f, bu); }}
        />
        <select value={bu} aria-label="Business Unit" className={champ} disabled={!!envoi} onChange={(e) => { setBu(e.target.value); void analyser(fichier, e.target.value); }}>
          <option value="">BU reconnue dans le fichier</option>
          {bus.map((b) => <option key={b.id} value={b.id}>BU {b.nom}</option>)}
        </select>
        {envoi === "lecture" && <span className="text-sm text-muted-foreground">Lecture…</span>}
        {apercu && !apercu.dejaImporte && (
          <Button type="button" disabled={!!envoi || bloqueForcer} onClick={importer}>{envoi === "import" ? "Import…" : "Importer"}</Button>
        )}
      </div>

      {erreur && <p className="text-sm text-destructive" role="alert">{erreur}</p>}

      {bilan && (
        <div className="surface space-y-2 rounded-xl p-4 text-sm [overflow-wrap:anywhere]">
          {bilan.rien ? <p>Ce fichier a déjà été importé : rien n&apos;a changé.</p> : (
            <p>
              Import terminé : {bilan.crees} praticien(s) créé(s) dans l&apos;annuaire {bilan.annuaire}, {bilan.completes} complété(s), {bilan.fiches} fiche(s),{" "}
              {bilan.observations} réponse(s), {bilan.lettresGardees} lettre(s) du fichier gardée(s)
              {bilan.etablissementsCrees ? `, ${bilan.etablissementsCrees} établissement(s) créé(s)` : ""}
              {bilan.specialitesCreees ? `, ${bilan.specialitesCreees} spécialité(s) créée(s)` : ""}
              {bilan.reglesVersion ? `, règles v${bilan.reglesVersion} publiées` : ""}.
            </p>
          )}
          <Link href={`/segmentation?s=${bilan.strategieId}`} className="inline-flex h-9 items-center rounded-[var(--radius)] bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90">Voir la synthèse</Link>
        </div>
      )}

      {apercu && <VueApercu a={apercu} bloqueForcer={bloqueForcer} />}
    </div>
  );
}

function VueApercu({ a, bloqueForcer }: { a: Apercu; bloqueForcer: boolean }) {
  const importables = a.praticiens - a.ambigus.length - a.doublons.length;
  return (
    <div className="space-y-3 text-sm [overflow-wrap:anywhere]">
      {a.dejaImporte && <p className="rounded-xl border border-border bg-muted/40 p-3">Ce fichier a déjà été importé dans la BU {a.businessUnit.nom} : rien ne sera ajouté une seconde fois.</p>}
      <p className="text-muted-foreground">
        BU {a.businessUnit.nom} · {a.strategie ? a.strategie.nom : "stratégie créée à l'import"} · {a.produit ? a.produit.nom : "produit absent du catalogue"} · feuille « {a.feuille} » · annuaire {a.annuaire.nom}{a.annuaire.id ? "" : " (créé)"}
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tuile v={importables} l="praticiens" info={`${a.praticiens} ligne(s) lue(s)${a.ambigus.length ? `, ${a.ambigus.length} à trancher` : ""}${a.doublons.length ? `, ${a.doublons.length} doublon(s)` : ""}.`} />
        <Tuile v={a.nouveaux} l="nouveaux dans l'annuaire" info="Créés avec nom, prénom, grade, spécialité, établissement et wilaya reliés." />
        <Tuile v={a.existants} l="déjà dans l'annuaire" info="Retrouvés par nom et prénom (établissement pour départager). Seuls leurs champs vides sont complétés." />
        <Tuile v={a.secteurs.sans} l="sans secteur" ton={a.secteurs.sans ? "attention" : undefined} info={`${a.secteurs.avec} rangé(s) dans un secteur de la BU (par la région ou l'établissement).${a.secteurs.regionsSansSecteur.length ? ` Régions sans secteur du même nom : ${a.secteurs.regionsSansSecteur.join(", ")} — gardées comme zone.` : ""}`} />
        <Tuile v={a.etablissements.rattaches} l="établissements rattachés" info="Retrouvés dans l'annuaire des établissements (nom exact, ou sans ponctuation ni articles : « CHU d'Oran » = « CHU Oran »)." />
        <Tuile v={a.etablissements.crees.length} l="établissements créés" info={a.etablissements.crees.length ? a.etablissements.crees.map((e) => `${e.nom} (${e.wilaya ?? "wilaya à compléter"})`).join(", ") : "Aucun."} />
        <Tuile v={a.etablissements.aTrancher.length} l="à trancher" ton={a.etablissements.aTrancher.length ? "attention" : undefined} info={a.etablissements.aTrancher.length ? `${a.etablissements.aTrancher.join(", ")} — laissés « à rattacher ».` : "Aucun établissement ambigu."} />
        <Tuile v={a.specialites.rattachees + a.specialites.creees.length} l="spécialités" info={`${a.specialites.rattachees} du référentiel${a.specialites.creees.length ? ` ; créée(s) : ${a.specialites.creees.join(", ")}` : ""}${a.specialites.aTrancher.length ? ` ; à trancher : ${a.specialites.aTrancher.join(", ")}` : ""}.`} />
      </div>

      {a.produit && a.regles.action !== "aucune" && (
        <div className="surface rounded-xl p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {LETTRES.map((x) => <span key={x} className="rounded-full border border-border px-2.5 py-0.5 text-xs"><b className="font-semibold">{x}</b> {a.lettres[x]}</span>)}
            {a.lettres.NC > 0 && <span className="rounded-full border border-border px-2.5 py-0.5 text-xs"><b className="font-semibold">Non ciblé</b> {a.lettres.NC}</span>}
            <InfoBulle label="Lettres">Les lettres après l&apos;import : celles du fichier.</InfoBulle>
          </div>
          {a.ecarts.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer">{a.ecarts.length} lettre(s) posée(s) à la main dans le fichier, gardée(s) telle(s) quelle(s)</summary>
              <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                {a.ecarts.map((e) => <li key={e.ligne}>Ligne {e.ligne} · {e.nom}{e.zone ? ` (${e.zone})` : ""} : {e.fichier} — calcul {e.calcule === "NC" ? "non ciblé" : e.calcule}</li>)}
              </ul>
            </details>
          )}
          {a.decisionsALever > 0 && <p className="mt-1 text-xs text-muted-foreground">{a.decisionsALever} lettre(s) forcée(s) en vigueur contredite(s) par le fichier : levée(s), gardée(s) dans l&apos;historique.</p>}
          {bloqueForcer && <p className="mt-1 text-xs text-destructive">Garder ces lettres demande le droit de forcer le potentiel (Super Admin).</p>}
        </div>
      )}

      {a.changements && (
        <div className="surface rounded-xl p-3 text-sm sm:p-4">
          <p>Ce qui change : {a.changements.reponses} réponse(s), {a.changements.statuts} statut(s), {a.changements.lettres.length} lettre(s), {a.changements.nouveauxAuPanel} nouveau(x) au panel.</p>
          {a.changements.lettres.length > 0 && (
            <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-xs text-muted-foreground">
              {a.changements.lettres.slice(0, 100).map((c, i) => <li key={i}>{c.nom} : {c.avant} → {c.apres}</li>)}
            </ul>
          )}
        </div>
      )}

      <details className="surface rounded-xl p-3 sm:p-4" open={a.regles.action === "publier"}>
        <summary className="cursor-pointer font-medium">
          {a.regles.action === "publier" ? `Règles v${a.regles.version} publiées avec l'import` : a.regles.action === "garder" ? `Règles v${a.regles.version} gardées` : "Règles non publiées"}
        </summary>
        <ul className="mt-2 list-disc pl-5 text-xs">{a.regles.provenance.map((p, i) => <li key={i}>{p}</li>)}</ul>
        {a.regles.erreurs.length > 0 && <p className="mt-1 text-xs text-destructive">À compléter dans l&apos;onglet Règles : {a.regles.erreurs.join(" ")}</p>}
      </details>

      {(a.ambigus.length > 0 || a.doublons.length > 0 || a.anomalies.length > 0) && (
        <details className="surface rounded-xl p-3 text-xs sm:p-4">
          <summary className="cursor-pointer text-sm font-medium">À vérifier ({a.ambigus.length + a.doublons.length + a.anomalies.length})</summary>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted-foreground">
            {a.ambigus.map((x) => <li key={`a${x.ligne}`}>Ligne {x.ligne} · {x.nom} : {x.candidats} fiches du même nom — non importée.</li>)}
            {a.doublons.map((x) => <li key={`d${x.ligne}`}>Ligne {x.ligne} · {x.nom} : déjà ligne {x.ligneOrigine} — ignorée.</li>)}
            {a.anomalies.map((x, i) => <li key={`n${i}`}>{x}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function Tuile({ v, l, info, ton }: { v: number; l: string; info: string; ton?: "attention" }) {
  return (
    <div className="surface rounded-xl px-3 py-2.5">
      <div className="flex items-start justify-between gap-1">
        <span className={cn("text-xl font-semibold tabular-nums", ton === "attention" && v > 0 && "text-warning")}>{v}</span>
        <InfoBulle label={l}>{info}</InfoBulle>
      </div>
      <p className="text-xs text-muted-foreground">{l}</p>
    </div>
  );
}
