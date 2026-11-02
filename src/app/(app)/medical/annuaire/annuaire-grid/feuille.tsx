"use client";

/**
 * L'ANNUAIRE — la feuille (`AnnuaireGrid`) : recherche, vues, import, sélection, couleurs, rattachements.
 */
import * as React from "react";
import { Search, Upload, Loader2, FileSpreadsheet, Plus, Rows3, LayoutList, X, Trash2, RotateCcw, Columns3, Building2, Stethoscope } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeHeader } from "@/lib/medical/directory-sheet";
import { estARattacher, specialiteEstARattacher, type AnnuaireRow, type AnnuaireField, type CustomColumnVue } from "@/lib/medical/directory-grid";
import { importDirectorySheet, previewDirectorySheet, saveDirectoryCell, saveDirectoryCustomCell, deleteDirectoryDoctors, restaurerDirectoryDoctors, rattacherEtablissementsParNom, rattacherSpecialitesParNom, rattacherAutomatiquement } from "@/lib/actions/medical-directory-actions";
import { serviceDeLaSpecialite } from "@/lib/medical/etablissement-deduit";
import type { EtablissementOption } from "@/lib/annuaires/types";
import { colorerCellulesAnnuaire } from "@/lib/actions/annuaire-couleurs-actions";
import type { HeaderProposal, TargetColumn } from "@/lib/medical/directory-mapping";
import { cleCellule, type CouleurCellule } from "@/lib/grille/couleurs";
import type { Coord } from "@/lib/grille/selection";
import { useSelectionGrille } from "@/components/grille/use-selection";
import { BarreSelection, DockSelection } from "@/components/grille/barre-selection";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { ImportMappingSheet } from "../import-mapping-sheet";
import { InfoBulle } from "@/components/ui/info-bulle";
import { EntreeMenu, MenuPlus } from "../../menu-plus";
import { colonnesDeLaFeuille, valeurAffichee, type Edition, type ColonneVue, valeurBrute, SPECIALTY_LIST_ID } from "./colonnes";
import { GridTable } from "./grille-table";
import { AddDoctorRow } from "./ajout-ligne";
import { GestionColonnes } from "./gestion-colonnes";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { journal } from "@/lib/journal";

export function AnnuaireGrid({
  rows, etablissements, couleurs, customColumns, canEdit, canImport, canImportFile, canDelete, canManageColumns, specialties, directoryId, directoryName,
  titreParDefaut, exportHref = "/api/medical/annuaire/export", archives = false, colonnesMasquees = [], specialiteImposee = null,
}: {
  /** Les colonnes que cette vue ne montre pas (la spécialité dans l'annuaire D'UNE spécialité). */
  colonnesMasquees?: AnnuaireField[];
  /** L'annuaire d'une spécialité : une fiche ajoutée ici porte cette spécialité, sans qu'on la retape. */
  specialiteImposee?: string | null;
  /** Vue des fiches ARCHIVÉES : « Supprimer » devient « Restaurer » (archivage réversible). */
  archives?: boolean;
  rows: AnnuaireRow[];
  /** L'annuaire des établissements et leurs services — les choix des colonnes de lien (§118.172). */
  etablissements: EtablissementOption[];
  /** Les couleurs posées sur la feuille — `<id>:<colonne>` → clé de palette. */
  couleurs: Record<string, string>;
  /** Les colonnes propres à l'annuaire ouvert (vide pour l'annuaire général ou la vue « Tous »). */
  customColumns: CustomColumnVue[];
  canEdit: boolean; canImport: boolean; canDelete: boolean; specialties: string[];
  /**
   * IMPORTER UN FICHIER — distinct d'AJOUTER UNE LIGNE (`canImport`) depuis l'accès par annuaire
   * (§118.147). Un import crée des fiches de TOUT grade et les range dans les annuaires nommés :
   * c'est une opération de STRUCTURE, gardée par la Promotion médicale. Ajouter une fiche à la
   * main, lui, se fait dans l'annuaire que la personne tient — y compris celui qu'on lui a ouvert
   * depuis la console. Un seul drapeau pour les deux aurait montré « Importer » à qui l'action
   * refusera, ou retiré la ligne d'ajout à qui l'annuaire est ouvert.
   */
  canImportFile: boolean;
  /**
   * GÉRER LES COLONNES de l'annuaire nommé — la STRUCTURE, pas les lignes. Distinct de `canEdit`
   * depuis l'accès par annuaire (§118.147) : on peut s'être vu ouvrir la modification des fiches
   * depuis la console sans tenir la Promotion médicale, et l'action serveur qui crée une colonne
   * reste celle de ce module. Montrer le bouton à qui l'action refusera serait une porte vers un
   * refus.
   */
  canManageColumns: boolean;
  /**
   * L'ANNUAIRE OUVERT — `null` = l'annuaire général.
   *
   * Il MANQUAIT, et c'était tout le défaut : la grille ne savait pas dans quel annuaire elle
   * travaillait, l'import partait donc sans destination et atterrissait dans le général.
   */
  directoryId: string | null;
  directoryName: string;
  /** Le grade d'une fiche ajoutée depuis cette vue (l'onglet Pharmaciens ajoute un PHARMACIEN). */
  titreParDefaut?: string;
  exportHref?: string;
}) {
  // Le rafraîchissement est SUIVI : tant qu'il court, ce qu'on vient d'écrire reste affiché et fait
  // foi pour le geste suivant (§118.172).
  const { enCours: rafraichit, rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  // SÉLECTION DE LIGNES (cases) — un annuaire se nettoie par lots (doublons d'import, cabinet
  // fermé). Ligne par ligne, personne ne le fait : on garde alors des fiches fausses, pire
  // qu'absentes. Distincte de la sélection de CELLULES, qui sert à colorer et copier.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const toggleOne = React.useCallback((id: string, on: boolean) => {
    setSelected((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
  }, []);
  const toggleMany = React.useCallback((ids: string[], on: boolean) => {
    setSelected((p) => { const n = new Set(p); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });
  }, []);
  const [deleting, setDeleting] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [bySpecialty, setBySpecialty] = React.useState(false);
  /** La ligne d'ajout est-elle ouverte ? Son bouton est le geste principal de la barre (Direction, 07/10). */
  const [ajoutOuvert, setAjoutOuvert] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [colonnesOuvertes, setColonnesOuvertes] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  // Le fichier lu, en attente que la correspondance soit tranchée.
  const [pending, setPending] = React.useState<
    { file: File; proposals: HeaderProposal[]; targets: TargetColumn[]; rowCount: number } | null
  >(null);

  const masqueesCle = colonnesMasquees.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- la liste se compare par sa clé, pas par son identité
  const colonnes = React.useMemo(() => colonnesDeLaFeuille(customColumns, colonnesMasquees), [customColumns, masqueesCle]);

  // Chaque ligne, mise à plat une fois, pour une recherche qui porte sur ce qu'on VOIT
  // (« Professeur », « Alger », « Très haut »), pas sur les codes internes.
  const haystacks = React.useMemo(
    () => new Map(rows.map((r) => [r.id, normalizeHeader(colonnes.map((c) => valeurAffichee(r, c)).join(" "))])),
    [rows, colonnes],
  );
  const needle = normalizeHeader(q);
  const filtered = React.useMemo(
    () => (needle ? rows.filter((r) => (haystacks.get(r.id) ?? "").includes(needle)) : rows),
    [rows, needle, haystacks],
  );

  const groups = React.useMemo(() => {
    if (!bySpecialty) return null;
    const map = new Map<string, AnnuaireRow[]>();
    for (const r of filtered) {
      const key = (r.specialty ?? "").trim() || "Sans spécialité";
      (map.get(key) ?? map.set(key, []).get(key)!).push(r);
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === "Sans spécialité") return 1;
      if (b[0] === "Sans spécialité") return -1;
      return a[0].localeCompare(b[0], "fr");
    });
  }, [bySpecialty, filtered]);

  // L'ORDRE DE LA FEUILLE — celui dans lequel les lignes sont rendues, groupes compris. C'est
  // sur lui que les coordonnées de sélection sont numérotées.
  const ordonnees = React.useMemo<AnnuaireRow[]>(
    () => (groups ? groups.flatMap(([, list]) => list) : filtered),
    [groups, filtered],
  );

  // ── ÉDITION EN PLACE ──
  const [edition, setEdition] = React.useState<Edition | null>(null);
  // Ce qu'on vient d'écrire, affiché tout de suite : entre l'envoi et le rafraîchissement du
  // serveur, la cellule ne doit pas remontrer l'ancienne valeur.
  const [overrides, setOverrides] = React.useState<Map<string, string>>(new Map());
  /**
   * CE QU'ON VIENT D'ÉCRIRE, EN BRUT (§118.172) — `overrides` montre le LIBELLÉ, ceci dit ce que la
   * cellule VAUT pour le geste suivant. Sans cette mémoire, un second choix dans la même cellule
   * avant le rafraîchissement se comparait à la ligne d'AVANT : revenir à l'ancienne valeur était
   * jugé « inchangé », rien ne partait, et la base gardait le premier choix pendant que l'écran
   * montrait le second. Et le service d'une ligne dont on venait de choisir l'établissement se
   * cherchait dans l'établissement d'avant (« choisissez d'abord l'établissement » à la personne
   * qui venait de le faire). Trouvés par le banc navigateur, rafraîchissement ralenti.
   *
   * Les deux mémoires se vident ENSEMBLE, et seulement quand plus rien ne court — ni écriture en
   * vol, ni rafraîchissement : un rafraîchissement qui arrive pendant qu'une AUTRE écriture vole
   * encore porte des données qui ne la contiennent pas.
   */
  const [brutsLocaux, setBrutsLocaux] = React.useState<Map<string, string>>(new Map());
  const [enVol, setEnVol] = React.useState(0);
  React.useEffect(() => {
    if (rafraichit || enVol > 0) return;
    setOverrides((m) => (m.size === 0 ? m : new Map()));
    setBrutsLocaux((m) => (m.size === 0 ? m : new Map()));
  }, [rows, rafraichit, enVol]);
  /** La ligne telle qu'elle EST maintenant : la base, plus ce qu'on vient d'y écrire. */
  const effective = React.useCallback((row: AnnuaireRow): AnnuaireRow => {
    if (brutsLocaux.size === 0) return row;
    let out: AnnuaireRow | null = null;
    for (const col of colonnes) {
      const k = cleCellule(row.id, col.cle);
      if (!brutsLocaux.has(k)) continue;
      const v = brutsLocaux.get(k) ?? "";
      out ??= { ...row, custom: row.custom ? { ...row.custom } : row.custom };
      if (col.reference === "etablissement") out.institutionId = v || null;
      else if (col.reference === "service") out.serviceId = v || null;
      else if (col.field) (out as unknown as Record<string, unknown>)[col.field] = v === "" ? null : v;
      else if (out.custom) out.custom[col.cle] = v === "" ? null : v;
    }
    return out ?? row;
  }, [brutsLocaux, colonnes]);

  // ── COULEURS, avec mise à jour optimiste ──
  const [couleursLocales, setCouleursLocales] = React.useState<Record<string, string>>(couleurs);
  React.useEffect(() => { setCouleursLocales(couleurs); }, [couleurs]);

  const valeurPourCopie = React.useCallback((r: number, c: number) => {
    const row = ordonnees[r]; const col = colonnes[c];
    if (!row || !col) return "";
    return overrides.get(cleCellule(row.id, col.cle)) ?? valeurAffichee(row, col);
  }, [ordonnees, colonnes, overrides]);

  const demanderEdition = React.useCallback((coord: Coord, initial?: string) => {
    if (!canEdit) return;
    const col = colonnes[coord.c];
    if (!col) return;
    // UN SERVICE N'EXISTE QUE DANS SON ÉTABLISSEMENT (§118.172). Ouvrir un menu vide sans dire
    // pourquoi ferait chercher une panne : on dit ce qui manque, et où le faire.
    if (col.reference === "service") {
      const brute = ordonnees[coord.r];
      const row = brute ? effective(brute) : undefined;
      if (!row) return;
      if (!row.institutionId) {
        setMsg({ ok: false, text: "Choisissez d'abord l'établissement de cette ligne : un service est toujours celui d'un établissement." });
        return;
      }
      const etab = etablissements.find((e) => e.id === row.institutionId);
      if (!etab || etab.services.length === 0) {
        setMsg({ ok: false, text: `« ${etab?.name ?? row.institution ?? "Cet établissement"} » n'a aucun service renseigné : ajoutez-les dans Annuaires › Établissements (bouton « Services » de sa ligne).` });
        return;
      }
    }
    // Une frappe sur un menu fermé n'a pas de sens : on ouvre le menu, sans texte initial.
    setEdition({ r: coord.r, c: coord.c, initial: col.editor === "text" || col.editor === "number" ? initial : undefined });
  }, [canEdit, colonnes, ordonnees, etablissements, effective]);

  const grille = useSelectionGrille({
    lignes: ordonnees.length,
    colonnes: colonnes.length,
    valeur: valeurPourCopie,
    onEditer: canEdit ? demanderEdition : undefined,
    editionActive: edition !== null,
  });

  const annulerEdition = React.useCallback(() => {
    setEdition(null);
    grille.apresEdition();
  }, [grille]);

  const validerEdition = React.useCallback((row: AnnuaireRow, col: ColonneVue, next: string, suite?: "bas" | "droite" | "gauche") => {
    setEdition(null);
    grille.apresEdition(suite);
    const avant = valeurBrute(row, col);
    if (next === avant) return;
    const k = cleCellule(row.id, col.cle);
    // Affichage immédiat : pour un menu, le libellé de l'option ; pour un lien, le NOM de ce
    // qu'on vient de choisir ; sinon le texte tel quel.
    const etab = col.reference === "etablissement" ? etablissements.find((e) => e.id === next) : undefined;
    const libelle = col.reference === "etablissement"
      ? etab?.name ?? ""
      : col.reference === "service"
        ? etablissements.find((e) => e.id === row.institutionId)?.services.find((x) => x.id === next)?.name ?? ""
        : col.options?.find((o) => o.value === next)?.label ?? next;
    // CHANGER D'ÉTABLISSEMENT RETIRE LE SERVICE (l'action le fait) : la cellule voisine le montre
    // tout de suite, plutôt que d'afficher un service de l'ancien hôpital jusqu'au rafraîchissement.
    const kService = col.reference === "etablissement" ? cleCellule(row.id, "service") : null;
    setOverrides((m) => {
      const n = new Map(m).set(k, libelle);
      if (kService) n.set(kService, "");
      return n;
    });
    setBrutsLocaux((m) => {
      const n = new Map(m).set(k, next);
      if (kService) n.set(kService, "");
      return n;
    });
    setEnVol((x) => x + 1);
    const promesse = col.field
      ? saveDirectoryCell({ id: row.id, field: col.field, value: next })
      : saveDirectoryCustomCell({ id: row.id, key: col.cle, value: next });
    void promesse.then((r) => {
      setEnVol((x) => x - 1);
      if (r.ok) { setMsg(null); rafraichir(); }
      else {
        setOverrides((m) => { const n = new Map(m); n.delete(k); if (kService) n.delete(kService); return n; });
        setBrutsLocaux((m) => { const n = new Map(m); n.delete(k); if (kService) n.delete(kService); return n; });
        setMsg({ ok: false, text: r.error ?? "Écriture refusée." });
      }
    });
  }, [grille, rafraichir, etablissements]);

  // LES FICHES D'AVANT LE LIEN, dans la vue qu'on regarde (§118.172) : un établissement tapé à
  // la main, sans lien vers l'annuaire. Le geste qui les rattache en une fois — et seulement à
  // coup sûr — vit ici, à côté de ce qu'il corrige.
  const aRattacher = React.useMemo(() => filtered.filter(estARattacher), [filtered]);
  const [rattachement, setRattachement] = React.useState(false);
  const rattacher = async () => {
    if (aRattacher.length === 0) return;
    if (!(await confirmer(
      `Rattacher à l'annuaire des établissements les ${aRattacher.length} fiche(s) « à rattacher » de cette vue ?\n\n`
      + "Seules celles dont le texte désigne EXACTEMENT un établissement actif (majuscules et accents mis à part) seront rattachées ; "
      + "les autres restent « à rattacher », et le message dira pourquoi.",
    ))) return;
    setRattachement(true); setMsg(null);
    void rattacherEtablissementsParNom({ ids: aRattacher.map((r) => r.id) }).then((r) => {
      setRattachement(false);
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Rattachement terminé.") : (r.error ?? "Rattachement impossible.") });
      if (r.ok) rafraichir();
    }).catch((e: unknown) => { journal.erreur("annuaire-grid.rattacherEtablissementsParNom", {}, e);
      setRattachement(false);
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    });
  };

  // LES SPÉCIALITÉS ÉCRITES SANS LIEN, dans la vue qu'on regarde (§118.180) — le même geste que
  // pour les établissements, et la même retenue : seul un texte qui désigne UNE spécialité du
  // référentiel est rattaché ; les autres sont DITS.
  const specialitesARattacher = React.useMemo(() => filtered.filter(specialiteEstARattacher), [filtered]);
  const [rattachementSpecialites, setRattachementSpecialites] = React.useState(false);
  const rattacherSpecialites = async () => {
    if (specialitesARattacher.length === 0) return;
    if (!(await confirmer(
      `Rattacher au référentiel des spécialités les ${specialitesARattacher.length} fiche(s) « à rattacher » de cette vue ?\n\n`
      + "Seules celles dont le texte désigne EXACTEMENT une spécialité du référentiel (majuscules et accents mis à part) seront rattachées ; "
      + "les autres restent « à rattacher », et le message dira pourquoi.",
    ))) return;
    setRattachementSpecialites(true); setMsg(null);
    void rattacherSpecialitesParNom({ ids: specialitesARattacher.map((r) => r.id) }).then((r) => {
      setRattachementSpecialites(false);
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Rattachement terminé.") : (r.error ?? "Rattachement impossible.") });
      if (r.ok) rafraichir();
    }).catch((e: unknown) => { journal.erreur("annuaire-grid.rattacherSpecialitesParNom", {}, e);
      setRattachementSpecialites(false);
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    });
  };

  // LE RATTACHEMENT AUTOMATIQUE (Direction, 06/10) : les fiches dont l'établissement est SÛR (un seul hôpital de la
  // wilaya, ou un seul avec le service de la spécialité), et celles dont le service = la spécialité se déduit.
  const rattachables = React.useMemo(() => filtered.filter((r) => {
    if (!r.institutionId) return r.deduction?.statut === "unique";
    if (r.serviceId) return false;
    const etab = etablissements.find((e) => e.id === r.institutionId);
    return !!etab && serviceDeLaSpecialite(etab, r.specialty) !== null;
  }), [filtered, etablissements]);
  const [rattachementAuto, setRattachementAuto] = React.useState(false);
  const rattacherAuto = async () => {
    if (rattachables.length === 0) return;
    if (!(await confirmer(
      `Rattacher automatiquement ${rattachables.length} fiche(s) de cette vue ?\n\n`
      + "• l'établissement, quand la wilaya n'a qu'un établissement hospitalier, ou qu'un seul a le service de la spécialité ;\n"
      + "• le service, quand l'établissement a un service qui porte le nom de la spécialité.\n\n"
      + "Les fiches « à trancher » ne sont pas touchées.",
    ))) return;
    setRattachementAuto(true); setMsg(null);
    void rattacherAutomatiquement({ ids: rattachables.map((r) => r.id) }).then((r) => {
      setRattachementAuto(false);
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Rattachement terminé.") : (r.error ?? "Rattachement impossible.") });
      if (r.ok) rafraichir();
    }).catch((e: unknown) => { journal.erreur("annuaire-grid.rattacherAutomatiquement", {}, e);
      setRattachementAuto(false);
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    });
  };

  const appliquerCouleur = React.useCallback((couleur: CouleurCellule | null) => {
    const cibles = grille.cellules
      .map(({ r, c }) => ({ id: ordonnees[r]?.id ?? "", field: colonnes[c]?.cle ?? "" }))
      .filter((c) => c.id && c.field);
    if (cibles.length === 0) return;
    const avant = couleursLocales;
    const apres = { ...avant };
    for (const c of cibles) {
      const k = cleCellule(c.id, c.field);
      if (couleur) apres[k] = couleur; else delete apres[k];
    }
    setCouleursLocales(apres);
    setBusy(true); setMsg(null);
    void colorerCellulesAnnuaire({ feuille: "praticiens", cellules: cibles.map((c) => cleCellule(c.id, c.field)), couleur }).then((r) => {
      setBusy(false);
      if (!r.ok) { setCouleursLocales(avant); setMsg({ ok: false, text: r.error ?? "Coloration refusée." }); return; }
      if (r.ignorees > 0) setMsg({ ok: true, text: r.message ?? "" });
      rafraichir();
    });
  }, [grille.cellules, ordonnees, colonnes, couleursLocales, rafraichir]);

  // ÉTAPE 1 — on LIT le fichier et on propose une correspondance. Rien n'est écrit.
  const runPreview = (file: File) => {
    const fd = new FormData();
    fd.set("file", file);
    if (directoryId) fd.set("directoryId", directoryId);
    setBusy(true); setMsg(null);
    void previewDirectorySheet(fd).then((r) => {
      setBusy(false);
      if (!r.ok || !r.preview) {
        setMsg({ ok: false, text: r.error ?? "Lecture impossible." });
        if (fileRef.current) fileRef.current.value = "";
        return;
      }
      setPending({ file, ...r.preview });
    });
  };

  // ÉTAPE 2 — la correspondance validée à l'écran part avec le fichier.
  const runImport = (file: File, mapping: (string | null)[]) => {
    const fd = new FormData();
    fd.set("file", file);
    // LA DESTINATION. Son absence était le bug : sans elle, tout finissait dans le général.
    if (directoryId) fd.set("directoryId", directoryId);
    fd.set("mapping", JSON.stringify(mapping));
    setBusy(true); setMsg(null); setPending(null);
    void importDirectorySheet(fd).then((r) => {
      setBusy(false);
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Annuaire importé.") : (r.error ?? "Import impossible.") });
      if (r.ok) rafraichir();
      if (fileRef.current) fileRef.current.value = "";
    });
  };

  const tableProps = {
    colonnes, editable: canEdit, selected, onToggle: toggleOne, onToggleAll: toggleMany, grille, edition,
    onCommit: validerEdition, onCancel: annulerEdition, couleurs: couleursLocales, overrides, etablissements, effective,
  };

  return (
    <div className="space-y-3">
      {/* L'ÉTAPE QUI MANQUAIT : on montre ce qu'on a compris AVANT d'écrire quoi que ce soit. */}
      {pending && (
        <ImportMappingSheet
          fileName={pending.file.name}
          directoryName={directoryName}
          rowCount={pending.rowCount}
          proposals={pending.proposals}
          targets={pending.targets}
          busy={busy}
          onCancel={() => { setPending(null); if (fileRef.current) fileRef.current.value = ""; }}
          onConfirm={(mapping) => runImport(pending.file, mapping)}
        />
      )}

      <datalist id={SPECIALTY_LIST_ID}>
        {specialties.map((s) => <option key={s} value={s} />)}
      </datalist>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search" enterKeyHint="search"
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Chercher un nom, une wilaya, une spécialité…"
            className="w-full pl-8 sm:w-72"
          />
        </div>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          {filtered.length} / {rows.length} praticien{rows.length > 1 ? "s" : ""}
          {/* LE MODE D'EMPLOI DU CLAVIER, derrière le ⓘ — plus un bandeau permanent au-dessus de la feuille (Direction, 07/10). */}
          {canEdit && (
            <InfoBulle label="Comment corriger la feuille" align="left">
              <strong>Un clic sélectionne</strong> une cellule — Maj étend, Ctrl ajoute, on peut aussi glisser et se déplacer aux
              flèches. <strong>Double-clic, Entrée ou une frappe</strong> ouvrent la correction ; Entrée valide et descend, Tab
              valide et avance, Échap annule. Wilaya, grade, secteur et potentiel se choisissent dans un menu ;
              l&apos;<strong>établissement</strong> dans l&apos;annuaire des établissements, le <strong>service</strong> parmi ceux
              de cet établissement. Les cellules sélectionnées se <strong>colorent</strong> et se <strong>copient</strong> (Ctrl+C)
              depuis la barre qui apparaît.
            </InfoBulle>
          )}
        </span>

        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
          <div className="inline-flex overflow-hidden rounded-lg border border-input">
            <button
              type="button" onClick={() => setBySpecialty(false)}
              className={cn("inline-flex min-h-10 items-center gap-1.5 px-2.5 py-2 text-xs font-medium sm:min-h-0", !bySpecialty ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50")}
            >
              <LayoutList className="h-3.5 w-3.5" /> Liste
            </button>
            <button
              type="button" onClick={() => setBySpecialty(true)}
              className={cn("inline-flex min-h-10 items-center gap-1.5 px-2.5 py-2 text-xs font-medium sm:min-h-0", bySpecialty ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50")}
            >
              <Rows3 className="h-3.5 w-3.5" /> Par spécialité
            </button>
          </div>
          {/* UN GESTE PRINCIPAL VISIBLE — ajouter une fiche ; le reste (rattachements, colonnes, export, import) dans
              « ⋯ » (Direction, 07/10). Les rattachements y gardent leur compte : ce qui reste à faire se voit. */}
          {canImport && !ajoutOuvert && (
            <Button size="sm" className="h-10 sm:h-8" onClick={() => setAjoutOuvert(true)}>
              <Plus className="h-3.5 w-3.5" /> {titreParDefaut === "PHARMACIEN" ? "Ajouter un pharmacien" : "Ajouter un praticien"}
            </Button>
          )}
          {canImportFile && (
            <input
              ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) runPreview(f); }}
            />
          )}
          {(busy || rattachement || rattachementAuto || rattachementSpecialites) && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="En cours" />
          )}
          <MenuPlus label="Autres actions de l'annuaire">
            {canEdit && aRattacher.length > 0 && (
              <EntreeMenu disabled={rattachement} onClick={rattacher}
                title="Rattacher à l'annuaire des établissements les fiches dont l'établissement a été tapé à la main">
                <Building2 className="h-4 w-4" /> Rattacher les établissements ({aRattacher.length})
              </EntreeMenu>
            )}
            {canEdit && rattachables.length > 0 && (
              <EntreeMenu disabled={rattachementAuto} onClick={rattacherAuto}
                title="Établissement déduit de la wilaya et de la spécialité ; service = spécialité">
                <Building2 className="h-4 w-4" /> Rattacher automatiquement ({rattachables.length})
              </EntreeMenu>
            )}
            {canEdit && specialitesARattacher.length > 0 && (
              <EntreeMenu disabled={rattachementSpecialites} onClick={rattacherSpecialites}
                title="Rattacher au référentiel des spécialités les fiches dont la spécialité est écrite sans lien">
                <Stethoscope className="h-4 w-4" /> Rattacher les spécialités ({specialitesARattacher.length})
              </EntreeMenu>
            )}
            {canManageColumns && directoryId && (
              <EntreeMenu onClick={() => setColonnesOuvertes((v) => !v)}>
                <Columns3 className="h-4 w-4" /> {colonnesOuvertes ? "Masquer les colonnes" : "Colonnes"}{customColumns.length > 0 ? ` (${customColumns.length})` : ""}
              </EntreeMenu>
            )}
            <EntreeMenu href={exportHref} brut title="Exporter l'annuaire en Excel">
              <FileSpreadsheet className="h-4 w-4" /> Exporter (Excel)
            </EntreeMenu>
            {canImportFile && (
              <EntreeMenu disabled={busy} onClick={() => fileRef.current?.click()} title="L'import accepte un fichier existant ; la correspondance des colonnes se valide avant toute écriture.">
                <Upload className="h-4 w-4" /> Importer un fichier
              </EntreeMenu>
            )}
          </MenuPlus>
        </div>
      </div>

      {colonnesOuvertes && directoryId && (
        <GestionColonnes
          directoryId={directoryId}
          colonnes={customColumns}
          onDone={() => rafraichir()}
        />
      )}

      {canImport && ajoutOuvert && (
        <AddDoctorRow
          specialtyListId={SPECIALTY_LIST_ID} titreParDefaut={titreParDefaut} directoryId={directoryId} etablissements={etablissements}
          specialiteImposee={specialiteImposee} onClose={() => setAjoutOuvert(false)}
        />
      )}

      <div {...grille.propsConteneur} className="space-y-5 rounded-xl outline-none focus-visible:ring-1 focus-visible:ring-ring">
        {ordonnees.length === 0 ? (
          <div className="surface px-3 py-10 text-center text-sm text-muted-foreground">
            {rows.length === 0 ? "L'annuaire est vide." : "Aucun praticien ne correspond à cette recherche."}
          </div>
        ) : groups ? (
          (() => {
            let offset = 0;
            return groups.map(([name, list]) => {
              const debut = offset;
              offset += list.length;
              return (
                <section key={name} className="space-y-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    {name} <span className="text-xs font-normal text-muted-foreground">· {list.length}</span>
                  </h3>
                  <GridTable rows={list} offset={debut} {...tableProps} />
                </section>
              );
            });
          })()
        ) : (
          <GridTable rows={ordonnees} offset={0} {...tableProps} />
        )}
      </div>

      {/* TOUT CE QUI APPARAÎT VIT SOUS LA FEUILLE, DANS LE FLUX (§118.172). Posé au-dessus, il la
          décalait au premier clic d'un double-clic, et le second ouvrait la cellule de la ligne du
          DESSUS ; collé au bas de l'écran, il recouvrait la dernière ligne visible et prenait le clic. */}
      <DockSelection>
        {/* CE QUI EST SÉLECTIONNÉ, ET CE QU'ON EN FAIT — la barre n'apparaît que s'il y a une
            sélection : un bouton « Supprimer » toujours visible finit par être cliqué à vide. */}
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-card p-2.5 text-sm shadow-sm">
            <span className="font-medium">{selected.size} ligne{selected.size > 1 ? "s" : ""} sélectionnée{selected.size > 1 ? "s" : ""}</span>
            {canDelete && (
              <Button
                size="sm" variant="outline" disabled={deleting}
                onClick={async () => {
                  // SUPPRIMER = ARCHIVER (réversible) ; dans la vue « Archivés », le même bouton RESTAURE.
                  if (!archives && !(await confirmer(`Archiver ${selected.size} fiche(s) de l'annuaire ? Elles sortent de la feuille mais restent restaurables depuis « Archivés ».`))) return;
                  setDeleting(true);
                  void (archives ? restaurerDirectoryDoctors : deleteDirectoryDoctors)([...selected]).then((r) => {
                    setDeleting(false);
                    setMsg({ ok: r.ok, text: r.ok ? (r.message ?? (archives ? "Restauré." : "Archivé.")) : (r.error ?? (archives ? "Restauration impossible." : "Archivage impossible.")) });
                    if (r.ok) { setSelected(new Set()); rafraichir(); }
                  }).catch((e: unknown) => { journal.erreur("annuaire-grid.archiverOuRestaurer", {}, e);
                    setDeleting(false);
                    setMsg({ ok: false, text: actionFailureMessage("THROWN") });
                  });
                }}
                className={archives ? undefined : "text-destructive"}
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : archives ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />} {archives ? "Restaurer" : "Supprimer"}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              <X className="h-3.5 w-3.5" /> Tout désélectionner
            </Button>
          </div>
        )}

        <BarreSelection
          nombre={grille.nombre}
          peutColorer={canEdit}
          busy={busy}
          onCouleur={(c) => appliquerCouleur(c)}
          onEffacer={() => appliquerCouleur(null)}
          onCopier={grille.copier}
          onFermer={grille.vider}
          message={msg && grille.nombre > 0 ? msg : null}
        />
        {msg && grille.nombre === 0 && (
          <p role={msg.ok ? "status" : "alert"} className={`rounded-xl border bg-card px-3 py-2 text-sm shadow-sm ${msg.ok ? "border-success/40 text-success" : "border-destructive/40 text-destructive"}`}>
            {msg.text}
          </p>
        )}
      </DockSelection>
    </div>
  );
}
