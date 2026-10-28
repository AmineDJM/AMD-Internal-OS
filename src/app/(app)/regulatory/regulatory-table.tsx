"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Filter, Columns3, Lock, LockOpen, FileSpreadsheet, Maximize2, Minimize2 } from "lucide-react";
import { StatusBadge } from "@/components/shared/status-badge";
import { PRIORITY, REGULATORY_STATUS, REGULATORY_CATEGORY, MANUFACTURING_STATUS } from "@/lib/labels";
import { formatDate, daysUntil } from "@/lib/utils";
import { setRegulatoryPriority, setRegulatoryResponsible, setRegulatoryClassification, setRegulatoryLock, unlockAllRegulatory } from "@/lib/actions/regulatory-actions";
import { visibleStages, defaultStage, type RegStage } from "@/lib/regulatory/stage";
import { dossierReceivedLabel, dossierReceivedOptions, DOSSIER_RECEIVED_HINT, DOSSIER_RECEIVED_YES } from "@/lib/regulatory/dossier-received";
import { setFocusMode, useFocusState } from "@/components/layout/focus-mode";
import { PartagerButton } from "@/components/shared/partager-button";
import { COLONNES_REGULATORY, colonnesVisibles, type CleColonneRegulatory } from "@/lib/vues/colonnes-regulatory";
import { Table } from "@/components/ui/table";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import type { ActionResult } from "@/lib/actions/types";
import { sansBloquer } from "@/lib/journal";

export interface RegulatoryRow {
  id: string;
  reference: string;
  dci: string;
  brandName: string;
  dosage: string;
  form: string;
  /** Conditionnement (« B/30 ») : à dosage égal, c'est lui qui distingue deux dossiers. */
  packaging: string;
  therapeuticClass: string;
  therapeuticSegments: string[];
  companyId: string;
  companyName: string;
  /** PROJET BD — le classement stratégique, vide quand le dossier n'est rattaché à aucun. */
  bdProjectId: string;
  bdProjectName: string;
  supplier: string;
  category: string;
  /** Niveau industriel qui FAIT FOI (variation obtenue prioritaire sur la déclaration). */
  manufacturingStatus: string;
  /** D'où vient ce niveau : « DECLARED » (fiche) ou « VARIATION » (décision obtenue). */
  manufacturingSource: string;
  /** Variation déposée et en attente de décision, le cas échéant. */
  manufacturingPending: string | null;
  status: string;
  priority: string;
  /** Dossier VERROUILLÉ : invisible pour l'équipe. Seul le Super Admin en voit un. */
  isLocked: boolean;
  responsible: string;
  /** Identifiant de la personne chargée du dossier — le menu déroulant travaille dessus. */
  responsibleId: string;
  assistant: string;
  targetSubmissionDate: string | null;
  targetDate: string | null;
  progress: number;
  stepsDone: number;
  stepsTotal: number;
  stage: RegStage;
  /**
   * LE DOSSIER CTD A-T-IL ÉTÉ REÇU ? Constaté sur le fait — une archive téléversée dans le
   * processus d'enregistrement —, jamais coché à la main. Voir `regulatory/dossier-received.ts`.
   */
  dossierReceived: boolean;
}

const lbl = (m: Record<string, unknown>, v: string): string => {
  const e = m[v];
  return (typeof e === "string" ? e : (e as { label?: string })?.label) ?? v;
};
const PRIORITY_OPTS = Object.keys(PRIORITY).map((v) => ({ value: v, label: lbl(PRIORITY as never, v) }));
const STATUS_OPTS = Object.keys(REGULATORY_STATUS).map((v) => ({ value: v, label: lbl(REGULATORY_STATUS as never, v) }));
const CATEGORY_OPTS = Object.keys(REGULATORY_CATEGORY).map((v) => ({ value: v, label: lbl(REGULATORY_CATEGORY as never, v) }));
const STAGE_OPTS = Object.keys(MANUFACTURING_STATUS).map((v) => ({ value: v, label: MANUFACTURING_STATUS[v] }));

type Comportement = {
  text: (r: RegulatoryRow) => string; // valeur texte (recherche + filtre + tri)
  raw?: (r: RegulatoryRow) => string; // valeur brute pour un filtre « select »
  options?: { value: string; label: string }[]; // filtre déroulant façon Excel
  /** Colonne dont les choix ne sont connus qu'à l'exécution (les personnes assignables). */
  dynamic?: "people" | "companies" | "segments" | "projects";
};

type Col = Comportement & { key: string; header: string };

/**
 * LE COMPORTEMENT DE CHAQUE COLONNE — ce que cet écran sait faire d'elle.
 *
 * L'ORDRE et les EN-TÊTES ne vivent PAS ici : ils sont dans `lib/regulatory/colonnes.ts`, que
 * l'écran ET Adam lisent. Deux listes de colonnes divergeraient à la première ajoutée — le
 * tableau montrerait « Projet » et Adam répondrait « colonne inconnue » (§118.5).
 *
 * `Record<CleColonneRegulatory, …>` : ajouter une colonne au catalogue sans lui donner de
 * comportement ici fait échouer le TYPECHECK, pas l'écran.
 *
 * TITRES voulus par le métier : « Statut » = importation / packaging / full process (la
 * profondeur industrielle), « Niveau de process » = pré-soumission / déposé / … (l'avancement
 * de la procédure).
 */
const COMPORTEMENTS: Record<CleColonneRegulatory, Comportement> = {
  reference: { text: (r) => r.reference },
  dci: { text: (r) => `${r.dci} ${r.brandName}` },
  dosage: { text: (r) => [r.dosage, r.form].filter(Boolean).join(" · ") },
  packaging: { text: (r) => r.packaging },
  therapeuticClass: { text: (r) => r.therapeuticClass },
  company: { text: (r) => r.companyName, raw: (r) => r.companyId || "—", dynamic: "companies" },
  // « Projet » — le classement stratégique nommé dans Business Development.
  project: { text: (r) => r.bdProjectName, raw: (r) => r.bdProjectId || "—", dynamic: "projects" },
  segments: { text: (r) => r.therapeuticSegments.join(", "), dynamic: "segments" },
  category: { text: (r) => lbl(REGULATORY_CATEGORY as never, r.category), raw: (r) => r.category, options: CATEGORY_OPTS },
  supplier: { text: (r) => r.supplier },
  manufacturingStatus: {
    text: (r) => MANUFACTURING_STATUS[r.manufacturingStatus] ?? r.manufacturingStatus,
    raw: (r) => r.manufacturingStatus, options: STAGE_OPTS,
  },
  priority: { text: (r) => lbl(PRIORITY as never, r.priority), raw: (r) => r.priority, options: PRIORITY_OPTS },
  status: { text: (r) => lbl(REGULATORY_STATUS as never, r.status), raw: (r) => r.status, options: STATUS_OPTS },
  // « Chargé du dossier » : la personne qui le porte. Modifiable ici même — c'est la question
  // qu'on se pose en balayant la liste, pas une fois entré dans la fiche.
  responsible: { text: (r) => r.responsible, raw: (r) => r.responsibleId || "—", dynamic: "people" },
  // « DOSSIER REÇU » — Yes / No, non modifiable : elle répond au FAIT (une archive CTD
  // téléversée), pas à ce que quelqu'un pense. Une case à cocher aurait dérivé dès le premier
  // « je coche en attendant l'envoi promis ».
  dossierReceived: {
    text: (r) => dossierReceivedLabel(r.dossierReceived),
    raw: (r) => dossierReceivedLabel(r.dossierReceived),
    options: dossierReceivedOptions(),
  },
  targetSubmissionDate: { text: (r) => r.targetSubmissionDate ?? "" },
  targetDate: { text: (r) => r.targetDate ?? "" },
};

/** Toutes les colonnes du catalogue, munies de leur comportement. */
const COLS: Col[] = COLONNES_REGULATORY.map((c) => ({ key: c.key, header: c.header, ...COMPORTEMENTS[c.key] }));

/** Préférence LOCALE de colonnes masquées (par navigateur) — clé de stockage. */
const HIDDEN_COLS_KEY = "amd-reg-hidden-cols";

/** Préférence « pleine largeur » du tableau — treize colonnes tiennent mal en 1400 px. */
const WIDE_KEY = "amd-reg-wide";

/** Teinte de la priorité (Critique = rouge, Haute = ambre, Moyenne = bleu, Basse = neutre). */
const PRIORITY_CLASS: Record<string, string> = {
  CRITICAL: "border-red-400 bg-red-50 text-red-700 dark:border-red-500/50 dark:bg-red-500/15 dark:text-red-300",
  HIGH: "border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-300",
  MEDIUM: "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/50 dark:bg-blue-500/15 dark:text-blue-300",
  LOW: "border-input bg-background text-muted-foreground",
};

export interface AssignableUser {
  id: string;
  name: string;
  role: string;
}

export function RegulatoryTable({
  rows,
  canEditPriority = false,
  canAssign = false,
  canLock = false,
  canSetStructural = false,
  assignableUsers = [],
  companies = [],
  segments = [],
  projects = [],
  colonnesMasquees = [],
  stageTabs = true,
  crossExport = null,
}: {
  rows: RegulatoryRow[];
  /** Entités du groupe — le menu « Entité » de la colonne. */
  companies?: { id: string; name: string }[];
  /** Segments thérapeutiques proposés par le menu « Segments » (liste effective, admin ou défaut). */
  segments?: string[];
  /** Les PROJETS BD nommés par la direction — le menu de la colonne « Projet ». */
  projects?: { id: string; name: string }[];
  /**
   * COLONNES RETIRÉES PAR LA MAISON — réglage de plateforme, pas préférence d'écran.
   *
   * Il se CUMULE avec la préférence locale au navigateur : le réglage retire la colonne du
   * tableau (et du menu « Colonnes », sans quoi on la rallumerait sans effet), la préférence
   * n'agit que sur ce qui reste. Voir `lib/regulatory/colonnes.ts`.
   */
  colonnesMasquees?: readonly string[];
  canEditPriority?: boolean;
  canAssign?: boolean;
  canLock?: boolean;
  /** Les TROIS champs réservés au Super Admin : statut de fabrication, chargé du dossier, entité.
   *  Le serveur les revérifie ; ici on évite simplement d'offrir un geste qui sera refusé. */
  canSetStructural?: boolean;
  assignableUsers?: AssignableUser[];
  /**
   * LES ONGLETS D'ÉTAPE — À TRAITER / TERMINÉ. Vrais sur le suivi des dossiers, où le tri par
   * étape EST la lecture de l'écran. FAUX sur le pipeline, et il fallait qu'ils le soient :
   * ces onglets excluent volontairement l'étape « pipeline », si bien que la table filtrait sur
   * « À traiter » des lignes qui sont toutes « pipeline » — 68 dossiers verrouillés annoncés en
   * haut, et un tableau vide en dessous. Sans onglets, la table montre ce qu'on lui donne.
   */
  stageTabs?: boolean;
  /**
   * L'AUTRE VOLET, quand il y en a un — le pipeline vu depuis le suivi, le suivi vu depuis le
   * pipeline. Les deux écrans montrent les mêmes objets sous deux angles : exporter l'un sans
   * PROPOSER l'autre sortait la moitié du portefeuille sans que rien ne le dise, et l'on
   * recollait deux classeurs à la main.
   */
  crossExport?: { label: string; ids: string[] } | null;
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  // Les colonnes visibles dépendent du verrou : sans lui, le pipeline serait toujours vide.
  const stages = React.useMemo(() => (stageTabs ? visibleStages(canLock) : []), [canLock, stageTabs]);
  const pipelineCount = React.useMemo(() => rows.filter((r) => r.stage === "pipeline").length, [rows]);
  const [stage, setStage] = React.useState<RegStage>(() => defaultStage(canLock, pipelineCount));
  const [filters, setFilters] = React.useState<Record<string, string>>({});
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [assignError, setAssignError] = React.useState<string | null>(null);
  // Une RÉSERVE, pas une erreur : le dossier a bien été confié, mais la personne ne le verra pas
  // encore (dossier verrouillé). Le taire laisserait croire qu'elle y a accès.
  const [assignNotice, setAssignNotice] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState(false);
  // Le plein écran est global (classe sur <html>) : on le SUIT, on ne le duplique pas — sortir
  // par Échap ou par le bouton flottant doit remettre ce bouton-ci dans le bon état.
  const focused = useFocusState();
  // PLEINE LARGEUR : le plafond de 1400 px protège la LECTURE d'un texte, pas celle d'un
  // tableau. On le relève pour cet écran, et pour lui seul — la variable est reposée en
  // quittant la page, sinon un formulaire hériterait d'une largeur faite pour des colonnes.
  const [wide, setWide] = React.useState(false);
  React.useEffect(() => {
    const saved = window.localStorage.getItem(WIDE_KEY) === "1";
    setWide(saved);
  }, []);
  React.useEffect(() => {
    const root = document.documentElement;
    if (wide) root.style.setProperty("--shell-max", "100%");
    else root.style.removeProperty("--shell-max");
    return () => { root.style.removeProperty("--shell-max"); };
  }, [wide]);
  const toggleWide = () => {
    const next = !wide;
    setWide(next);
    try { window.localStorage.setItem(WIDE_KEY, next ? "1" : "0"); } catch { /* refusé : sans mémoire */ }
  };
  // Colonnes masquées : préférence PAR NAVIGATEUR, chargée après montage (pas de désaccord
  // d'hydratation) — tout est visible par défaut.
  const [hiddenCols, setHiddenCols] = React.useState<string[]>([]);
  const [colsOpen, setColsOpen] = React.useState(false);
  const colsRef = React.useRef<HTMLDivElement>(null);
  // Le petit menu « qu'exporte-t-on ? », ouvert seulement quand l'autre volet existe.
  const [askExport, setAskExport] = React.useState(false);
  const exportRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HIDDEN_COLS_KEY);
      if (!raw) return;
      const arr: unknown = JSON.parse(raw);
      if (Array.isArray(arr)) setHiddenCols(arr.filter((k): k is string => typeof k === "string" && COLS.some((c) => c.key === k)));
    } catch {
      /* préférence illisible → tout visible */
    }
  }, []);

  React.useEffect(() => {
    if (!colsOpen) return;
    const onClick = (e: MouseEvent) => {
      if (colsRef.current && !colsRef.current.contains(e.target as Node)) setColsOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [colsOpen]);

  React.useEffect(() => {
    if (!askExport) return;
    const onClick = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setAskExport(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [askExport]);

  const toggleCol = (key: string) => {
    const hiding = !hiddenCols.includes(key);
    const next = hiding ? [...hiddenCols, key] : hiddenCols.filter((k) => k !== key);
    if (next.length >= colsDuTableau.length) return; // toujours au moins une colonne visible
    setHiddenCols(next);
    try { window.localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify(next)); } catch { /* stockage local indisponible */ }
    // Masquer une colonne retire aussi son filtre : un filtre invisible qui vide la liste
    // serait incompréhensible.
    if (hiding) setFilters((f) => ({ ...f, [key]: "" }));
  };

  // LE RÉGLAGE DE LA MAISON D'ABORD, la préférence de l'écran ensuite. Une colonne retirée par
  // le réglage ne doit pas apparaître dans le menu « Colonnes » : on l'y rallumerait sans effet,
  // et un bouton qui ne fait rien coûte plus cher qu'un bouton absent.
  const colsDuTableau = React.useMemo(() => {
    const gardees = new Set(colonnesVisibles(colonnesMasquees).map((c) => c.key));
    return COLS.filter((c) => gardees.has(c.key));
  }, [colonnesMasquees]);
  const visibleCols = colsDuTableau.filter((c) => !hiddenCols.includes(c.key));
  // Compté sur TOUTES les lignes, pas sur celles qui passent le filtre courant : un dossier
  // caché par un filtre reste caché à l'équipe, et c'est ce total-là qui compte.
  const lockedCount = rows.filter((r) => r.isLocked).length;

  /**
   * Les personnes assignables ne sont connues qu'au chargement de la page. Le filtre de la
   * colonne « Chargé du dossier » propose donc CES personnes-là — plus « Non attribué », qui
   * est la question la plus utile devant une liste de dossiers : lesquels n'ont personne ?
   */
  const peopleOpts = React.useMemo(
    () => [
      { value: "—", label: "Non attribué" },
      ...assignableUsers.map((u) => ({ value: u.id, label: u.name })),
    ],
    [assignableUsers],
  );
  const optsFor = React.useCallback(
    (c: Col) => (
      c.dynamic === "people" ? peopleOpts
      : c.dynamic === "companies" ? [{ value: "—", label: "Sans entité" }, ...companies.map((x) => ({ value: x.id, label: x.name }))]
      // Un produit porte PLUSIEURS segments : filtrer sur une valeur exacte n'aurait aucun sens,
      // la recherche libre de la colonne fait le travail.
      : c.dynamic === "segments" ? undefined
      : c.options
    ),
    [peopleOpts, companies],
  );

  const counts = React.useMemo(() => ({
    pipeline: pipelineCount,
    todo: rows.filter((r) => r.stage === "todo").length,
    done: rows.filter((r) => r.stage === "done").length,
  }), [rows, pipelineCount]);

  const filtered = React.useMemo(() => rows.filter((r) => {
    // Sans onglets, aucune étape n'est sélectionnée : tout ce qu'on reçoit s'affiche.
    if (stageTabs && r.stage !== stage) return false;
    for (const c of COLS) {
      const f = filters[c.key]?.trim();
      if (!f) continue;
      if (optsFor(c)) { if ((c.raw?.(r) ?? "") !== f) return false; }
      else if (!c.text(r).toLowerCase().includes(f.toLowerCase())) return false;
    }
    return true;
  }), [rows, stage, stageTabs, filters, optsFor]);

  const anyFilter = Object.values(filters).some((v) => v && v.trim());

  /**
   * Un geste de ligne : il ne peut plus rester figé (une levée se dit), un refus du serveur
   * s'affiche, et la liste est relue dans tous les cas — comme avant.
   */
  async function geste(cle: string, fn: () => Promise<ActionResult>, repli: string): Promise<ActionResult | null> {
    setBusyId(cle);
    setAssignError(null);
    try {
      const res = await fn();
      if (!res.ok) setAssignError(res.error ?? repli);
      return res;
    } catch {
      setAssignError(actionFailureMessage("THROWN"));
      return null;
    } finally {
      setBusyId(null);
      rafraichir();
    }
  }

  async function changePriority(id: string, priority: string) {
    const fd = new FormData(); fd.set("id", id); fd.set("priority", priority);
    await geste(id, () => setRegulatoryPriority(fd), "La priorité n'a pas été modifiée.");
  }

  /**
   * EXPORTER CE QUE L'ON VOIT. On envoie les identifiants des lignes affichées — onglet et
   * filtres compris : un classeur qui ne correspond pas à l'écran d'où il sort circule ensuite
   * sans que personne ne sache ce qu'il contient. Le serveur recroise malgré tout la portée.
   */
  async function exportXlsx(withCross: boolean) {
    setExporting(true);
    setAssignError(null);
    try {
      // CE QU'ON VOIT, PLUS — SI ON L'A DEMANDÉ — L'AUTRE VOLET. Les deux écrans montrent les
      // mêmes objets sous deux angles ; on exportait donc la moitié du portefeuille sans que
      // rien ne le dise, et l'on recollait deux classeurs à la main.
      const ids = withCross && crossExport
        ? [...new Set([...filtered.map((r) => r.id), ...crossExport.ids])]
        : filtered.map((r) => r.id);
      const res = await fetch("/api/regulatory/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error((await res.json().catch(sansBloquer("regulatory-table.exportXlsx.json", {}))).error ?? "Export impossible.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "regulatory.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : "Export impossible.");
    } finally {
      setExporting(false);
      setAskExport(false);
    }
  }

  /** Ouvrir ou fermer le cadenas d'un dossier (Super Admin). */
  async function toggleLock(id: string, locked: boolean) {
    const fd = new FormData(); fd.set("id", id); fd.set("locked", locked ? "1" : "0");
    await geste(id, () => setRegulatoryLock(fd), "Impossible de modifier le verrou.");
  }

  /** Ouvrir le cadenas sur tout ce qui est verrouillé — un portefeuille se publie d'un geste. */
  async function unlockAll() {
    await geste("*", () => unlockAllRegulatory(), "Impossible de déverrouiller.");
  }

  /** Confier le dossier à quelqu'un. Un refus du serveur se DIT — sinon le menu revient
   *  silencieusement en arrière et personne ne comprend pourquoi. */
  /** Entité et segments se corrigent EN LISANT la liste — c'est là qu'on s'en aperçoit. */
  async function changeClassification(id: string, fields: { companyId?: string; segments?: string[]; bdProjectId?: string }) {
    const fd = new FormData();
    fd.set("id", id);
    if (fields.companyId !== undefined) fd.set("companyId", fields.companyId);
    if (fields.segments !== undefined) for (const v of fields.segments) fd.append("segments", v);
    // Un tableau vide n'enverrait aucune clé : sans ce marqueur, « retirer tous les segments »
    // serait indiscernable de « ne pas y toucher ».
    if (fields.segments !== undefined && fields.segments.length === 0) fd.append("segments", "");
    // Chaîne VIDE = « sans projet », et c'est un geste voulu : `formData.has` distingue déjà
    // « on n'y touche pas » de « on le retire », donc la clé part telle quelle.
    if (fields.bdProjectId !== undefined) fd.set("bdProjectId", fields.bdProjectId);
    await geste(id, () => setRegulatoryClassification(fd), "Modification impossible.");
  }

  async function changeResponsible(id: string, responsibleId: string) {
    const fd = new FormData(); fd.set("id", id); fd.set("responsibleId", responsibleId);
    const res = await geste(id, () => setRegulatoryResponsible(fd), "Impossible de confier ce dossier.");
    if (res?.ok) setAssignNotice(res.message ?? null);
  }

  /** Le filtre d'une colonne — rendu dans l'en-tête au bureau, dans le panneau « Filtrer » au téléphone. */
  function filterControl(c: Col, size: string): React.ReactNode {
    const opts = optsFor(c);
    return opts ? (
      <select value={filters[c.key] ?? ""} onChange={(e) => setFilters((f) => ({ ...f, [c.key]: e.target.value }))}
        className={`${size} rounded border border-input bg-background px-1 text-xs font-normal normal-case tracking-normal text-foreground`}>
        <option value="">Tous</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    ) : (
      <input value={filters[c.key] ?? ""} onChange={(e) => setFilters((f) => ({ ...f, [c.key]: e.target.value }))} placeholder="Filtrer…"
        className={`${size} rounded border border-input bg-background px-1.5 text-xs font-normal normal-case tracking-normal text-foreground`} />
    );
  }

  /** Cellule d'une ligne pour une colonne — même rendu qu'avant, mais pilotable colonne par colonne. */
  function cellFor(key: string, r: RegulatoryRow): React.ReactNode {
    switch (key) {
      case "reference":
        // Le cadenas vit à côté de la référence : c'est l'identité du dossier qui est
        // confidentielle, pas une de ses propriétés. Personne d'autre que le Super Admin ne
        // voit cette ligne — le bouton ne s'affiche donc que pour lui.
        return (
          <td key={key} className="whitespace-nowrap px-3 py-2 font-mono text-xs font-medium">
            <span className="inline-flex items-center gap-1.5">
              {r.reference}
              {canLock ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void toggleLock(r.id, !r.isLocked); }}
                  disabled={busyId === r.id}
                  title={r.isLocked ? "Verrouillé — invisible pour l'équipe. Cliquer pour ouvrir." : "Visible par l'équipe. Cliquer pour verrouiller."}
                  aria-label={r.isLocked ? "Déverrouiller le dossier" : "Verrouiller le dossier"}
                  className={`rounded p-2.5 sm:p-0.5 ${r.isLocked ? "text-warning hover:bg-warning/10" : "text-muted-foreground/40 hover:bg-secondary hover:text-foreground"}`}
                >
                  {r.isLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                </button>
              ) : null}
              {/* PARTAGER LE DOSSIER — même geste dans « Suivi de dossiers » et dans « Pipeline »,
                  qui rendent ce même tableau. Le composant arrête lui-même la bulle : sans cela,
                  cocher un destinataire naviguerait vers la fiche, panneau ouvert. */}
              <PartagerButton
                iconOnly variant="ghost"
                refType="REGULATORY_PRODUCT" refId={r.id}
                refLabel={`${r.reference} — ${r.dci}${r.brandName ? ` (${r.brandName})` : ""}`}
                href={`/regulatory/${r.id}`}
              />
            </span>
          </td>
        );
      case "dci":
        // Une seule enveloppe : en carte mobile, la cellule est une rangée flex (intitulé | valeur).
        return <td key={key} className="px-3 py-2"><div><p className="font-medium">{r.dci}</p>{r.brandName && <p className="text-xs text-muted-foreground">{r.brandName}</p>}</div></td>;
      case "dosage":
        return <td key={key} className="px-3 py-2 text-muted-foreground">{[r.dosage, r.form].filter(Boolean).join(" · ") || "—"}</td>;
      case "packaging":
        return <td key={key} className="whitespace-nowrap px-3 py-2 text-muted-foreground">{r.packaging || "—"}</td>;
      case "company":
        return (
          <td key={key} className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            {/* L'ENTITÉ décide de qui voit le dossier : la changer, c'est le déplacer d'une
                société à une autre. Réservée au Super Admin. */}
            {canSetStructural ? (
              <select
                value={r.companyId}
                onChange={(e) => changeClassification(r.id, { companyId: e.target.value })}
                disabled={busyId === r.id}
                aria-label="Entité du dossier"
                className={`h-9 max-w-[10rem] rounded border px-1 text-xs sm:h-7 ${r.companyId ? "border-input bg-background" : "border-warning/50 bg-warning/5 text-muted-foreground"}`}
              >
                <option value="">— Sans entité —</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : r.companyName || "—"}
          </td>
        );
      case "project":
        return (
          <td key={key} className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            {/* LE PROJET est une ÉTIQUETTE de classement — il n'ouvre ni ne ferme aucun accès,
                contrairement à l'entité. Il suit donc le droit de MODIFIER le dossier, comme
                les segments, et non le privilège structurel. Le serveur le revérifie. */}
            {canAssign && projects.length > 0 ? (
              <select
                value={r.bdProjectId}
                onChange={(e) => changeClassification(r.id, { bdProjectId: e.target.value })}
                disabled={busyId === r.id}
                aria-label="Projet BD du dossier"
                className="h-9 max-w-[11rem] rounded border border-input bg-background px-1 text-xs sm:h-7"
              >
                <option value="">— Sans projet —</option>
                {projects.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
              </select>
            ) : (r.bdProjectName || "—")}
          </td>
        );
      case "segments":
        return (
          <td key={key} className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            {canAssign ? (
              <SegmentPicker
                all={segments}
                selected={r.therapeuticSegments}
                busy={busyId === r.id}
                onChange={(next) => changeClassification(r.id, { segments: next })}
              />
            ) : (r.therapeuticSegments.join(", ") || "—")}
          </td>
        );
      case "therapeuticClass":
        return <td key={key} className="px-3 py-2">{r.therapeuticClass || "—"}</td>;
      case "category":
        return <td key={key} className="px-3 py-2"><StatusBadge map={REGULATORY_CATEGORY} value={r.category} dot={false} /></td>;
      case "supplier":
        return <td key={key} className="px-3 py-2">{r.supplier || "—"}</td>;
      case "manufacturingStatus":
        return <td key={key} className="px-3 py-2"><StageCell row={r} /></td>;
      case "priority":
        return (
          <td key={key} className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            {canEditPriority ? (
              <span className="inline-flex items-center gap-1">
                <select value={r.priority} onChange={(e) => changePriority(r.id, e.target.value)} disabled={busyId === r.id}
                  className={`h-9 rounded border px-1 text-xs font-medium sm:h-7 ${PRIORITY_CLASS[r.priority] ?? "border-input bg-background"}`}>
                  {PRIORITY_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {busyId === r.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </span>
            ) : <StatusBadge map={PRIORITY} value={r.priority} />}
          </td>
        );
      case "status":
        return <td key={key} className="px-3 py-2"><StatusBadge map={REGULATORY_STATUS} value={r.status} /></td>;
      case "responsible":
        // Le menu déroulant vit DANS la ligne : il faut donc arrêter le clic, sinon choisir
        // quelqu'un ouvrirait la fiche du dossier au lieu de le lui confier.
        return (
          <td key={key} className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            {/* CONFIER UN DOSSIER est un engagement pris au nom de quelqu'un : Super Admin seul. */}
            {canSetStructural ? (
              <span className="inline-flex items-center gap-1">
                <select
                  value={r.responsibleId}
                  onChange={(e) => changeResponsible(r.id, e.target.value)}
                  disabled={busyId === r.id}
                  aria-label="Personne chargée du dossier"
                  className={`h-9 max-w-[11rem] rounded border px-1 text-xs sm:h-7 ${r.responsibleId ? "border-input bg-background" : "border-warning/50 bg-warning/5 text-muted-foreground"}`}
                >
                  <option value="">— Non attribué —</option>
                  {assignableUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                {busyId === r.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </span>
            ) : r.responsible || "—"}
          </td>
        );
      case "dossierReceived": {
        // Pas de menu, pas de case : une PASTILLE qui se lit. Le titre dit pourquoi elle ne se
        // modifie pas — sans quoi on cherche le bouton, on ne le trouve pas, et l'on croit à un
        // droit manquant.
        const recu = r.dossierReceived;
        return (
          <td key={key} className="px-3 py-2" title={DOSSIER_RECEIVED_HINT}>
            <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${
              recu
                ? "border-success/40 bg-success/10 text-success"
                : "border-input bg-background text-muted-foreground"
            }`}>
              {dossierReceivedLabel(recu)}
            </span>
          </td>
        );
      }
      case "targetSubmissionDate":
        return <td key={key} className="px-3 py-2 text-muted-foreground">{r.targetSubmissionDate ? formatDate(r.targetSubmissionDate) : "—"}</td>;
      case "targetDate": {
        const d = r.targetDate ? daysUntil(r.targetDate) : null;
        return <td key={key} className={`px-3 py-2 ${d !== null && d < 0 ? "text-destructive" : ""}`}>{r.targetDate ? formatDate(r.targetDate) : "—"}</td>;
      }
      default:
        return <td key={key} className="px-3 py-2" />;
    }
  }

  return (
    <div className="space-y-3">
      {/* Onglets des 3 étapes + réglage des colonnes */}
      <div className="flex flex-wrap items-center gap-2">
        {stages.map((s) => (
          <button key={s.key} type="button" onClick={() => setStage(s.key)} title={s.hint}
            className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${stage === s.key ? "border-primary bg-primary/10 text-primary" : "border-input hover:bg-secondary"}`}>
            {s.label} <span className="ml-1 rounded-full bg-secondary px-1.5 text-xs">{counts[s.key]}</span>
          </button>
        ))}
        {/* `flex-wrap` + `min-w-0` : « Pleine largeur · Plein écran · Exporter · Colonnes » font
            380 px sur un écran de 375 — le dernier bouton sortait de l'écran. */}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {anyFilter && (
            <button type="button" onClick={() => setFilters({})} className="inline-flex items-center gap-1 rounded-lg border border-input px-2.5 py-2 text-xs text-muted-foreground hover:bg-secondary">
              <Filter className="h-3.5 w-3.5" /> Effacer les filtres
            </button>
          )}
          {/* PLEINE LARGEUR : relâche le plafond de lecture, sans rien masquer. */}
          <button
            type="button" onClick={toggleWide}
            title={wide ? "Revenir à la largeur de lecture" : "Étendre le tableau à toute la largeur"}
            aria-pressed={wide}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-2 text-xs transition-colors ${wide ? "border-primary/50 text-primary" : "border-input text-muted-foreground"} hover:bg-secondary`}
          >
            <Columns3 className="h-3.5 w-3.5" />
            {wide ? "Largeur de lecture" : "Pleine largeur"}
          </button>
          {/* PLEIN ÉCRAN, le vrai : en-tête ET barre latérale s'effacent — quarante colonnes ne
              se lisent pas à côté d'un menu. Le même geste que dans le Drive, partout. */}
          <button
            type="button" onClick={() => setFocusMode(!focused)}
            title={focused ? "Quitter le plein écran" : "Plein écran — masque le menu et l'en-tête"}
            aria-pressed={focused}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-2 text-xs transition-colors ${focused ? "border-primary/50 text-primary" : "border-input text-muted-foreground"} hover:bg-secondary`}
          >
            {focused ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {focused ? "Quitter" : "Plein écran"}
          </button>

          {/* EXPORTER — et, quand l'autre volet existe, DEMANDER s'il faut l'inclure. On ne
              décide pas à la place de la personne : parfois on veut le portefeuille entier,
              parfois seulement ce qu'on instruit. Sans la question, c'était toujours le second,
              et personne ne savait que l'autre moitié manquait. */}
          <div ref={exportRef} className="relative">
            <button
              type="button"
              onClick={() => (crossExport ? setAskExport((v) => !v) : void exportXlsx(false))}
              disabled={exporting}
              title={`Exporter les ${filtered.length} dossier(s) affiché(s) en Excel`}
              className="inline-flex items-center gap-1 rounded-lg border border-input px-2.5 py-2 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-60"
            >
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
              Exporter ({filtered.length})
            </button>
            {askExport && crossExport && (
              <div className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-border bg-popover p-3 shadow-md max-sm:fixed max-sm:inset-x-3 max-sm:w-auto">
                <p className="text-xs font-medium">Que faut-il exporter ?</p>
                <div className="mt-2 space-y-1.5">
                  <button
                    type="button" disabled={exporting} onClick={() => void exportXlsx(false)}
                    className="w-full rounded-md border border-input px-2.5 py-2 text-left text-xs hover:bg-secondary disabled:opacity-60"
                  >
                    <span className="font-medium">Cet écran seulement</span>
                    <span className="block text-muted-foreground">{filtered.length} dossier(s) affiché(s)</span>
                  </button>
                  <button
                    type="button" disabled={exporting} onClick={() => void exportXlsx(true)}
                    className="w-full rounded-md border border-primary/50 px-2.5 py-2 text-left text-xs text-primary hover:bg-primary/10 disabled:opacity-60"
                  >
                    <span className="font-medium">Inclure aussi {crossExport.label}</span>
                    <span className="block text-muted-foreground">
                      {filtered.length} + {crossExport.ids.length} dossier(s)
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Masquer / démasquer chaque colonne — préférence mémorisée par navigateur. */}
          <div ref={colsRef} className="relative">
            <button type="button" onClick={() => setColsOpen((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-2 text-xs transition-colors ${hiddenCols.length > 0 ? "border-primary/50 text-primary" : "border-input text-muted-foreground"} hover:bg-secondary`}>
              <Columns3 className="h-3.5 w-3.5" /> Colonnes{hiddenCols.length > 0 ? ` (${hiddenCols.length} masquée·s)` : ""}
            </button>
            {colsOpen && (
              <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-border bg-popover p-2 shadow-md max-sm:fixed max-sm:inset-x-3 max-sm:w-auto">
                <p className="px-1 pb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">Colonnes affichées</p>
                <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                  {colsDuTableau.map((c) => {
                    const visible = !hiddenCols.includes(c.key);
                    const lastVisible = visible && visibleCols.length === 1;
                    return (
                      <li key={c.key}>
                        <label className={`flex items-center gap-2 rounded px-1.5 py-2 text-sm sm:py-1 ${lastVisible ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-secondary"}`}>
                          <input type="checkbox" checked={visible} disabled={lastVisible} onChange={() => toggleCol(c.key)} className="h-3.5 w-3.5" />
                          {c.header}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Le Super Admin est le SEUL à voir ces dossiers : il doit donc savoir en permanence
          combien il en cache, sinon un portefeuille reste verrouillé des mois par oubli. */}
      {canLock && lockedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm">
          <p className="flex items-start gap-2 text-muted-foreground">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              <strong>{lockedCount} dossier{lockedCount > 1 ? "s" : ""} verrouillé{lockedCount > 1 ? "s" : ""}.</strong>{" "}
              Vous êtes seul à {lockedCount > 1 ? "les" : "le"} voir — l&apos;équipe, la Direction et
              l&apos;assistant IA ne {lockedCount > 1 ? "les" : "le"} trouvent nulle part. Ouvrez le
              cadenas d&apos;une ligne pour {lockedCount > 1 ? "la" : "le"} publier.
            </span>
          </p>
          <button
            type="button"
            onClick={() => void unlockAll()}
            disabled={busyId === "*"}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-secondary"
          >
            {busyId === "*" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LockOpen className="h-3.5 w-3.5" />}
            Tout déverrouiller
          </button>
        </div>
      )}

      {assignNotice && (
        <p className="rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning">{assignNotice}</p>
      )}
      {assignError && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{assignError}</p>
      )}

      <div className="surface overflow-x-auto">
        <Table className="min-w-[960px]">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              {visibleCols.map((c) => <th key={c.key} className="whitespace-nowrap px-3 py-2 font-medium">{c.header}</th>)}
            </tr>
            {/* Ligne de filtres façon Excel */}
            <tr className="border-b border-border">
              {visibleCols.map((c) => (
                <th key={c.key} className="px-2 py-1.5">
                  {(c.key === "targetDate" || c.key === "targetSubmissionDate") ? null : filterControl(c, "h-7 w-full")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={visibleCols.length} data-sans-etiquette className="px-3 py-8 text-center text-muted-foreground">Aucun dossier dans cette catégorie{anyFilter ? " (avec ces filtres)" : ""}.</td></tr>
            ) : filtered.map((r) => (
              <tr key={r.id} onClick={() => router.push(`/regulatory/${r.id}`)} className="cursor-pointer border-b border-border/60 hover:bg-secondary/40">
                {visibleCols.map((c) => cellFor(c.key, r))}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

/** Teinte du niveau : plus la fabrication est locale, plus la pastille est « verte ». */
const STAGE_CLASS: Record<string, string> = {
  IMPORTATION: "border-input bg-background text-muted-foreground",
  SECONDARY_PACKAGING: "border-blue-300 bg-blue-50 text-blue-700",
  PRIMARY_PACKAGING: "border-teal-300 bg-teal-50 text-teal-700",
  FULL_PROCESS: "border-emerald-400 bg-emerald-50 text-emerald-700",
};

/**
 * « STATUT » (vocabulaire métier) = niveau industriel d'un produit. La pastille montre le niveau
 * **qui fait foi** ; le petit texte dessous dit **d'où il vient** — c'est la question qu'on se
 * pose vraiment : est-ce une simple déclaration sur la fiche, ou une variation réellement
 * OBTENUE auprès de l'ANPP ? Une variation encore en attente est signalée sans jamais être
 * comptée comme acquise.
 */
function StageCell({ row }: { row: RegulatoryRow }) {
  const label = MANUFACTURING_STATUS[row.manufacturingStatus] ?? row.manufacturingStatus;
  const fromVariation = row.manufacturingSource === "VARIATION";
  return (
    <div className="space-y-0.5">
      <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${STAGE_CLASS[row.manufacturingStatus] ?? STAGE_CLASS.IMPORTATION}`}>
        {label}
      </span>
      <p className="text-[0.6875rem] text-muted-foreground">
        {fromVariation ? "variation obtenue" : "déclaré"}
        {row.manufacturingPending && (
          <>
            {" · "}
            <span className="text-warning">
              {MANUFACTURING_STATUS[row.manufacturingPending] ?? row.manufacturingPending} en cours
            </span>
          </>
        )}
      </p>
    </div>
  );
}


/**
 * PLUSIEURS SEGMENTS POUR UN MÊME PRODUIT.
 *
 * Un anti-émétique sert l'oncologie ET la gastro-entérologie : un menu à choix unique
 * obligerait à en sacrifier un, et c'est exactement l'information qu'on vient chercher. Le
 * panneau s'ouvre sur place, dans la ligne, pour ne pas faire quitter la liste — c'est en la
 * lisant qu'on s'aperçoit qu'un segment manque.
 */
function SegmentPicker({
  all, selected, busy, onChange,
}: { all: string[]; selected: string[]; busy: boolean; onChange: (next: string[]) => void }) {
  const [open, setOpen] = React.useState(false);
  const label = selected.length === 0 ? "— Aucun —" : selected.length <= 2 ? selected.join(", ") : `${selected.length} segments`;
  // Un segment retiré du référentiel mais encore posé sur un produit doit rester cochable, sinon
  // on ne pourrait plus le décocher : on l'ajoute donc en fin de liste.
  const options = [...all, ...selected.filter((s) => !all.includes(s))];

  return (
    <div className="relative">
      <button
        type="button" disabled={busy} onClick={() => setOpen((v) => !v)}
        title={selected.join(", ")}
        className={`h-9 max-w-[12rem] truncate rounded border px-1.5 text-xs sm:h-7 ${selected.length > 0 ? "border-input bg-background" : "border-warning/50 bg-warning/5 text-muted-foreground"}`}
      >
        {busy ? "…" : label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          {/* En carte mobile, le bouton est rangé à droite : le panneau s'ouvre vers la gauche. */}
          <div className="absolute right-0 top-full z-20 mt-1 max-h-64 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-left shadow-xl sm:left-0 sm:right-auto">
            {options.map((seg) => (
              <label key={seg} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-xs hover:bg-secondary sm:py-1">
                <input
                  type="checkbox" className="h-3.5 w-3.5 rounded border-input"
                  checked={selected.includes(seg)}
                  onChange={() => onChange(selected.includes(seg) ? selected.filter((x) => x !== seg) : [...selected, seg])}
                />
                {seg}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
