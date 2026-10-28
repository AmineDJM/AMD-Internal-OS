"use client";

import * as React from "react";
import { Loader2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn } from "@/lib/utils";
import { NATURE_LABELS } from "@/lib/kpi/briques";
import { phraseCalcul, type DefinitionKpi } from "@/lib/kpi/definition";
import {
  archiverKpi, catalogueKpi, importerKpi, modifierKpi, reglerAffectationKpi, retirerAffectationKpi,
} from "@/lib/actions/kpi-actions";
import { sansBloquer } from "@/lib/journal";

type Catalogue = Awaited<ReturnType<typeof catalogueKpi>>;
type Def = Catalogue["definitions"][number];
type Affectation = Catalogue["affectations"][number];

/**
 * GÉRER LES KPI — le catalogue (Super Admin : toutes les définitions et les modèles par rôle) ou les KPI de mon équipe
 * (manager). Modifier crée une VERSION ; retirer archive. Les poids se règlent par affectation.
 */
export function GestionKpi({ roles, personnes, onChange }: {
  roles?: { cle: string; libelle: string }[];
  personnes?: { userId: string; nom: string }[];
  onChange?: () => void;
}) {
  const [cat, setCat] = React.useState<Catalogue | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const charger = React.useCallback(async () => { setCat(await catalogueKpi().catch(sansBloquer("gestion-kpi.GestionKpi.catalogueKpi", null))); }, []);
  React.useEffect(() => { void charger(); }, [charger]);

  const apres = async (r: { ok: boolean; error?: string; message?: string } | null) => {
    setMsg(r ? { ok: r.ok, texte: r.ok ? r.message ?? "Enregistré." : r.error ?? "Échec." } : { ok: false, texte: "Échec." });
    if (r?.ok) { await charger(); onChange?.(); }
  };

  if (!cat) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</p>;
  if (!cat.ok) return <p className="text-sm text-destructive">{cat.error}</p>;
  const nomDe = (a: Affectation) => a.cible === "ROLE" ? `rôle : ${roles?.find((r) => r.cle === a.role)?.libelle ?? a.role}`
    : a.cible === "PERSONNE" ? personnes?.find((p) => p.userId === a.userId)?.nom ?? "une personne" : "mon équipe";

  return (
    <div className="space-y-3 text-sm">
      {cat.definitions.length === 0 && <p className="text-muted-foreground">Aucun KPI pour l&apos;instant.</p>}
      {cat.definitions.map((d) => (
        <CarteDef key={d.id} d={d} affectations={cat.affectations.filter((a) => a.famille === d.famille)} roles={roles} nomDe={nomDe} apres={apres} />
      ))}
      {msg && <p className={cn("text-xs", msg.ok ? "text-success" : "text-destructive")}>{msg.texte}</p>}
    </div>
  );
}

function CarteDef({ d, affectations, roles, nomDe, apres }: {
  d: Def; affectations: Affectation[]; roles?: { cle: string; libelle: string }[];
  nomDe: (a: Affectation) => string; apres: (r: { ok: boolean; error?: string; message?: string } | null) => Promise<void>;
}) {
  const [edition, setEdition] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [role, setRole] = React.useState(roles?.[0]?.cle ?? "");
  const [poidsRole, setPoidsRole] = React.useState("10");

  const action = async (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>, champs: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(champs)) fd.set(k, v);
    setBusy(true);
    const r = await fn(fd).catch(sansBloquer("gestion-kpi.action.fn", null));
    setBusy(false);
    await apres(r);
    return r;
  };

  return (
    <section className="surface min-w-0 rounded-xl">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <p className="font-semibold">{d.nom} <span className="font-normal text-muted-foreground">· {NATURE_LABELS[d.def.nature]} · v{d.version}</span></p>
          <p className="text-xs text-muted-foreground">{phraseCalcul(d.def)}{d.def.cible !== null ? ` · cible ${d.def.cible}` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {d.portee === "CATALOGUE" && <Badge tone="info">catalogue</Badge>}
          {d.modifiable && <Button size="sm" variant="outline" onClick={() => setEdition((v) => !v)}>Modifier</Button>}
          {d.modifiable && (
            <BoutonDecisif size="sm" variant="outline" type="button" disabled={busy} confirmation={`Retirer « ${d.nom} »`}
              onClick={() => void action(archiverKpi, { definitionId: d.id })}>
              Retirer
            </BoutonDecisif>
          )}
        </div>
      </div>
      {edition && <EditionDef d={d} onFin={() => setEdition(false)} apres={apres} />}
      {d.def.nature === "IMPORTE" && d.modifiable && <ImportDef d={d} apres={apres} />}
      <ul className="divide-y divide-border">
        {affectations.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
            <span className="min-w-0 flex-1 truncate">{nomDe(a)}</span>
            <PoidsAffectation a={a} busy={busy} onRegler={(poids) => void action(reglerAffectationKpi, { assignmentId: a.id, poids })} />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(retirerAffectationKpi, { assignmentId: a.id })}>Retirer</Button>
          </li>
        ))}
        {roles && roles.length > 0 && (
          <li className="flex flex-wrap items-center gap-2 px-4 py-2">
            <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Rôle" className="h-9 rounded-md border border-input bg-background px-2 text-sm">
              {roles.map((r) => <option key={r.cle} value={r.cle}>{r.libelle}</option>)}
            </select>
            <input value={poidsRole} onChange={(e) => setPoidsRole(e.target.value)} inputMode="numeric" aria-label="Poids" className="h-9 w-16 rounded-md border border-input bg-background px-2" />
            <Button size="sm" variant="outline" disabled={busy || !role} onClick={() => void action(reglerAffectationKpi, { famille: d.famille, cible: "ROLE", role, poids: poidsRole })}>
              Ajouter au modèle
            </Button>
          </li>
        )}
      </ul>
    </section>
  );
}

function PoidsAffectation({ a, busy, onRegler }: { a: Affectation; busy: boolean; onRegler: (poids: string) => void }) {
  const [poids, setPoids] = React.useState(String(a.poids));
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      poids
      <input value={poids} onChange={(e) => setPoids(e.target.value)} inputMode="numeric" aria-label="Poids" className="h-8 w-14 rounded-md border border-input bg-background px-2 text-sm text-foreground" />
      {poids !== String(a.poids) && <Button size="sm" variant="outline" disabled={busy} onClick={() => onRegler(poids)}>OK</Button>}
    </span>
  );
}

function EditionDef({ d, onFin, apres }: { d: Def; onFin: () => void; apres: (r: { ok: boolean; error?: string; message?: string } | null) => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const enregistrer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => { const v = String(f.get(k) ?? "").trim(); return v === "" ? null : Number(v.replace(",", ".")); };
    const grille = d.def.grille
      ? String(f.get("grille") ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [libelle, ...reste] = l.split("—"); return { libelle: (libelle ?? "").trim(), critere: reste.join("—").trim() }; })
      : null;
    const def: DefinitionKpi = {
      ...d.def, nom: String(f.get("nom") ?? d.def.nom), cible: num("cible"), seuilVert: num("seuilVert"), seuilOrange: num("seuilOrange"),
      periode: f.get("periode") === "TRIMESTRE" ? "TRIMESTRE" : "MOIS", grille,
    };
    const fd = new FormData();
    fd.set("definitionId", d.id);
    fd.set("definition", JSON.stringify(def));
    setBusy(true);
    const r = await modifierKpi(fd).catch(sansBloquer("gestion-kpi.enregistrer.modifierKpi", null));
    setBusy(false);
    await apres(r);
    if (r?.ok) onFin();
  };
  const champ = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <form onSubmit={(e) => void enregistrer(e)} className="grid grid-cols-1 gap-2 border-b border-border p-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <label className="text-xs text-muted-foreground sm:pt-2">Nom</label>
      <input name="nom" defaultValue={d.def.nom} className={champ} />
      <label className="text-xs text-muted-foreground sm:pt-2">Cible <InfoBulle align="left">Sans seuils, vert à la cible et orange à 80 % de la cible (à 125 % pour un délai).</InfoBulle></label>
      <div className="flex flex-wrap gap-2">
        <input name="cible" defaultValue={d.def.cible ?? ""} placeholder="cible" aria-label="Cible" className={cn(champ, "w-24")} />
        <input name="seuilVert" defaultValue={d.def.seuilVert ?? ""} placeholder="vert" aria-label="Seuil vert" className={cn(champ, "w-20")} />
        <input name="seuilOrange" defaultValue={d.def.seuilOrange ?? ""} placeholder="orange" aria-label="Seuil orange" className={cn(champ, "w-20")} />
        <select name="periode" defaultValue={d.def.periode} aria-label="Période de la cible" className={champ}>
          <option value="MOIS">par mois</option>
          <option value="TRIMESTRE">par trimestre</option>
        </select>
      </div>
      {d.def.grille && (
        <>
          <label className="text-xs text-muted-foreground sm:pt-2">Grille</label>
          <textarea name="grille" rows={d.def.grille.length + 1} defaultValue={d.def.grille.map((n) => `${n.libelle} — ${n.critere}`).join("\n")} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" aria-label="Grille (un niveau par ligne : libellé — critère)" />
        </>
      )}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" size="sm" variant="ghost" onClick={onFin}>Annuler</Button>
        <Button type="submit" size="sm" disabled={busy}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Enregistrer une version</Button>
      </div>
    </form>
  );
}

function ImportDef({ d, apres }: { d: Def; apres: (r: { ok: boolean; error?: string; message?: string } | null) => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const importer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("definitionId", d.id);
    setBusy(true);
    const r = await importerKpi(fd).catch(sansBloquer("gestion-kpi.importer.importerKpi", null));
    setBusy(false);
    await apres(r);
  };
  const champ = "h-9 w-28 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <form onSubmit={(e) => void importer(e)} className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
      <input name="fichier" type="file" accept=".xlsx,.xls,.csv" required aria-label="Fichier" className="text-xs" />
      <input name="colonnePersonne" defaultValue="personne" aria-label="Colonne personne" className={champ} />
      <input name="colonnePeriode" defaultValue="periode" aria-label="Colonne période" className={champ} />
      <input name="colonneValeur" defaultValue="valeur" aria-label="Colonne valeur" className={champ} />
      <InfoBulle align="left">Une ligne par personne et par période. Personne : e-mail ou nom complet. Période : 2026-10, 10/2026 ou 2026-T4.</InfoBulle>
      <Button type="submit" size="sm" variant="outline" disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Importer</Button>
    </form>
  );
}
