"use client";

import * as React from "react";
import { Loader2, Check, Search, EyeOff, Lock } from "lucide-react";
import { saveModuleAccess } from "@/lib/actions/access-actions";
import { setPipelineAccess } from "@/lib/actions/settings-actions";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AnnuairesCoches } from "@/components/admin/annuaires-coches";

export interface UserModuleState {
  mode: "DEFAULT" | "CUSTOM" | "BLOCKED";
  actions: Record<string, boolean>;
  scope: "ALL" | "ASSIGNED";
  roleSummary: string;
  /** Les annuaires qu'ouvre un accès personnalisé au module Annuaires (§118.147). */
  sections?: string[];
}
export interface AccessUser {
  id: string;
  name: string;
  role: string;
  byModule: Record<string, UserModuleState>;
}

/**
 * LES COLONNES VIENNENT DU SERVEUR, déduites des droits réels du module — elles ne sont plus
 * écrites ici. Un module qui n'a aucune validation n'affiche donc pas de case « Valider » : une
 * case qui n'ouvre rien fait croire à un droit accordé, et c'est pire que l'absence de case.
 */
export interface ModuleSpec {
  value: string;
  label: string;
  actions: string[];
  rowScoped: boolean;
  roleCount: number;
  /**
   * Module MASQUÉ (« Modules en service ») — hors service pour tout le monde sauf le Super
   * Admin, quels que soient les droits accordés ici. Sans cette information, on règle des
   * accès qui n'ouvrent rien et l'on conclut que « les droits ne se modifient pas ».
   */
  hidden: boolean;
}

/**
 * LE PIPELINE RÉGLEMENTAIRE — un droit qui ne passe PAS par la matrice des modules.
 *
 * Voir un dossier verrouillé n'est pas une action du module Regulatory : c'est une confidence
 * accordée nommément ou par rôle. Le réglage existait, mais dans une page de réglages longue de
 * quinze cartes — c'est-à-dire nulle part, pour qui cherche « les accès ». Il vient donc ICI, sur
 * la ligne de la personne, à côté du module qu'il concerne.
 *
 * Un droit hérité du RÔLE s'affiche coché et VERROUILLÉ : le décocher n'aurait rien fait, et
 * l'on aurait conclu que l'écran ne marche pas. On dit d'où il vient, et où le retirer.
 */
export interface PipelineState {
  view: boolean;
  manage: boolean;
  /** Le droit vient du RÔLE : il ne se retire pas d'ici. */
  viewViaRole: boolean;
  manageViaRole: boolean;
}
export interface PipelineConfig {
  /** Seul le Super Admin distribue ces accès (`setPipelineAccess`). */
  canEdit: boolean;
  byUser: Record<string, PipelineState>;
  /** Rejoués tels quels à l'enregistrement : cet écran règle les PERSONNES, pas les rôles. */
  viewerRoles: string[];
  managerRoles: string[];
}

// Les colonnes « Voit le pipeline » / « Tient le cadenas » vivent sur la ligne du module « Pipeline réglementaire »,
// devenu module à part (Direction, 08/10) : la confidence se règle à côté du module qu'elle complète.
const PIPELINE_MODULE = "REGULATORY_PIPELINE";
/** Le module dont un accès personnalisé se découpe PAR ANNUAIRE (§118.147). */
const MODULE_ANNUAIRES = "DIRECTORIES";

export function ModuleAccessGrid({
  modules, users, actionLabels, pipeline,
}: { modules: ModuleSpec[]; users: AccessUser[]; actionLabels: Record<string, string>; pipeline?: PipelineConfig }) {
  const [module, setModule] = React.useState(modules[0]?.value ?? "");
  const spec = modules.find((m) => m.value === module) ?? modules[0];
  const cols = spec?.actions ?? [];
  const [rows, setRows] = React.useState<Record<string, UserModuleState>>({});
  const [pipeRows, setPipeRows] = React.useState<Record<string, PipelineState>>({});
  const [search, setSearch] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  // (Re)charge les états du module sélectionné.
  React.useEffect(() => {
    const next: Record<string, UserModuleState> = {};
    for (const u of users) next[u.id] = { ...u.byModule[module], actions: { ...u.byModule[module]?.actions }, sections: [...(u.byModule[module]?.sections ?? [])] };
    setRows(next);
  }, [module, users]);

  React.useEffect(() => {
    if (!pipeline) return;
    const next: Record<string, PipelineState> = {};
    for (const u of users) next[u.id] = { ...(pipeline.byUser[u.id] ?? { view: false, manage: false, viewViaRole: false, manageViaRole: false }) };
    setPipeRows(next);
  }, [pipeline, users]);

  // Les colonnes du pipeline ne s'affichent que sur le module qu'elles concernent, et seulement
  // à qui peut réellement les enregistrer.
  const showPipeline = Boolean(pipeline?.canEdit) && module === PIPELINE_MODULE;
  const setPipe = (userId: string, patch: Partial<PipelineState>) =>
    setPipeRows((s) => ({ ...s, [userId]: { ...s[userId], ...patch } }));

  function update(userId: string, patch: Partial<UserModuleState>) {
    setRows((s) => ({ ...s, [userId]: { ...s[userId], ...patch } }));
  }

  const filtered = search.trim()
    ? users.filter((u) => u.name.toLowerCase().includes(search.trim().toLowerCase()))
    : users;

  return (
    <form
      action={async (fd) => {
        setSaving(true);
        fd.set("module", module);
        for (const u of users) {
          const r = rows[u.id];
          if (!r) continue;
          fd.append("userId", u.id);
          fd.set(`mode_${u.id}`, r.mode);
          if (r.mode === "CUSTOM") {
            for (const a of cols) if (r.actions[a]) fd.set(`act_${u.id}_${a}`, "on");
            // Drive & Sujets : portée toujours cloisonnée (privé), jamais « tout ».
            fd.set(`scope_${u.id}`, module === "DRIVE" || module === "DOSSIERS" ? "ASSIGNED" : r.scope);
            // Les annuaires : lus depuis l'ÉTAT, comme les gestes — un compte que la recherche
            // masque garde ses annuaires au lieu de les perdre à l'enregistrement.
            if (module === MODULE_ANNUAIRES) for (const c of r.sections ?? []) fd.set(`sect_${u.id}_${c}`, "on");
          }
        }
        await saveModuleAccess(fd);
        // LES ACCÈS AU PIPELINE partent par leur propre action : ce sont des réglages
        // d'instance, pas des droits de module. Les rôles déjà accordés sont REJOUÉS —
        // cet écran règle les personnes, il ne doit pas effacer ce qui vient des rôles.
        if (showPipeline && pipeline) {
          const pfd = new FormData();
          pipeline.viewerRoles.forEach((r) => pfd.append("viewerRoles", r));
          pipeline.managerRoles.forEach((r) => pfd.append("managerRoles", r));
          for (const u of users) {
            const p = pipeRows[u.id];
            if (!p) continue;
            if (p.view && !p.viewViaRole) pfd.append("viewerUserIds", u.id);
            if (p.manage && !p.manageViaRole) pfd.append("managerUserIds", u.id);
          }
          await setPipelineAccess(pfd);
        }
        setSaving(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full space-y-1 sm:w-auto sm:min-w-[16rem]">
          <label className="text-sm font-medium" htmlFor="module-pick">Module</label>
          <Select id="module-pick" value={module} onChange={(e) => setModule(e.target.value)} className="w-full sm:w-64">
            {modules.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
          {spec && (
            <p className="text-xs text-muted-foreground">
              {spec.roleCount === 0
                // Le dire ici évite de chercher longtemps pourquoi « personne n'y a accès ».
                ? "Aucun rôle n'atteint ce module par défaut : l'accès se donne nommément, ci-dessous."
                : `${spec.roleCount} rôle${spec.roleCount > 1 ? "s" : ""} y ont accès par défaut · ${spec.actions.length || "aucune"} capacité${spec.actions.length > 1 ? "s" : ""} réglable${spec.actions.length > 1 ? "s" : ""}`}
            </p>
          )}
        </div>
        <div className="relative w-full sm:w-auto">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher un employé…" className="w-full pl-8 sm:w-56" />
        </div>
      </div>

      {/* LE MODULE HORS SERVICE SE DIT ICI, pas ailleurs. Un module masqué se referme pour tout
          le monde sauf le Super Admin : les droits réglés ci-dessous s'enregistrent bel et bien,
          mais n'ouvrent RIEN tant qu'il n'est pas remis en service. Sans ce bandeau, on règle,
          on teste, on ne comprend pas — et l'on conclut que les accès du module sont cassés. */}
      {spec?.hidden && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p>
            <strong>{spec.label} est hors service</strong> — retiré de la plateforme pour tout le monde
            (le Super Admin excepté). Les droits réglés ci-dessous s&apos;enregistrent, mais n&apos;ouvriront
            rien tant que le module ne sera pas remis en service dans{" "}
            <a href="/admin/settings" className="font-medium text-primary hover:underline">Administration › Réglages › Modules en service</a>.
          </p>
        </div>
      )}

      {module === MODULE_ANNUAIRES && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p>
            <strong>Accès par annuaire</strong> — en « Personnalisé », cochez les annuaires à ouvrir :
            chacun s&apos;ouvre <em>en entier</em> avec les gestes cochés (Créer, Modifier, Supprimer),
            sans donner le module de son référentiel. Ouvrir les établissements à quelqu&apos;un ne lui
            ouvre pas toute la Visite médicale. L&apos;ouverture <strong>s&apos;ajoute</strong> à ce que le
            rôle donne déjà : décocher ne retire pas un annuaire tenu par la Visite médicale ou les
            Moyens généraux.
          </p>
        </div>
      )}

      {showPipeline && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p>
            <strong>Pipeline réglementaire</strong> — les dossiers <em>verrouillés</em> : un produit à
            l&apos;étude, invisible de toute la plateforme (tableau, recherche, sélecteurs de produits,
            assistant). <strong>Voir</strong> est une confidence ; <strong>tenir le cadenas</strong> est
            le pouvoir de publier un dossier à toute l&apos;entreprise — et cela ne se reprend pas.
            Il faut <strong>les deux clés</strong> : le module (gestes ci-contre) et la confidence.
            Les accès donnés par <strong>rôle</strong> apparaissent cochés et verrouillés : ils se
            retirent dans{" "}
            <a href="/admin/settings" className="font-medium text-primary hover:underline">Réglages › Pipeline réglementaire</a>.
          </p>
        </div>
      )}

      {/* Une matrice (employés × capacités) : elle défile dans sa carte, la colonne des noms reste en place. */}
      <div className="surface overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-card">Employé</TableHead>
              <TableHead>Accès</TableHead>
              {cols.map((a) => <TableHead key={a} className="text-center">{actionLabels[a] ?? a}</TableHead>)}
              {cols.length === 0 && <TableHead>Capacités</TableHead>}
              {showPipeline && <TableHead className="text-center">Voit le pipeline</TableHead>}
              {showPipeline && <TableHead className="text-center">Tient le cadenas</TableHead>}
              {module === MODULE_ANNUAIRES && <TableHead>Annuaires ouverts</TableHead>}
              <TableHead>Portée</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((u) => {
              const r = rows[u.id];
              if (!r) return null;
              const custom = r.mode === "CUSTOM";
              return (
                <TableRow key={u.id}>
                  <TableCell className="sticky left-0 z-10 min-w-[8.5rem] max-w-[11rem] bg-card sm:max-w-none">
                    <div className="font-medium">{u.name}</div>
                    <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{u.role} · défaut : {r.roleSummary}</div>
                  </TableCell>
                  <TableCell>
                    <Select value={r.mode} onChange={(e) => update(u.id, { mode: e.target.value as UserModuleState["mode"] })} className="h-10 w-32 text-xs sm:h-8 sm:w-28">
                      <option value="DEFAULT">Par défaut</option>
                      <option value="CUSTOM">Personnalisé</option>
                      <option value="BLOCKED">Bloqué</option>
                    </Select>
                  </TableCell>
                  {cols.map((a) => (
                    <TableCell key={a} className="text-center">
                      <input
                        type="checkbox"
                        checked={custom ? Boolean(r.actions[a]) : false}
                        disabled={!custom}
                        onChange={(e) => update(u.id, { actions: { ...r.actions, [a]: e.target.checked } })}
                        className="h-5 w-5 rounded border-input disabled:opacity-30 sm:h-4 sm:w-4"
                      />
                    </TableCell>
                  ))}
                  {cols.length === 0 && (
                    <TableCell className="text-xs text-muted-foreground">Consultation seule</TableCell>
                  )}
                  {showPipeline && (() => {
                    const p = pipeRows[u.id] ?? { view: false, manage: false, viewViaRole: false, manageViaRole: false };
                    // Tenir le cadenas IMPLIQUE de voir : on n'ouvre pas ce qu'on ne voit pas.
                    const voit = p.view || p.manage || p.viewViaRole || p.manageViaRole;
                    const voitFige = p.viewViaRole || p.manageViaRole || p.manage;
                    return (
                      <>
                        <TableCell className="text-center">
                          <input
                            type="checkbox"
                            checked={voit}
                            disabled={voitFige}
                            title={
                              p.viewViaRole || p.manageViaRole
                                ? "Accordé par le RÔLE — se retire dans Administration › Réglages › Pipeline réglementaire."
                                : p.manage
                                  ? "Tenir le cadenas implique de voir : on n'ouvre pas un dossier qu'on ne voit pas."
                                  : "Voir les dossiers verrouillés, ici et partout ailleurs (recherche, sélecteurs, assistant)."
                            }
                            onChange={(e) => setPipe(u.id, { view: e.target.checked })}
                            className="h-5 w-5 rounded border-input disabled:opacity-40 sm:h-4 sm:w-4"
                          />
                        </TableCell>
                        <TableCell className="text-center">
                          <input
                            type="checkbox"
                            checked={p.manage || p.manageViaRole}
                            disabled={p.manageViaRole}
                            title={
                              p.manageViaRole
                                ? "Accordé par le RÔLE — se retire dans Administration › Réglages › Pipeline réglementaire."
                                : "Ouvrir un dossier le rend visible de TOUTE l'entreprise, et cela ne se reprend pas."
                            }
                            onChange={(e) => setPipe(u.id, { manage: e.target.checked })}
                            className="h-5 w-5 rounded border-input disabled:opacity-40 sm:h-4 sm:w-4"
                          />
                        </TableCell>
                      </>
                    );
                  })()}
                  {module === MODULE_ANNUAIRES && (
                    <TableCell>
                      <AnnuairesCoches
                        prefixe={`sect_${u.id}`}
                        sections={r.sections ?? []}
                        actif={custom}
                        compact
                        onChange={(sections) => update(u.id, { sections })}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    {module === "DRIVE" || module === "DOSSIERS" ? (
                      <span className="text-xs text-muted-foreground" title="Confidentialité stricte : l'utilisateur ne voit que ses propres fichiers / sujets et ceux qu'on lui a partagés ou confiés.">Privé (assignées)</span>
                    ) : spec?.rowScoped ? (
                      <Select value={r.scope} disabled={!custom} onChange={(e) => update(u.id, { scope: e.target.value as "ALL" | "ASSIGNED" })} className="h-10 w-40 text-xs sm:h-8 sm:w-36">
                        <option value="ALL">Toutes les lignes</option>
                        <option value="ASSIGNED">Lignes assignées</option>
                      </Select>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-6 text-muted-foreground">
          <Badge tone="neutral" dot={false}>Par défaut</Badge> droits du rôle ·
          <Badge tone="info" dot={false}>Personnalisé</Badge> droits choisis ·
          <Badge tone="danger" dot={false}>Bloqué</Badge> module masqué. « Voir » est implicite (sauf Bloqué).
        </p>
        <Button type="submit" disabled={saving} className="w-full shrink-0 sm:w-auto">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4 text-success" /> : null}
          {saved ? "Enregistré" : "Enregistrer ce module"}
        </Button>
      </div>
    </form>
  );
}
