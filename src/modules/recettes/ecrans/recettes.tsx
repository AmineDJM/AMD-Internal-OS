"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import type { BadgeTone } from "@/lib/labels";
import { jours, LIBELLE_STATUT_RECETTE, LIBELLE_STATUT_VERSION, pourcent, type ContenuRecette, type StatutRecette } from "@/modules/recettes/partage";
import { corrigerRecetteAction, designerResponsableAction, rejeterRecetteAction, relireLesCircuitsAction, retirerRecetteAction, validerRecetteAction } from "../actions";

/**
 * L'ÉCRAN « RECETTES » (J10, décision 0028) — par processus : chaque recette, son état (proposée / validée / retirée),
 * qui l'a validée et quand, combien de fois l'assistant s'en est servi et la part de plans acceptés sans retouche. Le
 * responsable du processus y valide, corrige (une version de plus), rejette ou retire ; la Direction y désigne les
 * responsables. Les données arrivent déjà filtrées par les droits (serveur).
 */

interface Version {
  id: string; numero: number; statut: string; origine: string; occurrences: number;
  auteur: string | null; decidePar: string | null; decideLe: string | null; motif: string | null; contenu: ContenuRecette | null;
}
export interface RecetteEcran {
  id: string; circuit: string; processus: string; libelleProcessus: string; titre: string; statut: StatutRecette;
  validee: Version | null; proposition: Version | null; versions: Version[]; responsable: boolean;
  stats: { utilisations: number; lances: number; sansRetouche: number; retouches: number; taux: number | null; dernieresRetouches: string[][] };
}
export interface DesignationEcran { processus: string; libelle: string; role: string | null; libelleRole: string | null; personne: string | null; seuil: number | null; moi: boolean }

const TON: Record<StatutRecette, BadgeTone> = { PROPOSEE: "warning", VALIDEE: "success", REJETEE: "neutral", RETIREE: "neutral" };
const date = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");

function Contenu({ c, roles }: { c: ContenuRecette; roles: Record<string, string> }) {
  const r = (x: string) => roles[x] ?? x;
  return (
    <div className="space-y-3 text-sm">
      <p>{c.resume}</p>
      <ol className="space-y-1">
        {c.etapes.map((e, i) => (
          <li key={e.cle} className="rounded-md border px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{i + 1}. {e.libelle}</span>
              {e.validateurs.length > 0 && <span className="text-muted-foreground">— {e.validateurs.map(r).join(" ou ")}</span>}
              <span className="text-xs text-muted-foreground">médiane {jours(e.dureeMedianeJours)} · {pourcent(e.frequence)} des dossiers</span>
            </div>
            {e.condition && <p className="text-xs text-muted-foreground">{e.condition}</p>}
            {e.note && <p className="text-xs">Note : {e.note}</p>}
          </li>
        ))}
      </ol>
      {c.pieces.length > 0 && <p><span className="font-medium">Pièces habituelles :</span> {c.pieces.map((p) => `${p.nature.toLowerCase().replace(/_/g, " ")} (${pourcent(p.frequence)})`).join(", ")}</p>}
      {c.seuils.length > 0 && <p><span className="font-medium">Seuils :</span> {c.seuils.map((s) => s.texte).join(" ; ")}</p>}
      <p><span className="font-medium">Durée :</span> médiane {jours(c.duree.medianeJours)}{c.duree.p90Jours !== null ? `, 9 sur 10 en moins de ${jours(c.duree.p90Jours)}` : ""} — tiré de {c.observation.occurrences} dossiers réels ({date(c.observation.du)} → {date(c.observation.au)})</p>
      {c.pieges.length > 0 && (
        <div>
          <p className="font-medium">Pièges fréquents</p>
          <ul className="list-disc pl-5">{c.pieges.map((p) => <li key={p.texte}>{p.texte}</li>)}</ul>
        </div>
      )}
      {c.note && <p><span className="font-medium">Note du responsable :</span> {c.note}</p>}
    </div>
  );
}

function Correction({ v, onFini }: { v: Version; onFini: () => void }) {
  const c = v.contenu!;
  const [titre, setTitre] = React.useState(c.titre);
  const [resume, setResume] = React.useState(c.resume);
  const [etapes, setEtapes] = React.useState(c.etapes.map((e) => ({ cle: e.cle, libelle: e.libelle, note: e.note ?? "", garder: true })));
  const [pieces, setPieces] = React.useState(c.pieces.map((p) => p.nature).join(", "));
  const [pieges, setPieges] = React.useState(c.pieges.map((p) => p.texte).join("\n"));
  const [note, setNote] = React.useState(c.note ?? "");
  const { busy, err, run } = useAction();
  const enregistrer = () => run(() => corrigerRecetteAction(v.id, JSON.stringify({
    titre, resume, note,
    etapes: etapes.filter((e) => e.garder).map(({ cle, libelle, note: n }) => ({ cle, libelle, note: n })),
    pieces: pieces.split(",").map((x) => x.trim()).filter(Boolean),
    pieges: pieges.split("\n").map((x) => x.trim()).filter(Boolean),
  })), onFini, { succes: "Correction enregistrée et validée (nouvelle version)." });
  return (
    <div className="space-y-2 rounded-md border p-3">
      <Label>Titre</Label><Input value={titre} onChange={(e) => setTitre(e.target.value)} />
      <Label>Résumé</Label><Textarea rows={3} value={resume} onChange={(e) => setResume(e.target.value)} />
      <p className="text-sm font-medium">Étapes (libellé, note — décocher pour retirer)</p>
      {etapes.map((e, i) => (
        <div key={e.cle} className="flex flex-wrap items-center gap-2">
          <input type="checkbox" aria-label={`Garder « ${e.libelle} »`} checked={e.garder} onChange={(x) => setEtapes(etapes.map((y, j) => (j === i ? { ...y, garder: x.target.checked } : y)))} />
          <Input className="min-w-0 flex-1" value={e.libelle} onChange={(x) => setEtapes(etapes.map((y, j) => (j === i ? { ...y, libelle: x.target.value } : y)))} />
          <Input className="min-w-0 flex-1" placeholder="Note" value={e.note} onChange={(x) => setEtapes(etapes.map((y, j) => (j === i ? { ...y, note: x.target.value } : y)))} />
        </div>
      ))}
      <Label>Pièces habituelles (séparées par des virgules)</Label><Input value={pieces} onChange={(e) => setPieces(e.target.value)} />
      <Label>Pièges (un par ligne)</Label><Textarea rows={3} value={pieges} onChange={(e) => setPieges(e.target.value)} />
      <Label>Note du responsable</Label><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={enregistrer}>{busy ? "Enregistrement…" : "Enregistrer et valider"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onFini}>Annuler</Button>
      </div>
      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}

function Gestes({ r }: { r: RecetteEcran }) {
  const { busy, err, run } = useAction();
  const [motif, setMotif] = React.useState("");
  const [corriger, setCorriger] = React.useState(false);
  const enCours = r.proposition ?? r.validee;
  if (!r.responsable || !enCours?.contenu) return null;
  if (corriger) return <Correction v={enCours} onFini={() => setCorriger(false)} />;
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {r.proposition && (
          <Button type="button" size="sm" disabled={busy} onClick={() => run(() => validerRecetteAction(r.proposition!.id), undefined, { confirmer: `Valider la version ${r.proposition!.numero} ? L'assistant s'en servira pour proposer des plans.`, succes: "Recette validée." })}>
            Valider la version {r.proposition.numero}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setCorriger(true)}>Corriger</Button>
        <Input className="min-w-0 flex-1" placeholder="Motif (rejet ou retrait)" value={motif} onChange={(e) => setMotif(e.target.value)} />
        {r.proposition && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => run(() => rejeterRecetteAction(r.proposition!.id, motif), () => setMotif(""), { succes: "Proposition rejetée." })}>Rejeter</Button>
        )}
        {r.validee && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => run(() => retirerRecetteAction(r.validee!.id, motif), () => setMotif(""), { confirmer: "Retirer cette recette ? L'assistant cessera de la proposer.", succes: "Recette retirée." })}>Retirer</Button>
        )}
      </div>
      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}

function CarteRecette({ r, roles }: { r: RecetteEcran; roles: Record<string, string> }) {
  const montree = r.validee?.contenu ?? r.proposition?.contenu ?? null;
  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{r.titre}</CardTitle>
          <Badge tone={TON[r.statut]}>{LIBELLE_STATUT_RECETTE[r.statut]}</Badge>
          {r.validee && r.proposition && <Badge tone="warning">nouvelle version proposée</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          {r.validee ? `Version ${r.validee.numero} validée par ${r.validee.decidePar ?? "—"} le ${date(r.validee.decideLe)}` : "Pas encore validée — l'assistant ne s'en sert pas"}
          {" · "}utilisée {r.stats.utilisations} fois
          {r.stats.taux !== null ? ` · ${pourcent(r.stats.taux)} des plans acceptés sans retouche (${r.stats.sansRetouche}/${r.stats.sansRetouche + r.stats.retouches})` : ""}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {montree ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">{r.validee ? "La recette en usage" : "La proposition"}</summary>
            <div className="pt-2"><Contenu c={montree} roles={roles} /></div>
          </details>
        ) : <p className="text-sm text-muted-foreground">Contenu illisible.</p>}
        {r.validee && r.proposition?.contenu && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">La nouvelle proposition (version {r.proposition.numero})</summary>
            <div className="pt-2"><Contenu c={r.proposition.contenu} roles={roles} /></div>
          </details>
        )}
        {r.stats.dernieresRetouches.length > 0 && (
          <div className="text-xs text-muted-foreground">
            <p className="font-medium">Écarts des derniers plans retouchés</p>
            <ul className="list-disc pl-5">{r.stats.dernieresRetouches.map((e, i) => <li key={i}>{e.join(" ; ") || "plan reformulé"}</li>)}</ul>
          </div>
        )}
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Versions ({r.versions.length})</summary>
          <ul className="space-y-1 pt-2 text-xs">
            {r.versions.map((v) => (
              <li key={v.id}>
                v{v.numero} — {LIBELLE_STATUT_VERSION[v.statut as keyof typeof LIBELLE_STATUT_VERSION] ?? v.statut}
                {v.origine === "CORRECTION" ? ` · corrigée par ${v.auteur ?? "—"}` : ` · tirée de ${v.occurrences} dossiers`}
                {v.decidePar ? ` · ${v.decidePar}, ${date(v.decideLe)}` : ""}
                {v.motif ? ` · « ${v.motif} »` : ""}
              </li>
            ))}
          </ul>
        </details>
        <Gestes r={r} />
      </CardContent>
    </Card>
  );
}

export function ListeRecettes({ recettes, roles }: { recettes: RecetteEcran[]; roles: Record<string, string> }) {
  if (!recettes.length) {
    return <p className="text-sm text-muted-foreground">Aucune recette pour l'instant : une recette n'est proposée qu'à partir d'un nombre minimal de dossiers réels clos et acceptés.</p>;
  }
  const parProcessus = new Map<string, RecetteEcran[]>();
  for (const r of recettes) parProcessus.set(r.libelleProcessus, [...(parProcessus.get(r.libelleProcessus) ?? []), r]);
  return (
    <div className="space-y-6">
      {[...parProcessus.entries()].map(([p, rs]) => (
        <section key={p} className="space-y-3">
          <h2 className="text-lg font-semibold">{p} <span className="text-sm font-normal text-muted-foreground">({rs.length})</span></h2>
          {rs.map((r) => <CarteRecette key={r.id} r={r} roles={roles} />)}
        </section>
      ))}
    </div>
  );
}

function LigneDesignation({ d, roles }: { d: DesignationEcran; roles: Record<string, string> }) {
  const [role, setRole] = React.useState(d.role ?? "");
  const [seuil, setSeuil] = React.useState(d.seuil ? String(d.seuil) : "");
  const { busy, err, run } = useAction();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b py-2 last:border-0">
      <span className="w-40 font-medium">{d.libelle}</span>
      <Select aria-label={`Responsable ${d.libelle}`} value={role} onChange={(e) => setRole(e.target.value)} className="min-w-0 flex-1">
        <option value="">— aucun —</option>
        {Object.entries(roles).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </Select>
      <Input aria-label={`Seuil ${d.libelle}`} className="w-28" inputMode="numeric" placeholder="seuil (5)" value={seuil} onChange={(e) => setSeuil(e.target.value.replace(/\D/g, ""))} />
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => run(() => designerResponsableAction(d.processus, role || null, seuil ? Number(seuil) : null), undefined, { succes: "Responsable enregistré." })}>Enregistrer</Button>
      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}

export function Designations({ designations, roles, peutDesigner }: { designations: DesignationEcran[]; roles: Record<string, string>; peutDesigner: boolean }) {
  const { busy, err, run } = useAction();
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base">Responsables des processus</CardTitle>
        <p className="text-xs text-muted-foreground">Le responsable lit, corrige, valide ou rejette les recettes de son processus. Seuil : le nombre minimal de dossiers réels pour qu'une recette soit proposée.</p>
      </CardHeader>
      <CardContent className="text-sm">
        {peutDesigner ? (
          <>
            {designations.map((d) => <LigneDesignation key={d.processus} d={d} roles={roles} />)}
            <div className="flex flex-wrap items-center gap-2 pt-3">
              <Button type="button" size="sm" disabled={busy} onClick={() => run(relireLesCircuitsAction, undefined, { succes: "Circuits relus." })}>{busy ? "Lecture des circuits…" : "Relire les circuits maintenant"}</Button>
              <Retour ton="erreur">{err}</Retour>
            </div>
          </>
        ) : (
          <ul className="space-y-1">
            {designations.map((d) => (
              <li key={d.processus}>{d.libelle} : {d.libelleRole ?? d.personne ?? "non désigné"}{d.moi ? " (vous)" : ""}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
