"use client";

import * as React from "react";
import { Check, Loader2, MapPin, Package, Plus, Star, Stethoscope, Trash2, UserCog, Users, Wallet } from "lucide-react";
import {
  deleteBusinessUnit, openBusinessUnitBudget, createPromoProduct, updatePromoProduct, deletePromoProduct,
  saveRepProfile, addBuMarketingReferent, removeBuMarketingReferent, enregistrerSpecialitesBu,
} from "@/lib/actions/sales-planning-actions";
import { ChoixSpecialites, type ChoixSpecialitesValeur } from "./choix-specialites";
import { CHANNELS, CHANNEL_LABELS, channelCovers, channelLabel, type Channel, type BuStep } from "@/lib/sfe-setup";
import { TerritoireKam, type TerritoireRow } from "./territoire-kam";
import { WilayaPivotKam } from "./wilaya-pivot";
import type { EtabOpt } from "./choix-etablissements";
import type { BuRow, KamRow, LectureOrg, Opt, ProductRow, ReferentRow } from "./bu-manager";
import { InfoBulle } from "@/components/ui/info-bulle";
import { useConfirmer } from "@/components/ui/dialogue";

/**
 * LES ÉTAPES DU MONTAGE D'UNE BU (Direction, 07/10 : « découpées en étapes au lieu d'un écran de 14 blocs ») — la BU et
 * son superviseur, ses spécialités et produits, ses KAM, leurs secteurs. Le code de chaque bloc est celui de l'écran
 * d'avant, déplacé tel quel : mêmes actions, mêmes champs, mêmes gardes.
 */

// `max-w-full` : un menu dont une option est longue ne pousse jamais la carte hors de l'écran.
export const inputCls = "h-10 max-w-full rounded-lg border border-input bg-background px-2 text-sm focus:border-primary focus:outline-none sm:h-9";
// Bouton secondaire « Rattacher / Désigner / Ajouter » : 40 px au doigt, compact au bureau.
const btnLigneCls = "inline-flex items-center gap-1.5 rounded-lg border border-input px-2.5 py-2 text-sm hover:bg-secondary disabled:opacity-60 sm:py-1.5";
const iconBtnCls = "rounded-md p-2.5 sm:p-1.5";
const caseCls = "flex min-h-10 items-center gap-1 text-xs text-muted-foreground sm:min-h-0";
export const btnCls = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60";

type Action = (fd: FormData) => Promise<{ ok: boolean; error?: string }>;
export type Run = (a: Action, fd: FormData, refresh?: boolean) => Promise<boolean>;
type Config = { daysPerMonth: number; visitsPerDay: number; fieldPct: number };

const Titre = ({ icone, children }: { icone?: React.ReactNode; children: React.ReactNode }) => (
  <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{icone}{children}</h4>
);

// ───────────────────────────── 1. La BU et son superviseur ─────────────────────────────

export function EtapeIdentite({ bu, companies, supervisors, users, steps, saveBu, busy, run, referentsInside, referentsEligibles, departements = [], lectureOrg = null }: {
  bu: BuRow; companies: Opt[]; supervisors: Opt[]; users: Opt[]; steps: BuStep[];
  saveBu: (patch: Partial<BuRow>) => void; busy: boolean; run: Run;
  referentsInside: ReferentRow[]; referentsEligibles: Opt[];
  /** Les départements de l'organigramme — la seule source (Direction, 10/2026). */
  departements?: Opt[];
  lectureOrg?: LectureOrg | null;
}) {
  const confirmer = useConfirmer();
  const nomDe = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? supervisors.find((u) => u.id === id)?.name ?? null : null);
  const propose = lectureOrg?.propose && lectureOrg.propose !== bu.supervisorId ? lectureOrg.propose : null;
  // Le superviseur proposé n'est pas toujours dans la liste des candidats par rôle : il reste choisissable.
  const candidats = propose && !supervisors.some((s) => s.id === propose) ? [...supervisors, { id: propose, name: nomDe(propose) ?? "Responsable du département" }] : supervisors;
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <Titre>Département</Titre>
        <div className="flex flex-wrap items-center gap-2">
          <select key={bu.departmentId ?? ""} className={`${inputCls} min-w-56`} defaultValue={bu.departmentId ?? ""} onChange={(e) => saveBu({ departmentId: e.target.value || null })} aria-label="Département de la BU">
            <option value="">— Département (organigramme) —</option>
            {departements.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <InfoBulle label="Pourquoi le département">
            L&apos;organigramme est la seule source : la BU pointe sur son département, son superviseur en découle (le responsable du
            département), et son budget est celui de ce département.
          </InfoBulle>
        </div>
        {!bu.departmentId && (
          <p className="text-xs text-amber-700 dark:text-amber-500">Rattachez la BU à son département — ou ouvrez son budget pour lui créer son sous-département.</p>
        )}
      </section>
      <section className="space-y-2">
        <Titre>Identité</Titre>
        <div className="flex flex-wrap items-center gap-1.5">
          <input className={`${inputCls} min-w-40 flex-1`} defaultValue={bu.name} onBlur={(e) => e.target.value !== bu.name && saveBu({ name: e.target.value })} />
          <input className={`${inputCls} w-28`} defaultValue={bu.code ?? ""} placeholder="Code" onBlur={(e) => saveBu({ code: e.target.value || null })} />
          <select className={inputCls} defaultValue={bu.companyId ?? ""} onChange={(e) => saveBu({ companyId: e.target.value || null })}>
            <option value="">— Société —</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className={inputCls} defaultValue={bu.headId ?? ""} onChange={(e) => saveBu({ headId: e.target.value || null })}>
            <option value="">— Chef de BU —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <input type="color" className="h-10 w-12 rounded-lg border border-input bg-background sm:h-9" defaultValue={bu.color ?? "#2563eb"} onBlur={(e) => saveBu({ color: e.target.value })} title="Couleur" aria-label="Couleur" />
          <label className={caseCls}>
            <input type="checkbox" defaultChecked={bu.isActive} onChange={(e) => saveBu({ isActive: e.target.checked })} /> Active
          </label>
          {/* OUVRIR LE BUDGET DE LA GAMME — un geste explicite, pas un effet de bord de la création. */}
          {bu.departmentId ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-success/30 px-2 py-1 text-xs font-medium text-success" title="Cette gamme a son sous-département : son budget et sa masse salariale se lisent dans Budgets.">
              <Wallet className="h-3.5 w-3.5" /> Budget ouvert
            </span>
          ) : (
            <button
              type="button"
              title="Ouvrir le budget de cette gamme : elle devient un sous-département de la Direction commerciale, avec son enveloppe Ad&Pro et sa masse salariale."
              className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-2 text-xs font-medium hover:bg-secondary sm:py-1"
              onClick={() => { const fd = new FormData(); fd.set("id", bu.id); void run(openBusinessUnitBudget, fd); }}
            >
              <Wallet className="h-3.5 w-3.5" /> Ouvrir le budget
            </button>
          )}
          <button
            type="button" title="Supprimer la BU" aria-label="Supprimer la BU"
            className={`${iconBtnCls} text-destructive hover:bg-destructive/10`}
            onClick={async () => {
              if (!(await confirmer(`Supprimer la BU « ${bu.name} » ?`))) return;
              const fd = new FormData(); fd.set("id", bu.id);
              void run(deleteBusinessUnit, fd);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <Titre>Supervision &amp; terrain</Titre>
        <div className="flex flex-wrap items-center gap-2">
          <select key={bu.supervisorId ?? ""} className={inputCls} defaultValue={bu.supervisorId ?? ""} onChange={(e) => saveBu({ supervisorId: e.target.value || null })}>
            <option value="">— Superviseur —</option>
            {candidats.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {propose && (
            <button type="button" disabled={busy} onClick={() => saveBu({ supervisorId: propose })}
              className="rounded-lg border border-input px-2.5 py-2 text-xs hover:bg-secondary disabled:opacity-60 sm:py-1">
              Proposé : {nomDe(propose) ?? "le responsable du département"} — appliquer
            </button>
          )}
          <select className={inputCls} defaultValue={bu.channel} onChange={(e) => saveBu({ channel: e.target.value })}>
            {CHANNELS.map((c) => <option key={c} value={c}>Terrain : {CHANNEL_LABELS[c]}</option>)}
          </select>
        </div>
        {!bu.supervisorId && <p className="text-xs text-muted-foreground">{steps.find((s) => s.key === "SUPERVISEUR")!.why}</p>}
        {bu.supervisorId && (lectureOrg?.horsLigne.length ?? 0) > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-500">Hors de la ligne hiérarchique de : {lectureOrg!.horsLigne.join(", ")}.</p>
        )}
      </section>

      <section className="space-y-2">
        <Titre icone={<Users className="h-3.5 w-3.5" aria-hidden />}>Référents Direction Marketing ({referentsInside.length})</Titre>
        {!steps.find((x) => x.key === "REFERENTS")!.done && <p className="text-xs text-muted-foreground">{steps.find((x) => x.key === "REFERENTS")!.why}</p>}
        <div className="space-y-1.5">
          {referentsInside.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              {/* CE QUI MANQUE SE DIT SUR LA LIGNE : une désignation cible la notification, elle n'accorde aucun droit. */}
              {!r.porteLeRole && (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[0.6875rem] text-amber-700 dark:text-amber-400">ne porte plus le rôle — prévenu, sans pouvoir trancher</span>
              )}
              <button
                type="button" disabled={busy}
                onClick={() => { const fd = new FormData(); fd.set("id", r.id); void run(removeBuMarketingReferent, fd); }}
                className="rounded-lg border border-input px-2.5 py-2 text-xs hover:bg-secondary disabled:opacity-60 sm:px-2 sm:py-1"
              >
                Retirer
              </button>
            </div>
          ))}
        </div>
        {referentsEligibles.filter((u) => !referentsInside.some((r) => r.userId === u.id)).length > 0 ? (
          <form className="flex flex-wrap items-center gap-2" action={(fd) => { fd.set("businessUnitId", bu.id); void run(addBuMarketingReferent, fd); }}>
            <select name="userId" required className={inputCls} defaultValue="">
              <option value="" disabled>— Désigner un référent —</option>
              {referentsEligibles.filter((u) => !referentsInside.some((r) => r.userId === u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button type="submit" disabled={busy} className={btnLigneCls}><Plus className="h-4 w-4" /> Désigner</button>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">
            {referentsEligibles.length === 0
              ? "Personne ne porte le rôle Direction Marketing : attribuez-le depuis Administration › Comptes, puis revenez désigner."
              : "Toutes les personnes de la Direction Marketing sont déjà référentes de cette gamme."}
          </p>
        )}
      </section>
    </div>
  );
}

// ───────────────────────────── 2. Spécialités & produits ─────────────────────────────

export function EtapeProduits({ bu, steps, specialitesReferentiel, productsInside, productsFree, users, dossiers, busy, run }: {
  bu: BuRow; steps: BuStep[]; specialitesReferentiel: Opt[];
  productsInside: ProductRow[]; productsFree: ProductRow[]; users: Opt[];
  dossiers: { id: string; label: string }[]; busy: boolean; run: Run;
}) {
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <Titre icone={<Stethoscope className="h-3.5 w-3.5" aria-hidden />}>Spécialités visées ({bu.specialites.length})</Titre>
        <SpecialitesDeLaBu bu={bu} referentiel={specialitesReferentiel} busy={busy} run={run}
          why={bu.specialites.length === 0 ? steps.find((s) => s.key === "SPECIALITES")!.why : null} />
      </section>
      <section className="space-y-2">
        <Titre icone={<Package className="h-3.5 w-3.5" aria-hidden />}>Produits de la BU ({productsInside.length})</Titre>
        {productsInside.length === 0 && <p className="text-xs text-muted-foreground">{steps.find((s) => s.key === "PRODUITS")!.why}</p>}
        <div className="space-y-1.5">
          {productsInside.map((p) => <ProductLine key={p.id} prod={p} buChannel={bu.channel} users={users} busy={busy} run={run} />)}
        </div>
        <form className="flex flex-wrap items-center gap-2" action={(fd) => { fd.set("businessUnitId", bu.id); void run(createPromoProduct, fd); }}>
          <select name="regulatoryProductId" required className={`${inputCls} w-full flex-1 sm:w-auto sm:min-w-64`} defaultValue="">
            <option value="" disabled>— Choisir un dossier Regulatory —</option>
            {dossiers.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <button type="submit" disabled={busy} className={btnLigneCls}><Plus className="h-4 w-4" /> Ajouter le produit</button>
        </form>
        {/* Les produits déjà créés ailleurs se rattachent sans repasser par Regulatory. */}
        {productsFree.length > 0 && (
          <form className="flex flex-wrap items-center gap-2" action={(fd) => { fd.set("businessUnitId", bu.id); void run(updatePromoProduct, fd); }}>
            <select name="id" required className={inputCls} defaultValue="">
              <option value="" disabled>— Rattacher un produit existant —</option>
              {productsFree.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button type="submit" disabled={busy} className={btnLigneCls}><Plus className="h-4 w-4" /> Rattacher</button>
          </form>
        )}
      </section>
    </div>
  );
}

// ───────────────────────────── 3. Les KAM ─────────────────────────────

export function EtapeKams({ bu, steps, kamsInside, kamsFree, config, hospitaliere, busy, run }: {
  bu: BuRow; steps: BuStep[]; kamsInside: KamRow[]; kamsFree: KamRow[]; config: Config;
  hospitaliere: boolean; busy: boolean; run: Run;
}) {
  return (
    <section className="space-y-2">
      <Titre icone={<Users className="h-3.5 w-3.5" aria-hidden />}>KAM de la BU ({kamsInside.length})</Titre>
      {kamsInside.length === 0 && <p className="text-xs text-muted-foreground">{steps.find((s) => s.key === "KAM")!.why}</p>}
      <div className="space-y-1.5">
        {kamsInside.map((k) => <KamLine key={k.repId} kam={k} buId={bu.id} config={config} busy={busy} run={run} hospitaliere={hospitaliere} />)}
      </div>
      {kamsFree.length > 0 && (
        <form className="flex flex-wrap items-center gap-2" action={(fd) => { fd.set("businessUnitId", bu.id); void run(saveRepProfile, fd); }}>
          <select name="repId" required className={inputCls} defaultValue="">
            <option value="" disabled>— Rattacher un KAM —</option>
            {kamsFree.map((k) => <option key={k.repId} value={k.repId}>{k.name}</option>)}
          </select>
          <button type="submit" disabled={busy} className={btnLigneCls}><Plus className="h-4 w-4" /> Rattacher</button>
        </form>
      )}
    </section>
  );
}

// ───────────────────────────── 4. Les secteurs (territoires des KAM) ─────────────────────────────

/**
 * LE SECTEUR DE CHAQUE KAM (04/10/2026) : dans une BU hospitalière, il se choisit sur SA ligne — établissements de
 * l'annuaire, tous leurs services ou certains. La raison de l'étape nomme ceux qui n'en ont pas. Dans une BU de ville,
 * le secteur est le texte de la ligne du KAM (étape « KAM »).
 */
export function EtapeSecteurs({ bu, steps, kamsInside, hospitaliere, territoireDe, etablissements, busy, run }: {
  bu: BuRow; steps: BuStep[]; kamsInside: KamRow[]; hospitaliere: boolean;
  territoireDe: (repId: string) => TerritoireRow | null; etablissements: EtabOpt[]; busy: boolean; run: Run;
}) {
  const etape = steps.find((x) => x.key === "TERRITOIRES");
  return (
    <section className="space-y-2">
      <Titre icone={<MapPin className="h-3.5 w-3.5" aria-hidden />}>Secteurs des KAM</Titre>
      {kamsInside.length === 0 ? <p className="text-xs text-muted-foreground">Rattachez d&apos;abord un KAM à la BU (étape KAM).</p>
        : !hospitaliere ? <p className="text-xs text-muted-foreground">BU de ville : le secteur de chaque KAM se saisit en texte sur sa ligne (étape KAM) ; sa wilaya pivot se choisit ici.</p>
        : (
          <>
            {etape && !etape.done && <p className="text-xs text-muted-foreground">{etape.why}</p>}
            <div className="space-y-1.5">
              {kamsInside.map((k) => (
                <div key={k.repId} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border p-1.5 text-sm">
                  <UserCog className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-28 flex-1 font-medium [overflow-wrap:anywhere]">{k.name}</span>
                  <TerritoireKam buId={bu.id} kam={k} territoire={territoireDe(k.repId)} etablissements={etablissements} busy={busy} run={run} />
                </div>
              ))}
            </div>
          </>
        )}
      {/* BU de ville : pas de territoire à cocher — seulement la wilaya pivot de chaque KAM (Direction, 08/10). */}
      {!hospitaliere && kamsInside.length > 0 && (
        <div className="space-y-1.5">
          {kamsInside.map((k) => (
            <div key={k.repId} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border p-1.5 text-sm">
              <UserCog className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-28 flex-1 font-medium [overflow-wrap:anywhere]">{k.name}</span>
              <WilayaPivotKam buId={bu.id} repId={k.repId} nom={k.name} valeur={territoireDe(k.repId)?.wilayaPivot ?? null} busy={busy} run={run} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Une ligne de KAM : son secteur en texte (BU de ville), sa capacité, son ETP, et le bouton qui le sort de la BU. Son
 * territoire (BU hospitalière) se choisit à l'étape « Secteurs ».
 */
function KamLine({ kam, buId, config, busy, run, hospitaliere }: {
  kam: KamRow; buId: string; config: Config; busy: boolean; run: Run;
  /** BU hospitalière : le territoire se choisit dans l'annuaire, le texte « Secteur » disparaît. */
  hospitaliere: boolean;
}) {
  function save(patch: Partial<KamRow>, refresh = false) {
    const next = { ...kam, ...patch };
    const fd = new FormData();
    fd.set("repId", next.repId);
    fd.set("businessUnitId", next.businessUnitId ?? "");
    // CE QUE LA LIGNE NE MONTRE PAS NE S'ÉCRIT PAS (§118.152c) : dans une BU hospitalière le texte
    // « Secteur » n'est pas affiché, il ne repart donc pas.
    if (!hospitaliere) fd.set("region", next.region ?? "");
    fd.set("capDaysPerMonth", next.capDaysPerMonth == null ? "" : String(next.capDaysPerMonth));
    fd.set("capVisitsPerDay", next.capVisitsPerDay == null ? "" : String(next.capVisitsPerDay));
    fd.set("capFieldPct", next.capFieldPct == null ? "" : String(next.capFieldPct));
    fd.set("fteBudget", String(next.fteBudget));
    fd.set("seniority", next.seniority ?? "");
    fd.set("isActive", next.isActive ? "on" : "off");
    void run(saveRepProfile, fd, refresh);
  }
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border p-1.5 text-sm">
      <UserCog className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-28 flex-1 font-medium [overflow-wrap:anywhere]">{kam.name}</span>
      {!hospitaliere && (
        <input className={`${inputCls} w-32`} defaultValue={kam.region ?? ""} placeholder="Secteur" aria-label={`Secteur de ${kam.name}`} onBlur={(e) => save({ region: e.target.value || null })} />
      )}
      {/* La capacité vide = la valeur globale du paramétrage : le placeholder le DIT. */}
      <input className={`${inputCls} w-20`} type="number" inputMode="numeric" defaultValue={kam.capDaysPerMonth ?? ""} placeholder={`${config.daysPerMonth} j`} title="Jours terrain / mois" aria-label="Jours terrain / mois" onBlur={(e) => save({ capDaysPerMonth: num(e.target.value) })} />
      <input className={`${inputCls} w-20`} type="number" inputMode="decimal" defaultValue={kam.capVisitsPerDay ?? ""} placeholder={`${config.visitsPerDay} v/j`} title="Visites / jour" aria-label="Visites / jour" onBlur={(e) => save({ capVisitsPerDay: num(e.target.value) })} />
      <input className={`${inputCls} w-20`} type="number" inputMode="decimal" defaultValue={kam.capFieldPct ?? ""} placeholder={`${config.fieldPct} %`} title="% de temps terrain" aria-label="% de temps terrain" onBlur={(e) => save({ capFieldPct: num(e.target.value) })} />
      <input className={`${inputCls} w-20`} type="number" inputMode="decimal" step="0.1" defaultValue={kam.fteBudget} title="ETP contractuel" aria-label="ETP contractuel" onBlur={(e) => save({ fteBudget: Number(e.target.value) || 1 })} />
      <label className={caseCls}>
        <input type="checkbox" defaultChecked={kam.isActive} onChange={(e) => save({ isActive: e.target.checked }, true)} /> Actif
      </label>
      <button
        type="button" title="Retirer de la BU" aria-label="Retirer de la BU" disabled={busy}
        className={`${iconBtnCls} text-muted-foreground hover:bg-secondary hover:text-destructive`}
        onClick={() => { if (kam.businessUnitId === buId) save({ businessUnitId: null }, true); }}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Une ligne de produit : son dossier d'origine, son canal, son Direction Marketing. */
function ProductLine({ prod, buChannel, users, busy, run }: { prod: ProductRow; buChannel: string; users: Opt[]; busy: boolean; run: Run }) {
  const confirmer = useConfirmer();
  function save(patch: Partial<ProductRow>, refresh = false) {
    const next = { ...prod, ...patch };
    const fd = new FormData();
    fd.set("id", next.id); fd.set("name", next.name); fd.set("code", next.code ?? "");
    fd.set("channel", next.channel); fd.set("businessUnitId", next.businessUnitId ?? "");
    fd.set("managerId", next.managerId ?? "");
    // « on » OU « off » : n'envoyer que « on » laissait un produit décoché actif (§118.172).
    fd.set("isActive", next.isActive ? "on" : "off");
    void run(updatePromoProduct, fd, refresh);
  }
  // L'INCOHÉRENCE SE DIT, elle ne se corrige pas toute seule : c'est peut-être l'exception voulue.
  const horsTerrain = !channelCovers(buChannel, prod.channel);

  return (
    <div className="space-y-1 rounded-lg border border-border p-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <Package className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <input className={`${inputCls} min-w-32 flex-1`} defaultValue={prod.name} onBlur={(e) => e.target.value !== prod.name && save({ name: e.target.value })} />
        <select className={inputCls} defaultValue={prod.channel} onChange={(e) => save({ channel: e.target.value }, true)}>
          {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c as Channel]}</option>)}
        </select>
        <select className={inputCls} defaultValue={prod.managerId ?? ""} onChange={(e) => save({ managerId: e.target.value || null })}>
          <option value="">— Référent Direction Marketing —</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <label className={caseCls}>
          <input type="checkbox" defaultChecked={prod.isActive} onChange={(e) => save({ isActive: e.target.checked }, true)} /> Actif
        </label>
        <button
          type="button" title="Supprimer le produit" aria-label="Supprimer le produit" disabled={busy}
          className={`${iconBtnCls} text-destructive hover:bg-destructive/10`}
          onClick={async () => {
            if (!(await confirmer(`Supprimer « ${prod.name} » du catalogue promotionnel ?`))) return;
            const fd = new FormData(); fd.set("id", prod.id);
            void run(deletePromoProduct, fd, true);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <p className="pl-6 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {prod.dossier ? `Dossier : ${prod.dossier}` : "Aucun dossier Regulatory rattaché."}
        {horsTerrain && <span className="ml-2 text-amber-700 dark:text-amber-500">Ce produit ({channelLabel(prod.channel)}) sort du terrain de la BU ({channelLabel(buChannel)}).</span>}
      </p>
    </div>
  );
}

/** LES SPÉCIALITÉS D'UNE BU — ce qu'elle vise, et le geste qui le change (§118.183). */
function SpecialitesDeLaBu({ bu, referentiel, busy, run, why }: {
  bu: BuRow; referentiel: Opt[]; busy: boolean; run: Run;
  /** La raison de l'étape quand elle manque — celle de `buSetupSteps`, jamais réécrite ici. */
  why: string | null;
}) {
  const [edite, setEdite] = React.useState(false);
  const initial = React.useMemo<ChoixSpecialitesValeur>(
    () => ({ ids: bu.specialites.map((s) => s.id), principaleId: bu.specialites.find((s) => s.principale)?.id ?? null }),
    [bu.specialites],
  );
  const [valeur, setValeur] = React.useState<ChoixSpecialitesValeur>(initial);
  // L'ÉDITEUR S'OUVRE SUR L'ÉTAT DU JOUR (§118.172) — les gestes attendent déjà le rafraîchissement (`busy`).
  React.useEffect(() => { if (!edite) setValeur(initial); }, [initial, edite]);

  async function enregistrer() {
    const fd = new FormData();
    fd.set("businessUnitId", bu.id);
    for (const id of valeur.ids) fd.append("specialtyIds", id);
    if (valeur.principaleId) fd.set("principaleId", valeur.principaleId);
    if (await run(enregistrerSpecialitesBu, fd)) setEdite(false);
  }

  const principale = bu.specialites.find((s) => s.principale) ?? null;
  const associees = bu.specialites.filter((s) => !s.principale);
  return (
    <div className="space-y-2">
      {bu.specialites.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Spécialités de la BU">
          {principale && (
            <li className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300">
              <Star className="h-3 w-3 fill-current" aria-hidden /> {principale.name}
              <span className="sr-only">(principale)</span>
            </li>
          )}
          {associees.map((s) => <li key={s.id} className="rounded-full bg-secondary px-2.5 py-0.5 text-xs">{s.name}</li>)}
        </ul>
      ) : (
        why && <p className="text-xs text-muted-foreground">{why}</p>
      )}
      {edite ? (
        <div className="space-y-2 rounded-lg border border-border p-2.5">
          <ChoixSpecialites referentiel={referentiel} valeur={valeur} onChange={setValeur} disabled={busy} />
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setEdite(false)} disabled={busy} className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-secondary sm:py-1.5">Annuler</button>
            <button type="button" onClick={enregistrer} disabled={busy} className={btnCls}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enregistrer les spécialités
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setEdite(true)} disabled={busy} className={btnLigneCls}>
          <Stethoscope className="h-4 w-4" aria-hidden /> {bu.specialites.length > 0 ? "Modifier les spécialités" : "Choisir les spécialités"}
        </button>
      )}
    </div>
  );
}
