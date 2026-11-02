"use client";

/**
 * LES PRATICIENS — le tableau : état (URL, saisies locales, sélection), gestes (saisie, statut,
 * lettre forcée, panel, suppression), en-têtes triables et filtrables.
 */
import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Filter, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { STATUTS, STATUT_LABELS, type Lettre, type MethodeAffinite, type Statut } from "@/lib/segmentation/regles";
import { enteteQ1 } from "@/lib/segmentation/charge";
import { vueDuTableau, triSuivant, retirerFiltre, effacerFiltres, nbFiltresActifs, urlAvecEtat, lireSaisieQ, casseNom, FILTRES_LISTE, FILTRES_TEXTE, FILTRES_PLAGE, type Colonne, type EtatTableau, type FiltrePlage, type CleFiltre } from "@/lib/segmentation/tableau-praticiens";
import { enregistrerPotentiel, changerStatut, forcerLettre, rendreLettreCalculee, changerSecteur, retirerDuPanel } from "@/lib/actions/segmentation-actions";
import { saveDirectoryCell, deleteDirectoryDoctors } from "@/lib/actions/medical-directory-actions";
import { type LignePraticien, type Droits, type DroitsAnnuaire, type RegleEcran, type Local, type EtatCellule, appliquer, versTri, type Resultat, type Deplacement, LIBELLES, COLS_TEXTE, enLot, libelleFiltre, fmt, FILTRE_DE, estListe, estTexte, champ } from "./modele";
import { type CtxLigne, LigneMemo } from "./ligne";
import { FormMotif } from "./editeurs";
import { PanneauFiltre } from "./filtres";
import { Flottant } from "./flottant";
import { AjoutPanel } from "./ajout-panel";

export function PraticiensTable({
  strategieId, produitNom, produitCourt, metrique, methode, lignes, secteurs, droits, annuaire, etablissements, specialites, grades, regle, etatInitial,
}: {
  strategieId: string; produitNom: string | null; produitCourt: string | null; metrique: string | null; methode: MethodeAffinite;
  lignes: LignePraticien[]; secteurs: { id: string; nom: string }[]; droits: Droits; annuaire: DroitsAnnuaire;
  etablissements: { id: string; nom: string; wilaya: string | null }[]; specialites: { id: string; nom: string }[];
  grades: { valeur: string; libelle: string }[]; regle: RegleEcran | null; etatInitial: EtatTableau;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [etat, setEtat] = React.useState<EtatTableau>(etatInitial);
  const [local, setLocal] = React.useState<Record<string, Local>>({});
  const [etats, setEtats] = React.useState<Record<string, Partial<Record<Colonne, EtatCellule>>>>({});
  const [retires, setRetires] = React.useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = React.useState<ReadonlySet<string>>(() => new Set());
  const [edition, setEdition] = React.useState<{ id: string; col: Colonne; init?: string } | null>(null);
  const [motif, setMotif] = React.useState<{ id: string; lettre: Lettre } | null>(null);
  const [menu, setMenu] = React.useState<{ id: string; ancre: HTMLElement } | null>(null);
  const [filtre, setFiltre] = React.useState<{ col: Colonne; ancre: HTMLElement } | null>(null);
  const [details, setDetails] = React.useState<ReadonlySet<string>>(() => new Set());
  const [toast, setToast] = React.useState<{ texte: string; erreur: boolean } | null>(null);
  const [ajout, setAjout] = React.useState(false);

  // ── Les droits, cellule par cellule ─────────────────────────────────────────────
  const peut = React.useMemo<Record<Colonne, boolean>>(() => ({
    secteur: droits.valider, cdr: annuaire.modifier, specialite: annuaire.modifier, nom: annuaire.modifier, prenom: annuaire.modifier,
    grade: annuaire.modifier, statut: droits.saisir, q1: droits.saisir, q2: droits.saisir, pct: false, potentiel: droits.forcer,
  }), [droits, annuaire]);
  const avecSelection = droits.panel || droits.valider || droits.saisir;

  // ── Les lignes effectives, mises à plat pour le tri et les filtres ─────────────
  const effectives = React.useMemo(
    () => lignes.filter((l) => !retires.has(l.doctorId)).map((l) => appliquer(l, local[l.doctorId], regle)),
    [lignes, local, retires, regle],
  );
  const tris = React.useMemo(() => new Map(effectives.map((v) => [v.doctorId, versTri(v, methode)])), [effectives, methode]);
  const lireTri = React.useCallback((v: LignePraticien) => tris.get(v.doctorId)!, [tris]);
  const visibles = React.useMemo(() => vueDuTableau(effectives, etat, lireTri), [effectives, etat, lireTri]);

  // ── L'état dans l'URL (sans recharger la page) ─────────────────────────────────
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      const voulu = `${window.location.pathname}${urlAvecEtat(window.location.search, etat)}${window.location.hash}`;
      if (voulu !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(null, "", voulu);
    }, 250);
    return () => window.clearTimeout(t);
  }, [etat]);

  // ── Écritures : optimistes, annulées en cas de refus, un rafraîchissement groupé ─
  const enVol = React.useRef(new Map<string, number>());
  const finiA = React.useRef(new Map<string, number>());
  const lanceA = React.useRef(0);
  const minuterie = React.useRef<number | undefined>(undefined);
  const localRef = React.useRef(local);
  localRef.current = local;

  const montrer = React.useCallback((texte: string, erreur = true) => setToast({ texte, erreur }), []);
  React.useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const planifierRafraichir = React.useCallback(() => {
    window.clearTimeout(minuterie.current);
    minuterie.current = window.setTimeout(() => { lanceA.current = Date.now(); rafraichir(); }, 350);
  }, [rafraichir]);

  // Les données du serveur arrivent : les valeurs provisoires dont l'écriture est déjà lue n'ont plus lieu d'être.
  React.useEffect(() => {
    const garder = (id: string) => (enVol.current.get(id) ?? 0) > 0 || (finiA.current.get(id) ?? 0) > lanceA.current;
    setLocal((x) => {
      const ids = Object.keys(x);
      if (ids.every(garder)) return x;
      return Object.fromEntries(ids.filter(garder).map((id) => [id, x[id]]));
    });
    setRetires((x) => (x.size === 0 ? x : new Set([...x].filter(garder))));
  }, [lignes]);

  const marquer = React.useCallback((id: string, col: Colonne, e: EtatCellule | null) => {
    setEtats((x) => {
      const o = { ...x[id] };
      if (e) o[col] = e; else delete o[col];
      return { ...x, [id]: o };
    });
  }, []);

  const sauver = React.useCallback(async (id: string, col: Colonne, maj: Local, appel: () => Promise<Resultat>) => {
    const avant = localRef.current[id];
    setLocal((x) => ({ ...x, [id]: { ...x[id], ...maj } }));
    marquer(id, col, "envoi");
    enVol.current.set(id, (enVol.current.get(id) ?? 0) + 1);
    let r: Resultat;
    try { r = await appel(); } catch { r = { ok: false, error: "Enregistrement impossible (connexion)." }; }
    enVol.current.set(id, (enVol.current.get(id) ?? 1) - 1);
    finiA.current.set(id, Date.now());
    if (r.ok) {
      marquer(id, col, null);
      planifierRafraichir();
      return true;
    }
    setLocal((x) => {
      const o: Record<string, unknown> = { ...x[id] };
      for (const k of Object.keys(maj)) {
        if (avant && k in avant) o[k] = (avant as Record<string, unknown>)[k]; else delete o[k];
      }
      const y = { ...x, [id]: o as Local };
      if (Object.keys(o).length === 0) delete y[id];
      return y;
    });
    marquer(id, col, "erreur");
    window.setTimeout(() => marquer(id, col, null), 3000);
    montrer(r.error ?? "Enregistrement refusé.");
    return false;
  }, [marquer, montrer, planifierRafraichir]);

  // ── Le déplacement au clavier ───────────────────────────────────────────────────
  const etatRef = React.useRef({ visibles, effectives, peut });
  etatRef.current = { visibles, effectives, peut };

  const focaliser = React.useCallback((id: string, col: Colonne) => {
    window.requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-cellule="${CSS.escape(`${id}|${col}`)}"]`);
      el?.focus();
    });
  }, []);

  const deplacer = React.useCallback((id: string, col: Colonne, dep: Deplacement) => {
    if (!dep) return;
    if (dep === "ici") { focaliser(id, col); return; }
    const { visibles: vs, peut: p } = etatRef.current;
    const cols = (Object.keys(LIBELLES) as Colonne[]).filter((c) => p[c]);
    const i = vs.findIndex((v) => v.doctorId === id);
    if (i === -1) return;
    if (dep === "bas" || dep === "haut") {
      const j = i + (dep === "bas" ? 1 : -1);
      if (vs[j]) focaliser(vs[j].doctorId, col); else focaliser(id, col);
      return;
    }
    const k = cols.indexOf(col) + (dep === "droite" ? 1 : -1);
    if (k >= 0 && k < cols.length) { focaliser(id, cols[k]); return; }
    const j = i + (dep === "droite" ? 1 : -1);
    if (vs[j]) focaliser(vs[j].doctorId, dep === "droite" ? cols[0] : cols[cols.length - 1]);
    else focaliser(id, col);
  }, [focaliser]);

  const commencer = React.useCallback((id: string, col: Colonne, init?: string) => {
    if (!etatRef.current.peut[col]) return;
    setMotif(null);
    setEdition({ id, col, init });
  }, []);

  const annuler = React.useCallback((id: string, col: Colonne, refocaliser: boolean) => {
    setEdition((e) => (e && e.id === id && e.col === col ? null : e));
    if (refocaliser) focaliser(id, col);
  }, [focaliser]);

  /** VALIDER UNE CELLULE : la valeur brute de l'éditeur → le bon geste serveur. */
  const valider = React.useCallback((id: string, col: Colonne, brut: string, dep: Deplacement) => {
    setEdition((e) => (e && e.id === id && e.col === col ? null : e));
    const v = etatRef.current.effectives.find((x) => x.doctorId === id);
    if (!v) return;
    // Forcer une lettre ouvre le motif : le curseur y va, pas sur la cellule suivante.
    const ouvreMotif = col === "potentiel" && !!brut && brut !== "__calc" && !(v.forcee && v.forcee.valeur === brut);
    if (!ouvreMotif) deplacer(id, col, dep);
    const t = brut.replace(/\s+/g, " ").trim();
    switch (col) {
      case "nom":
        if (!t) { montrer("Le nom ne peut pas être vide."); return; }
        if (t === v.nomFamille) return;
        void sauver(id, col, { nomFamille: t }, () => saveDirectoryCell({ id, field: "lastName", value: t }));
        return;
      case "prenom":
        if (t === (v.prenom ?? "")) return;
        void sauver(id, col, { prenom: t || null }, () => saveDirectoryCell({ id, field: "firstName", value: t }));
        return;
      case "q1":
      case "q2": {
        const s = lireSaisieQ(brut, col);
        if (!s.ok) { montrer(s.error); return; }
        if (s.valeur === v[col]) return;
        const appel = s.valeur === null
          ? () => enregistrerPotentiel({ strategieId, doctorId: id, productId: null, potentiel: "", sur10: "", effacer: col })
          : () => enregistrerPotentiel({ strategieId, doctorId: id, productId: null, potentiel: col === "q1" ? String(s.valeur) : "", sur10: col === "q2" ? String(s.valeur) : "" });
        void sauver(id, col, { [col]: s.valeur }, appel);
        return;
      }
      case "statut": {
        const st = (brut || null) as Statut | null;
        if (st === v.statut) return;
        void sauver(id, col, { statut: st }, () => changerStatut({ strategieId, doctorId: id, statut: st }));
        return;
      }
      case "secteur": {
        const sid = brut || null;
        if (brut === (v.secteurPose ? v.secteurId ?? "" : "")) return;
        const nom = sid ? secteurs.find((s) => s.id === sid)?.nom ?? null : null;
        void sauver(id, col, { secteurId: sid, secteurNom: nom, secteurPose: !!sid, inOut: null }, () => changerSecteur({ strategieId, doctorId: id, secteurId: sid }));
        return;
      }
      case "cdr": {
        if (brut === (v.institutionId ?? "") && (brut || !v.etablissement)) return;
        const e = brut ? etablissements.find((x) => x.id === brut) : null;
        void sauver(id, col, { institutionId: e?.id ?? null, etablissement: e?.nom ?? null }, () => saveDirectoryCell({ id, field: "institution", value: brut }));
        return;
      }
      case "specialite": {
        if (brut === (v.specialiteId ?? "") && (brut || !v.specialite)) return;
        const s = brut ? specialites.find((x) => x.id === brut) : null;
        void sauver(id, col, { specialiteId: s?.id ?? null, specialite: s?.nom ?? null }, () => saveDirectoryCell({ id, field: "specialty", value: s?.nom ?? "" }));
        return;
      }
      case "grade": {
        if (!brut || (brut === v.titre && !(v.titre === "AUTRE" && v.gradeBrut))) return;
        const g = grades.find((x) => x.valeur === brut);
        void sauver(id, col, { titre: brut, grade: g?.libelle ?? brut, gradeBrut: null }, () => saveDirectoryCell({ id, field: "title", value: brut }));
        return;
      }
      case "potentiel": {
        if (brut === "__calc") {
          if (!v.forcee) return;
          void sauver(id, col, { forcee: null, lettre: v.lettreCalculee }, () => rendreLettreCalculee({ strategieId, doctorId: id }));
          return;
        }
        if (ouvreMotif) setMotif({ id, lettre: brut as Lettre });
        return;
      }
      default:
    }
  }, [strategieId, secteurs, etablissements, specialites, grades, sauver, montrer, deplacer]);

  const forcer = React.useCallback((id: string, lettre: Lettre, texte: string) => {
    setMotif(null);
    focaliser(id, "potentiel");
    void sauver(id, "potentiel", { forcee: { valeur: lettre, motif: texte }, lettre }, () => forcerLettre({ strategieId, doctorId: id, lettre, motif: texte }));
  }, [strategieId, sauver, focaliser]);

  const toucheCellule = React.useCallback((e: React.KeyboardEvent<HTMLElement>, id: string, col: Colonne) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); commencer(id, col); return; }
    const dir: Record<string, Deplacement> = { ArrowDown: "bas", ArrowUp: "haut", ArrowRight: "droite", ArrowLeft: "gauche" };
    if (dir[e.key]) { e.preventDefault(); deplacer(id, col, dir[e.key]); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Taper sur une cellule l'ouvre avec ce caractère (un menu : il cherche) ; Suppr vide un texte ou un nombre.
    if ((e.key === "Backspace" || e.key === "Delete") && COLS_TEXTE.includes(col)) { e.preventDefault(); commencer(id, col, ""); return; }
    if (e.key.length === 1 && e.key !== " ") { e.preventDefault(); commencer(id, col, e.key); }
  }, [commencer, deplacer]);

  const basculer = React.useCallback((ensemble: "selection" | "details", id: string) => {
    const f = (x: ReadonlySet<string>) => { const y = new Set(x); if (y.has(id)) y.delete(id); else y.add(id); return y; };
    if (ensemble === "selection") setSelection(f); else setDetails(f);
  }, []);
  const ouvrirMenu = React.useCallback((id: string, ancre: HTMLElement) => setMenu((m) => (m?.id === id ? null : { id, ancre })), []);

  // ── Retirer, supprimer, et les gestes en lot ───────────────────────────────────
  async function retirer(ids: string[], aussiAnnuaire: boolean) {
    setMenu(null);
    for (const id of ids) enVol.current.set(id, (enVol.current.get(id) ?? 0) + 1);
    setRetires((x) => new Set([...x, ...ids]));
    const res = await enLot(ids, (id) => retirerDuPanel(strategieId, id));
    let annuaireErreur: string | null = null;
    const ok = ids.filter((_, i) => res[i].ok);
    if (aussiAnnuaire && ok.length) {
      const r = await deleteDirectoryDoctors(ok);
      if (!r.ok) annuaireErreur = r.error ?? "Suppression de l'annuaire refusée.";
    }
    const now = Date.now();
    for (const id of ids) { enVol.current.set(id, (enVol.current.get(id) ?? 1) - 1); finiA.current.set(id, now); }
    const ko = ids.filter((_, i) => !res[i].ok);
    if (ko.length) setRetires((x) => new Set([...x].filter((id) => !ko.includes(id))));
    setSelection((x) => new Set([...x].filter((id) => !ok.includes(id))));
    const erreur = res.find((r) => !r.ok);
    if (erreur && !erreur.ok) montrer(ko.length > 1 ? `${ko.length} lignes non retirées : ${erreur.error}` : erreur.error);
    else if (annuaireErreur) montrer(annuaireErreur);
    else montrer(ok.length > 1 ? `${ok.length} praticiens retirés.` : aussiAnnuaire ? "Retiré et archivé dans l'annuaire." : "Retiré de la segmentation.", false);
    planifierRafraichir();
  }

  async function changerEnLot(col: "statut" | "secteur", valeur: string) {
    const ids = [...selection].filter((id) => effectives.some((v) => v.doctorId === id));
    if (!ids.length) return;
    const nom = col === "secteur" && valeur ? secteurs.find((s) => s.id === valeur)?.nom ?? null : null;
    const res = await enLot(ids, (id) => (col === "statut"
      ? sauver(id, "statut", { statut: (valeur || null) as Statut | null }, () => changerStatut({ strategieId, doctorId: id, statut: valeur || null }))
      : sauver(id, "secteur", { secteurId: valeur || null, secteurNom: nom, secteurPose: !!valeur, inOut: null }, () => changerSecteur({ strategieId, doctorId: id, secteurId: valeur || null }))));
    const n = res.filter(Boolean).length;
    if (n === ids.length) montrer(`${n} ligne(s) modifiée(s).`, false);
  }

  // ── Le contexte des lignes : stable, pour que seule la ligne touchée se redessine ─
  const options = React.useMemo<CtxLigne["options"]>(() => ({
    secteur: [{ valeur: "", libelle: "— Aucun" }, ...secteurs.map((s) => ({ valeur: s.id, libelle: s.nom }))],
    cdr: [{ valeur: "", libelle: "— Aucun" }, ...etablissements.map((e) => ({ valeur: e.id, libelle: e.nom, detail: e.wilaya ?? undefined }))],
    specialite: [{ valeur: "", libelle: "— Aucune" }, ...specialites.map((s) => ({ valeur: s.id, libelle: casseNom(s.nom) }))],
    grade: grades.map((g) => ({ valeur: g.valeur, libelle: g.libelle })),
    statut: [{ valeur: "", libelle: "—" }, ...STATUTS.map((s) => ({ valeur: s, libelle: STATUT_LABELS[s] }))],
  }), [secteurs, etablissements, specialites, grades]);
  const ctx = React.useMemo<CtxLigne>(() => ({
    peut, avecSelection, methode, options,
    commencer, annuler, valider, toucheCellule, basculer, ouvrirMenu,
  }), [peut, avecSelection, methode, options, commencer, annuler, valider, toucheCellule, basculer, ouvrirMenu]);

  // ── Filtres ────────────────────────────────────────────────────────────────────
  const toutesTri = React.useMemo(() => [...tris.values()], [tris]);
  const actifs = nbFiltresActifs(etat);
  const puces: { cle: CleFiltre; valeur?: string; texte: string }[] = [];
  for (const f of FILTRES_LISTE) {
    for (const val of etat.listes[f] ?? []) {
      const t = toutesTri.find((x) => x[f] === val);
      const lib = t ? libelleFiltre(f, t) : val.replace(/^t:|^brut:/, "") || "—";
      puces.push({ cle: f, valeur: val, texte: `${f === "io" ? "In/Out" : LIBELLES[f as Colonne]} : ${lib}` });
    }
  }
  for (const f of FILTRES_TEXTE) { const t = (etat.textes[f] ?? "").trim(); if (t) puces.push({ cle: f, texte: `${LIBELLES[f]} contient « ${t} »` }); }
  for (const f of FILTRES_PLAGE) {
    const p = etat.plages[f];
    if (!p || (p.min === null && p.max === null)) continue;
    const u = f === "pct" ? " %" : "";
    const nom = f === "pct" ? "%" : LIBELLES[f];
    puces.push({ cle: f, texte: p.min !== null && p.max !== null ? `${nom} ${fmt(p.min)}–${fmt(p.max)}${u}` : p.min !== null ? `${nom} ≥ ${fmt(p.min)}${u}` : `${nom} ≤ ${fmt(p.max)}${u}` });
  }

  const filtreActif = (col: Colonne) => {
    const f = FILTRE_DE[col];
    if (!f) return false;
    if (estListe(f)) return (etat.listes[f]?.length ?? 0) > 0 || (col === "cdr" && (etat.listes.io?.length ?? 0) > 0);
    if (estTexte(f)) return !!(etat.textes[f] ?? "").trim();
    const p = etat.plages[f as FiltrePlage];
    return !!p && (p.min !== null || p.max !== null);
  };

  const selectionVisible = visibles.filter((v) => selection.has(v.doctorId));
  const toutCoche = visibles.length > 0 && selectionVisible.length === visibles.length;
  const nbCols = 11 + (avecSelection ? 1 : 0) + 1;
  const produitQ2 = produitCourt || "le produit";

  const entete = (col: Colonne, extra?: { className?: string; info?: React.ReactNode; libelle?: React.ReactNode; collant?: boolean }) => {
    const sens = etat.tri?.col === col ? etat.tri.sens : null;
    const f = FILTRE_DE[col];
    return (
      <th
        key={col}
        aria-sort={sens === "asc" ? "ascending" : sens === "desc" ? "descending" : undefined}
        className={cn(
          "sticky top-0 z-[2] whitespace-nowrap border-b border-border bg-card px-2.5 py-2 text-left text-xs font-medium text-muted-foreground",
          extra?.collant && cn("z-[3]", avecSelection ? "left-9" : "left-0"),
          extra?.className,
        )}
      >
        <span className="inline-flex items-center gap-1">
          <button type="button" onClick={() => setEtat((e) => ({ ...e, tri: triSuivant(e.tri, col) }))} className={cn("inline-flex items-center gap-0.5 hover:text-foreground", sens && "text-foreground")} title="Trier">
            {extra?.libelle ?? LIBELLES[col]}
            {sens === "asc" ? <ArrowUp className="h-3 w-3" /> : sens === "desc" ? <ArrowDown className="h-3 w-3" /> : null}
          </button>
          {extra?.info}
          {f && (
            <button
              type="button" aria-label={`Filtrer : ${LIBELLES[col]}`}
              onClick={(e) => { const a = e.currentTarget; setFiltre((x) => (x?.col === col ? null : { col, ancre: a })); }}
              className={cn("rounded p-0.5", filtreActif(col) ? "text-primary" : "text-muted-foreground/50 hover:text-foreground")}
            >
              <Filter className="h-3 w-3" />
            </button>
          )}
        </span>
      </th>
    );
  };

  const menuLigne = menu ? effectives.find((v) => v.doctorId === menu.id) : undefined;
  const motifLigne = motif ? effectives.find((v) => v.doctorId === motif.id) : undefined;
  const ancreMotif = motif && typeof document !== "undefined" ? document.querySelector<HTMLElement>(`[data-cellule="${CSS.escape(`${motif.id}|potentiel`)}"]`) : null;

  return (
    <div className="space-y-3">
      <section className="surface min-w-0 rounded-xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <input type="search" value={etat.q} onChange={(e) => { const q = e.target.value; setEtat((x) => ({ ...x, q })); }} placeholder="Nom, CDR, spécialité…" aria-label="Rechercher" className={cn(champ, "min-w-[200px] flex-1")} />
          {droits.panel && <Button type="button" size="sm" variant="outline" onClick={() => setAjout((v) => !v)} aria-expanded={ajout}>Ajouter un praticien</Button>}
          <InfoBulle label="Le tableau" align="left">
            Un clic ou Entrée ouvre la cellule ; Entrée ou Tab enregistre, Échap annule. Nom, prénom, CDR, spécialité et grade sont ceux de l&apos;annuaire. <span className="text-warning">✎</span> = potentiel forcé à la main (motif obligatoire, historisé).
          </InfoBulle>
        </div>
        {ajout && droits.panel && <AjoutPanel strategieId={strategieId} onFait={() => { setAjout(false); planifierRafraichir(); }} />}

        <div className="flex min-h-[40px] flex-wrap items-center gap-1.5 border-b border-border px-4 py-2 text-xs">
          <span className="font-medium tabular-nums">{visibles.length} / {effectives.length}</span>
          {puces.map((p) => (
            <button key={`${p.cle}:${p.valeur ?? ""}`} type="button" onClick={() => setEtat((e) => retirerFiltre(e, p.cle, p.valeur))} className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-primary hover:bg-primary/10" aria-label={`Retirer le filtre ${p.texte}`}>
              {p.texte}<X className="h-3 w-3" />
            </button>
          ))}
          {actifs > 0 && <button type="button" onClick={() => setEtat(effacerFiltres)} className="text-muted-foreground underline hover:text-foreground">Effacer les filtres</button>}
          {(enCours || Object.values(etats).some((o) => Object.values(o).includes("envoi"))) && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Enregistrement" />}
        </div>

        {selection.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-primary/5 px-4 py-2 text-xs">
            <span className="font-medium">{selection.size} sélectionné{selection.size > 1 ? "s" : ""}</span>
            {droits.valider && (
              <select value="" onChange={(e) => { if (e.target.value) void changerEnLot("secteur", e.target.value === "__aucun" ? "" : e.target.value); }} aria-label="Secteur des lignes sélectionnées" className={cn(champ, "py-1 text-xs")}>
                <option value="">Secteur…</option>
                <option value="__aucun">— Aucun</option>
                {secteurs.map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
              </select>
            )}
            {droits.saisir && (
              <select value="" onChange={(e) => { if (e.target.value) void changerEnLot("statut", e.target.value === "__aucun" ? "" : e.target.value); }} aria-label="Statut des lignes sélectionnées" className={cn(champ, "py-1 text-xs")}>
                <option value="">Statut…</option>
                <option value="__aucun">— Aucun</option>
                {STATUTS.map((s) => <option key={s} value={s}>{STATUT_LABELS[s]}</option>)}
              </select>
            )}
            {droits.panel && (
              <BoutonDecisif type="button" size="sm" variant="outline" confirmation={`Retirer ${selection.size} praticien(s) de la segmentation`} onClick={() => void retirer([...selection], false)}>
                Retirer
              </BoutonDecisif>
            )}
            <button type="button" onClick={() => setSelection(new Set())} className="text-muted-foreground underline">Désélectionner</button>
          </div>
        )}

        <div className="max-h-[calc(100dvh-14rem)] min-h-[240px] overflow-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                {avecSelection && (
                  <th className="sticky left-0 top-0 z-[3] w-9 min-w-9 border-b border-border bg-card px-2 py-2">
                    <input type="checkbox" checked={toutCoche} aria-label="Tout sélectionner"
                      onChange={() => setSelection(toutCoche ? new Set() : new Set(visibles.map((v) => v.doctorId)))} className="h-4 w-4 align-middle" />
                  </th>
                )}
                {entete("secteur", { info: <InfoBulle label="Secteur" align="left">Sans choix manuel, le secteur suit l&apos;établissement (ou son service). « In » : même wilaya que la ville pivot du secteur.</InfoBulle> })}
                {entete("cdr")}
                {entete("specialite")}
                {entete("nom", { collant: true })}
                {entete("prenom")}
                {entete("grade")}
                {entete("statut")}
                {entete("q1", { className: "text-center", libelle: <span className="max-w-[130px] whitespace-normal leading-tight">{enteteQ1(metrique)}</span> })}
                {entete("q2", {
                  className: "text-center",
                  libelle: <span className="max-w-[150px] whitespace-normal leading-tight">Q2 · sur 10 sous {produitQ2}</span>,
                  info: <InfoBulle label="Question 2">Sur 10 patients, combien sont sous {produitNom ?? "le produit #1"} ? Un entier de 0 à 10 ; vide = non renseigné (NA).</InfoBulle>,
                })}
                {entete("pct", { className: "text-right", info: <InfoBulle label="Affinité">{methode === "RATIO_FICHIER" ? "Q2 ÷ Q1, comme la formule du classeur." : "Q2 ÷ 10."} Calculé, non modifiable.</InfoBulle> })}
                {entete("potentiel", { className: "text-center", info: droits.forcer ? <InfoBulle label="Potentiel">Calculé depuis le statut, Q1 et Q2. Le forcer demande un motif ; « Calculée » rend le calcul.</InfoBulle> : undefined })}
                <th className="sticky top-0 z-[2] w-8 border-b border-border bg-card" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visibles.map((v) => (
                <LigneMemo
                  key={v.doctorId}
                  v={v}
                  ctx={ctx}
                  colEdition={edition?.id === v.doctorId ? edition.col : null}
                  initEdition={edition?.id === v.doctorId ? edition.init : undefined}
                  etats={etats[v.doctorId]}
                  selectionne={selection.has(v.doctorId)}
                  detail={details.has(v.doctorId)}
                  nbCols={nbCols}
                />
              ))}
              {visibles.length === 0 && (
                <tr><td colSpan={nbCols} className="px-4 py-6 text-center text-sm text-muted-foreground">{effectives.length === 0 ? "Le panel est vide : importez le fichier ou ajoutez des praticiens." : "Aucun praticien ne correspond."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {filtre && FILTRE_DE[filtre.col] && (
        <Flottant ancre={filtre.ancre} onFermer={() => setFiltre(null)} largeur={260}>
          <PanneauFiltre col={filtre.col} etat={etat} setEtat={setEtat} lignes={toutesTri} />
        </Flottant>
      )}

      {menu && menuLigne && (
        <Flottant ancre={menu.ancre} onFermer={() => setMenu(null)} largeur={250}>
          <div className="flex flex-col p-1 text-sm">
            <button type="button" className="rounded-md px-2.5 py-2 text-left hover:bg-secondary" onClick={() => { basculer("details", menu.id); setMenu(null); }}>
              {details.has(menu.id) ? "Masquer le calcul" : "Voir le calcul"}
            </button>
            <Link href={`/praticiens/${menu.id}`} className="rounded-md px-2.5 py-2 hover:bg-secondary">Fiche praticien</Link>
            {droits.panel && (
              <BoutonDecisif brut type="button" confirmation="Retirer de la segmentation" className="w-full rounded-md px-2.5 py-2 text-left hover:bg-secondary" onClick={() => void retirer([menu.id], false)}>
                Retirer de la segmentation
              </BoutonDecisif>
            )}
            {droits.panel && annuaire.supprimer && (
              <BoutonDecisif brut type="button" confirmation="Retirer et supprimer de l'annuaire" className="w-full rounded-md px-2.5 py-2 text-left text-destructive hover:bg-destructive/10" onClick={() => void retirer([menu.id], true)}>
                Supprimer aussi de l&apos;annuaire
              </BoutonDecisif>
            )}
          </div>
        </Flottant>
      )}

      {motif && motifLigne && ancreMotif && (
        <Flottant ancre={ancreMotif} onFermer={() => { setMotif(null); focaliser(motif.id, "potentiel"); }} largeur={280}>
          <FormMotif
            lettre={motif.lettre} calculee={motifLigne.lettreCalculee}
            onValider={(t) => forcer(motif.id, motif.lettre, t)}
            onAnnuler={() => { setMotif(null); focaliser(motif.id, "potentiel"); }}
          />
        </Flottant>
      )}

      {toast && (
        <div role={toast.erreur ? "alert" : "status"} className={cn("fixed bottom-4 left-1/2 z-50 max-w-[min(92vw,520px)] -translate-x-1/2 rounded-lg border px-4 py-2.5 text-sm shadow-lg", toast.erreur ? "border-destructive/30 bg-card text-destructive" : "border-border bg-card")}>
          {toast.texte}
        </div>
      )}
    </div>
  );
}
