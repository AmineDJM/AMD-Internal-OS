"use client";

import * as React from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Plus } from "lucide-react";
import { createBusinessUnit, updateBusinessUnit } from "@/lib/actions/sales-planning-actions";
import { ChoixSpecialites, type ChoixSpecialitesValeur } from "./choix-specialites";
import { CHANNELS, CHANNEL_LABELS, buSetupProgress, buSetupSteps, channelLabel, type BuStepKey } from "@/lib/sfe-setup";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { estBuHospitaliere, kamsSansTerritoire } from "@/lib/sfe/territoire-kam";
import type { TerritoireRow } from "./territoire-kam";
import type { EtabOpt } from "./choix-etablissements";
import { Sheet } from "@/components/ui/sheet";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { cn } from "@/lib/utils";
import { EtapeIdentite, EtapeProduits, EtapeKams, EtapeSecteurs, inputCls, btnCls, type Run } from "./bu-etapes";
import { ETAPES, type Etape } from "./etapes";

/**
 * LE MONTAGE D'UNE BU, PAR ÉTAPES (Direction, 07/10 : « découpées en étapes au lieu d'un écran de 14 blocs »).
 *
 * Une BU par carte, dépliable. À l'intérieur, quatre étapes dans l'ordre du montage réel : la BU et son superviseur →
 * spécialités et produits → KAM → secteurs. Chaque carte fermée dit CE QUI MANQUE (« Désigner le superviseur ») plutôt
 * qu'un compteur muet ; chaque étape porte un point quand il lui manque quelque chose.
 *
 * Ce module n'importe que `sfe-setup` (pur) et les actions serveur : la frontière client tient.
 */

export interface Opt { id: string; name: string }
export interface BuRow {
  id: string; name: string; code: string | null; color: string | null;
  companyId: string | null; headId: string | null; supervisorId: string | null;
  channel: string; isActive: boolean;
  /** LE SOUS-DÉPARTEMENT de la gamme, quand son budget a été ouvert. */
  departmentId: string | null;
  /** LES SPÉCIALITÉS QU'ELLE VISE (§118.183) — la principale d'abord quand elle existe. */
  specialites: { id: string; name: string; principale: boolean }[];
}
export interface KamRow {
  repId: string; name: string; role: string; businessUnitId: string | null; region: string | null;
  capDaysPerMonth: number | null; capVisitsPerDay: number | null; capFieldPct: number | null;
  fteBudget: number; seniority: string | null; isActive: boolean; hasProfile: boolean;
}
export type { EtabOpt } from "./choix-etablissements";
export type { TerritoireRow } from "./territoire-kam";

/** Ce que l'organigramme dit d'une BU (`lectureBuParOrganigramme`). */
export interface LectureOrg { propose: string | null; horsLigne: string[] }

export interface ProductRow {
  id: string; name: string; code: string | null; channel: string;
  businessUnitId: string | null; managerId: string | null; isActive: boolean; dossier: string | null;
}

type Action = (fd: FormData) => Promise<{ ok: boolean; error?: string }>;

/** Une personne désignée référente Direction Marketing d'une gamme. */
export interface ReferentRow { id: string; userId: string; name: string; porteLeRole: boolean; businessUnitId: string }

const ETAPE_LABELS: Record<Etape, string> = { identite: "BU & superviseur", produits: "Spécialités & produits", kams: "KAM", secteurs: "Secteurs" };
/** Les étapes du montage (`sfe-setup`) que chaque écran règle — un point s'y allume quand l'une manque. */
const CLES_ETAPE: Record<Etape, BuStepKey[]> = {
  identite: ["SUPERVISEUR", "CANAL", "REFERENTS"], produits: ["SPECIALITES", "PRODUITS"], kams: ["KAM"], secteurs: ["TERRITOIRES"],
};

export function BusinessUnitsManager({
  businessUnits, companies, supervisors, users, kams, products, dossiers, config,
  territoires, etablissements, referents, referentsEligibles, specialitesReferentiel, etapeInitiale, buInitiale,
  departements = [], organigramme = {},
}: {
  businessUnits: BuRow[];
  companies: Opt[];
  supervisors: Opt[];
  users: Opt[];
  kams: KamRow[];
  products: ProductRow[];
  dossiers: { id: string; label: string }[];
  config: { daysPerMonth: number; visitsPerDay: number; fieldPct: number };
  /** Les TERRITOIRES PROPRES des KAM, de TOUTES les BU, groupés à l'affichage. */
  territoires: (TerritoireRow & { businessUnitId: string })[];
  /** Le référentiel des établissements, à cocher. Vide → l'annuaire est vide, et on le DIT. */
  etablissements: EtabOpt[];
  /** Les référents de TOUTES les gammes, groupés à l'affichage. */
  referents: ReferentRow[];
  /** Les personnes qui PORTENT le rôle Direction Marketing : les seules désignables. */
  referentsEligibles: Opt[];
  /** Le référentiel des spécialités, à cocher (§118.183). */
  specialitesReferentiel: Opt[];
  /** L'étape ouverte d'arrivée (onglet « Secteurs » du module Business Units, « Affecter » d'un secteur vacant). */
  etapeInitiale?: Etape | null;
  /** La BU dépliée d'arrivée ; sans elle et avec une étape, toutes les BU s'ouvrent sur cette étape. */
  buInitiale?: string | null;
  /** Les départements de l'organigramme (la seule source) — la BU s'y rattache à l'étape d'identité. */
  departements?: Opt[];
  /** Ce que l'organigramme dit de chaque BU : superviseur proposé, KAM hors de la ligne hiérarchique. */
  organigramme?: Record<string, LectureOrg>;
}) {
  // LES GESTES ATTENDENT LES NOUVELLES DONNÉES (§118.172) : rouvert avant le rafraîchissement, un panneau remontrerait
  // l'état d'AVANT, et l'enregistrer le RÉÉCRIVAIT par-dessus ce qu'on venait de changer.
  const { enCours: rafraichit, rafraichir } = useRafraichir();
  // Les gestes des étapes (icônes, sélecteurs en ligne) n'ont pas de place où parler : un refus part en avis flottant.
  const retours = useRetours();
  const [enAction, setBusy] = React.useState(false);
  const busy = enAction || rafraichit;
  const [creating, setCreating] = React.useState(false);
  const [open, setOpen] = React.useState<Record<string, boolean>>(() =>
    buInitiale ? { [buInitiale]: true } : etapeInitiale ? Object.fromEntries(businessUnits.map((b) => [b.id, true])) : {});
  const [choixCreation, setChoixCreation] = React.useState<ChoixSpecialitesValeur>({ ids: [], principaleId: null });

  const run = React.useCallback<Run>(async (action: Action, fd: FormData, refresh = true) => {
    setBusy(true);
    try {
      const r = await action(fd);
      if (!r.ok) { retours.erreur(r.error ?? "La Business Unit n'a pas été modifiée."); return false; }
      if (refresh) rafraichir();
      return true;
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
      return false;
    } finally {
      setBusy(false);
    }
  }, [rafraichir, retours]);

  const kamsOf = (buId: string | null) => kams.filter((k) => k.businessUnitId === buId);
  const territoiresOf = (buId: string) => territoires.filter((x) => x.businessUnitId === buId);
  const referentsOf = (buId: string) => referents.filter((x) => x.businessUnitId === buId);
  const productsOf = (buId: string | null) => products.filter((p) => p.businessUnitId === buId);
  const orphelinsKam = kamsOf(null);
  const orphelinsProd = productsOf(null);

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Button onClick={() => { setChoixCreation({ ids: [], principaleId: null }); setCreating(true); }} disabled={busy}>
          <Plus className="h-4 w-4" /> Créer une BU
        </Button>
      </div>

      <Sheet open={creating} onClose={() => setCreating(false)} title="Créer une Business Unit" width="md">
        <form className="space-y-3" action={async (fd) => { if (await run(createBusinessUnit, fd)) setCreating(false); }}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input name="name" required placeholder="Nom de la BU (ex. Neurologie)" className={`${inputCls} w-full sm:col-span-2`} />
            <input name="code" placeholder="Code (facultatif)" className={`${inputCls} w-full`} />
            <select name="supervisorId" className={`${inputCls} w-full`} defaultValue="">
              <option value="">— Superviseur —</option>
              {supervisors.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <select name="channel" className={`${inputCls} w-full`} defaultValue="BOTH">
              {CHANNELS.map((c) => <option key={c} value={c}>Terrain : {CHANNEL_LABELS[c]}</option>)}
            </select>
            <select name="departmentId" className={`${inputCls} w-full sm:col-span-2`} defaultValue="" aria-label="Département de la BU">
              <option value="">— Département (organigramme) —</option>
              {departements.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select name="companyId" className={`${inputCls} w-full`} defaultValue="">
              <option value="">— Société —</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select name="headId" className={`${inputCls} w-full`} defaultValue="">
              <option value="">— Chef de BU (facultatif) —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <input name="color" type="color" defaultValue="#2563eb" className="h-10 w-16 rounded-lg border border-input bg-background sm:h-9" title="Couleur" aria-label="Couleur" />
          </div>
          {/* LES SPÉCIALITÉS VISÉES, dès la création (§118.183) — elles se règlent aussi plus tard, à l'étape 2. */}
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Spécialités visées</legend>
            <ChoixSpecialites referentiel={specialitesReferentiel} valeur={choixCreation} onChange={setChoixCreation} disabled={busy} />
            {choixCreation.ids.map((id) => <input key={id} type="hidden" name="specialtyIds" value={id} />)}
            {choixCreation.principaleId && <input type="hidden" name="principaleId" value={choixCreation.principaleId} />}
          </fieldset>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setCreating(false)} className="rounded-lg px-3 py-2.5 text-sm text-muted-foreground hover:bg-secondary sm:py-2">Annuler</button>
            <button type="submit" disabled={busy} className={btnCls}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Créer la BU
            </button>
          </div>
        </form>
      </Sheet>

      {businessUnits.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Aucune Business Unit. Commencez par en créer une — tout le reste du module s&apos;y rattache.
        </p>
      )}

      {businessUnits.map((bu) => (
        <BuCard
          key={bu.id}
          bu={bu}
          open={open[bu.id] ?? false}
          onToggle={() => setOpen((o) => ({ ...o, [bu.id]: !o[bu.id] }))}
          etapeInitiale={etapeInitiale ?? null}
          companies={companies} supervisors={supervisors} users={users} dossiers={dossiers} config={config}
          busy={busy} run={run}
          kamsInside={kamsOf(bu.id)} kamsFree={orphelinsKam}
          territoiresInside={territoiresOf(bu.id)} etablissements={etablissements}
          referentsInside={referentsOf(bu.id)} referentsEligibles={referentsEligibles}
          specialitesReferentiel={specialitesReferentiel}
          departements={departements} lectureOrg={organigramme[bu.id] ?? null}
          productsInside={productsOf(bu.id)} productsFree={orphelinsProd}
        />
      ))}

      {/* ─────────── CE QUI N'EST RATTACHÉ À RIEN — visible, jamais perdu ─────────── */}
      {(orphelinsKam.length > 0 || orphelinsProd.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden /> Sans Business Unit
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {orphelinsKam.length > 0 && <p><span className="font-medium">{orphelinsKam.length} KAM</span> : {orphelinsKam.map((k) => k.name).join(", ")}</p>}
            {orphelinsProd.length > 0 && <p><span className="font-medium">{orphelinsProd.length} produit(s)</span> : {orphelinsProd.map((p) => p.name).join(", ")}</p>}
            <p className="text-muted-foreground">Invisibles au pilotage tant qu&apos;ils n&apos;ont pas de BU : rattachez-les depuis une BU (étapes KAM, Spécialités &amp; produits).</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BuCard({
  bu, open, onToggle, etapeInitiale, companies, supervisors, users, dossiers, config, busy, run,
  kamsInside, kamsFree, productsInside, productsFree, territoiresInside, etablissements,
  referentsInside, referentsEligibles, specialitesReferentiel, departements, lectureOrg,
}: {
  departements: Opt[]; lectureOrg: LectureOrg | null;
  bu: BuRow; open: boolean; onToggle: () => void; etapeInitiale: Etape | null;
  companies: Opt[]; supervisors: Opt[]; users: Opt[];
  dossiers: { id: string; label: string }[];
  config: { daysPerMonth: number; visitsPerDay: number; fieldPct: number };
  busy: boolean; run: Run;
  kamsInside: KamRow[]; kamsFree: KamRow[]; productsInside: ProductRow[]; productsFree: ProductRow[];
  territoiresInside: TerritoireRow[]; etablissements: EtabOpt[];
  referentsInside: ReferentRow[]; referentsEligibles: Opt[];
  specialitesReferentiel: Opt[];
}) {
  const [etape, setEtape] = React.useState<Etape>(etapeInitiale ?? "identite");
  // LES DEUX FAITS QUE L'ÉTAPE « TERRITOIRES » RÉCLAME (voir `sfe-setup.ts`) : combien de KAM sont actifs, et LESQUELS
  // n'ont aucun établissement — la raison les nomme.
  const hospitaliere = estBuHospitaliere(bu.channel);
  const territoireDe = (repId: string) => territoiresInside.find((t) => t.repId === repId) ?? null;
  const etat = {
    supervisorId: bu.supervisorId, channel: bu.channel,
    repCount: kamsInside.length, productCount: productsInside.length,
    kamsActifs: kamsInside.filter((k) => k.isActive).length,
    kamsSansTerritoire: kamsSansTerritoire(kamsInside, territoiresInside.map((t) => ({ repId: t.repId, etablissements: t.liens.length }))),
    referentCount: referentsInside.length,
    referentsSansRole: referentsInside.filter((r) => !r.porteLeRole).length,
    specialtyCount: bu.specialites.length,
  };
  const steps = buSetupSteps(etat);
  const manquantes = steps.filter((s) => !s.done);
  const { done, total } = buSetupProgress(etat);
  const superviseur = supervisors.find((u) => u.id === bu.supervisorId)?.name ?? null;
  // LE DÉPARTEMENT manque aussi à l'identité : sans lui, la BU n'est nulle part dans l'organigramme.
  const manque = (e: Etape) => steps.some((s) => CLES_ETAPE[e].includes(s.key) && !s.done) || (e === "identite" && !bu.departmentId);

  function saveBu(patch: Partial<BuRow>) {
    const next = { ...bu, ...patch };
    const fd = new FormData();
    fd.set("id", next.id); fd.set("name", next.name); fd.set("code", next.code ?? "");
    fd.set("color", next.color ?? ""); fd.set("companyId", next.companyId ?? "");
    fd.set("headId", next.headId ?? ""); fd.set("supervisorId", next.supervisorId ?? "");
    fd.set("departmentId", next.departmentId ?? "");
    fd.set("channel", next.channel);
    // « on » OU « off » : n'envoyer que « on » laissait une gamme décochée active (§118.172).
    fd.set("isActive", next.isActive ? "on" : "off");
    void run(updateBusinessUnit, fd);
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-start gap-2 text-left">
          {open ? <ChevronDown className="mt-1 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-1 h-4 w-4 shrink-0" />}
          <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: bu.color ?? "#94a3b8" }} />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{bu.name}</CardTitle>
              <Badge tone="neutral" dot={false}>{channelLabel(bu.channel)}</Badge>
              {!bu.isActive && <Badge tone="warning" dot={false}>Inactive</Badge>}
            </span>
            {/* CE QUI MANQUE, NOMMÉ — pas un compteur muet. */}
            <span className="mt-0.5 block text-sm text-muted-foreground">
              {superviseur ? `Supervisée par ${superviseur}` : "Sans superviseur"}{" · "}{kamsInside.length} KAM{" · "}{productsInside.length} produit(s)
            </span>
            {manquantes.length > 0 && (
              <span className="mt-1 block text-xs text-amber-700 dark:text-amber-500">À faire : {manquantes.map((s) => s.label.toLowerCase()).join(", ")}.</span>
            )}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">{done}/{total}</span>
          {done === total && <Check className="h-4 w-4 text-emerald-600" aria-label="BU complète" />}
        </span>
      </CardHeader>

      {open && (
        <CardContent className="space-y-4">
          <nav className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto border-b border-border px-1" aria-label={`Étapes de ${bu.name}`}>
            {ETAPES.map((e, i) => (
              <button key={e} type="button" onClick={() => setEtape(e)} aria-current={etape === e ? "step" : undefined}
                className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
                  etape === e ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
                <span className="text-xs tabular-nums text-muted-foreground">{i + 1}</span> {ETAPE_LABELS[e]}
                {manque(e) && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="à compléter" />}
              </button>
            ))}
          </nav>

          {etape === "identite" && (
            <EtapeIdentite bu={bu} companies={companies} supervisors={supervisors} users={users} steps={steps} saveBu={saveBu}
              departements={departements} lectureOrg={lectureOrg}
              busy={busy} run={run} referentsInside={referentsInside} referentsEligibles={referentsEligibles} />
          )}
          {etape === "produits" && (
            <EtapeProduits bu={bu} steps={steps} specialitesReferentiel={specialitesReferentiel} productsInside={productsInside}
              productsFree={productsFree} users={users} dossiers={dossiers} busy={busy} run={run} />
          )}
          {etape === "kams" && (
            <EtapeKams bu={bu} steps={steps} kamsInside={kamsInside} kamsFree={kamsFree} config={config} hospitaliere={hospitaliere} busy={busy} run={run} />
          )}
          {etape === "secteurs" && (
            <EtapeSecteurs bu={bu} steps={steps} kamsInside={kamsInside} hospitaliere={hospitaliere} territoireDe={territoireDe}
              etablissements={etablissements} busy={busy} run={run} />
          )}
        </CardContent>
      )}
    </Card>
  );
}
