"use client";

import * as React from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Filter, Loader2, MoreHorizontal, X } from "lucide-react";
import { cn, plier } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { STATUTS, STATUT_LABELS, LETTRES_FORCABLES, affiniteAffichee, type Comparaison, type Lettre, type MethodeAffinite, type Statut } from "@/lib/segmentation/regles";
import { lettreProvisoire, enteteQ1 } from "@/lib/segmentation/charge";
import { vueDuTableau, triSuivant, valeursDuFiltre, basculerValeur, retirerFiltre, effacerFiltres, nbFiltresActifs, urlAvecEtat, lireSaisieQ, casseNom, FILTRES_LISTE, FILTRES_TEXTE, FILTRES_PLAGE, type Colonne, type EtatTableau, type LigneTri, type FiltreListe, type FiltreTexte, type FiltrePlage, type CleFiltre } from "@/lib/segmentation/tableau-praticiens";
import { enregistrerPotentiel, changerStatut, forcerLettre, rendreLettreCalculee, changerSecteur, retirerDuPanel } from "@/lib/actions/segmentation-actions";
import { saveDirectoryCell, deleteDirectoryDoctors } from "@/lib/actions/medical-directory-actions";
import { LettreBadge } from "./lettre-badge";
import { AjoutPanel } from "./praticiens-table/ajout-panel";

/**
 * LES PRATICIENS — les colonnes du classeur (Secteur, CDR, Spécialité, Nom, Prénom, Grade, Statut, Q1, Q2, %, Potentiel),
 * éditées comme un tableur (Direction, 08/10) : un clic (ou Entrée) ouvre la cellule, Entrée / Tab enregistre et passe à la
 * suivante, Échap annule. Chaque colonne se trie et se filtre ; l'état vit dans l'URL (partageable).
 *
 * TOUT EST CONNECTÉ : Nom, Prénom, CDR, Spécialité et Grade sont ceux de la fiche de l'ANNUAIRE (mêmes actions, mêmes droits
 * que la feuille de l'annuaire) ; Secteur, Statut, Q1, Q2 et Potentiel sont ceux de la segmentation. Une cellule qu'on n'a pas
 * le droit de modifier est du texte. Un tableau reste un tableau au téléphone : il défile dans son cadre, le nom reste à gauche.
 */

export interface LignePraticien {
  doctorId: string;
  secteurId: string | null;
  secteurNom: string | null;
  secteurPose: boolean;
  /** L'établissement RATTACHÉ ; null avec un `etablissement` = texte « à rattacher ». */
  institutionId: string | null;
  etablissement: string | null;
  /** Seulement quand le praticien a un secteur (wilaya de la ville pivot) ; sinon rien. */
  inOut: "IN" | "OUT" | null;
  specialiteId: string | null;
  specialite: string | null;
  nomFamille: string;
  prenom: string | null;
  /** Le grade de la liste (enum) et son libellé ; `gradeBrut` = le grade hors liste du fichier (« KOL »). */
  titre: string;
  grade: string;
  gradeBrut: string | null;
  statut: Statut | null;
  q1: number | null;
  q2: number | null;
  /** null = aucune règle publiée. */
  lettre: Lettre | null;
  lettreCalculee: Lettre | null;
  forcee: { valeur: Lettre; motif: string } | null;
  pourquoi: string[];
}

/** Ce qu'il faut pour recalculer une lettre à l'écran, le temps que le serveur rende la sienne. */
export interface RegleEcran {
  hStatuts: Statut[];
  seuilPotentiel: number;
  seuilAffinite: number;
  comparaison: Comparaison;
  potentielNulNonCible: boolean;
  potentielNulNA: boolean;
  methode: MethodeAffinite;
  /** Seuil d'affinité propre à un secteur. */
  seuilParSecteur: Record<string, number>;
}

interface Droits { saisir: boolean; panel: boolean; valider: boolean; forcer: boolean }
interface DroitsAnnuaire { modifier: boolean; supprimer: boolean }
interface Choix { valeur: string; libelle: string; detail?: string }
type Local = Partial<Omit<LignePraticien, "doctorId" | "pourquoi">>;
type EtatCellule = "envoi" | "erreur";
/** Après validation : où va le curseur — « ici » = reste sur la cellule ; null = nulle part (la personne a cliqué ailleurs). */
type Deplacement = "bas" | "haut" | "droite" | "gauche" | "ici" | null;
type Resultat = { ok: boolean; error?: string };

export const champ = "rounded-lg border border-border bg-background px-2.5 py-2 text-sm sm:py-1.5";
const LIBELLES: Record<Colonne, string> = {
  secteur: "Secteur", cdr: "CDR", specialite: "Spécialité", nom: "Nom", prenom: "Prénom", grade: "Grade", statut: "Statut",
  q1: "Q1", q2: "Q2", pct: "%", potentiel: "Potentiel",
};
const FILTRE_DE: Partial<Record<Colonne, CleFiltre>> = {
  secteur: "secteur", cdr: "cdr", specialite: "specialite", nom: "nom", prenom: "prenom", grade: "grade", statut: "statut",
  q1: "q1", q2: "q2", pct: "pct", potentiel: "potentiel",
};
const estListe = (f: CleFiltre): f is FiltreListe => (FILTRES_LISTE as readonly string[]).includes(f);
const estTexte = (f: CleFiltre): f is FiltreTexte => (FILTRES_TEXTE as readonly string[]).includes(f);
const estPlage = (f: CleFiltre): f is FiltrePlage => (FILTRES_PLAGE as readonly string[]).includes(f);
const COLS_TEXTE: readonly Colonne[] = ["nom", "prenom", "q1", "q2"];

const fmt = (n: number | null) => (n === null ? "" : String(n).replace(".", ","));
const libelleLettre = (l: Lettre | null) => (l === null ? "—" : l === "NC" ? "non ciblé" : l);
const gradeAffiche = (v: LignePraticien) => (v.titre === "AUTRE" && v.gradeBrut ? v.gradeBrut : v.grade);

/** La ligne effective : celle du serveur, plus ce que la personne vient d'écrire (la lettre se recalcule à l'écran). */
function appliquer(l: LignePraticien, o: Local | undefined, regle: RegleEcran | null): LignePraticien {
  if (!o) return l;
  const v: LignePraticien = { ...l, ...o };
  if (regle && ("statut" in o || "q1" in o || "q2" in o || "secteurId" in o)) {
    const calc = lettreProvisoire({
      statut: v.statut, q1: v.q1, q2: v.q2, hStatuts: regle.hStatuts, seuilPotentiel: regle.seuilPotentiel, comparaison: regle.comparaison,
      seuilAffinite: (v.secteurId ? regle.seuilParSecteur[v.secteurId] : undefined) ?? regle.seuilAffinite, potentielNulNonCible: regle.potentielNulNonCible,
      methode: regle.methode, potentielNulNA: regle.potentielNulNA,
    });
    v.lettreCalculee = calc;
    if (!v.forcee) v.lettre = calc;
  }
  return v;
}

function versTri(v: LignePraticien, methode: MethodeAffinite): LigneTri {
  const spe = casseNom(v.specialite);
  return {
    secteur: v.secteurId ?? "", secteurLib: v.secteurNom ?? "",
    cdr: v.institutionId ?? (v.etablissement ? `t:${v.etablissement}` : ""), cdrLib: v.etablissement ?? "",
    io: v.secteurId && v.inOut ? v.inOut : "",
    specialite: v.specialiteId ?? (spe ? `t:${spe}` : ""), specialiteLib: spe,
    nom: v.nomFamille, prenom: v.prenom ?? "",
    grade: v.titre === "AUTRE" && v.gradeBrut ? `brut:${v.gradeBrut}` : v.titre, gradeLib: gradeAffiche(v),
    statut: v.statut ?? "",
    q1: v.q1, q2: v.q2, pct: affiniteAffichee(v.q1, v.q2, methode),
    potentiel: v.lettre ?? "",
  };
}

/** Le libellé d'une valeur de filtre, lu sur une ligne qui la porte. */
function libelleFiltre(f: FiltreListe, t: LigneTri): string {
  switch (f) {
    case "secteur": return t.secteurLib || "Sans secteur";
    case "cdr": return t.cdrLib || "Sans établissement";
    case "io": return t.io === "IN" ? "In" : t.io === "OUT" ? "Out" : "Non déterminé";
    case "specialite": return t.specialiteLib || "Sans spécialité";
    case "grade": return t.gradeLib || "—";
    case "statut": return t.statut ? STATUT_LABELS[t.statut as Statut] ?? t.statut : "Sans statut";
    case "potentiel": return t.potentiel ? (t.potentiel === "NC" ? "Non ciblé" : t.potentiel) : "Sans lettre";
  }
}

/** Plusieurs appels à la suite, quatre à la fois — un geste en lot ne sature pas le serveur. */
async function enLot<T>(ids: string[], f: (id: string) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 4) out.push(...(await Promise.all(ids.slice(i, i + 4).map(f))));
  return out;
}

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

// ─────────────────────────────── Une ligne ───────────────────────────────

interface CtxLigne {
  peut: Record<Colonne, boolean>;
  avecSelection: boolean;
  methode: MethodeAffinite;
  /** Les listes des menus, construites une fois pour tout le tableau. */
  options: Record<"secteur" | "cdr" | "specialite" | "grade" | "statut", Choix[]>;
  commencer: (id: string, col: Colonne, init?: string) => void;
  annuler: (id: string, col: Colonne, refocaliser: boolean) => void;
  valider: (id: string, col: Colonne, brut: string, dep: Deplacement) => void;
  toucheCellule: (e: React.KeyboardEvent<HTMLElement>, id: string, col: Colonne) => void;
  basculer: (ensemble: "selection" | "details", id: string) => void;
  ouvrirMenu: (id: string, ancre: HTMLElement) => void;
}

const LigneMemo = React.memo(function Ligne({ v, ctx, colEdition, initEdition, etats, selectionne, detail, nbCols }: {
  v: LignePraticien; ctx: CtxLigne; colEdition: Colonne | null; initEdition: string | undefined;
  etats: Partial<Record<Colonne, EtatCellule>> | undefined; selectionne: boolean; detail: boolean; nbCols: number;
}) {
  const id = v.doctorId;
  const cell = (col: Colonne, affichage: React.ReactNode, editeur: () => React.ReactNode, className?: string) => (
    <Cellule key={col} id={id} col={col} editable={ctx.peut[col]} enEdition={colEdition === col} etat={etats?.[col]} ctx={ctx} className={className} editeur={editeur}>
      {affichage}
    </Cellule>
  );
  const finir = (col: Colonne) => ({
    onValider: (brut: string, dep: Deplacement) => ctx.valider(id, col, brut, dep),
    onAnnuler: (refocaliser: boolean) => ctx.annuler(id, col, refocaliser),
  });
  // Ouvert en tapant : la recherche commence par ce caractère ; un texte « à rattacher » la préremplit, sélectionné.
  // Les listes ne se construisent qu'à l'ouverture de la cellule (`options` est une fonction) : 300 lignes × 600 établissements, non.
  const choix = (col: Colonne, options: () => Choix[], courant: string, aRetrouver?: string) => function editeurChoix() {
    return <EditeurChoix options={options()} courant={courant} recherche={initEdition ?? aRetrouver ?? ""} selectionner={initEdition === undefined} {...finir(col)} />;
  };
  const texte = (col: Colonne, valeur: string, numerique = false) => function editeurTexte() {
    return <EditeurTexte initial={initEdition ?? valeur} numerique={numerique} selectionner={initEdition === undefined} {...finir(col)} />;
  };
  const vide = <span className="text-muted-foreground">—</span>;
  const pct = affiniteAffichee(v.q1, v.q2, ctx.methode);
  const spe = casseNom(v.specialite);
  const aRattacher = !v.institutionId && !!v.etablissement;

  return (
    <>
      <tr className={cn("group hover:bg-secondary/30", selectionne && "bg-primary/5")}>
        {ctx.avecSelection && (
          <td className="sticky left-0 z-[1] w-9 border-b border-border bg-card px-2 py-1.5">
            <input type="checkbox" checked={selectionne} onChange={() => ctx.basculer("selection", id)} aria-label={`Sélectionner ${v.nomFamille}`} className="h-4 w-4 align-middle" />
          </td>
        )}
        {cell("secteur", v.secteurNom ?? vide,
          choix("secteur", () => ctx.options.secteur, v.secteurPose ? v.secteurId ?? "" : ""))}
        {cell("cdr", (
          <span className="inline-flex items-center gap-1.5">
            <span className="max-w-[240px] truncate" title={v.etablissement ?? undefined}>{v.etablissement ?? vide}</span>
            {aRattacher && <span className="rounded bg-warning/10 px-1 text-[10px] text-warning" title="Texte sans lien vers l'annuaire des établissements">à rattacher</span>}
            {v.secteurId && v.inOut && <span className="text-[11px] text-muted-foreground">{v.inOut === "IN" ? "In" : "Out"}</span>}
          </span>
        ), choix("cdr", () => ctx.options.cdr, v.institutionId ?? "", aRattacher ? v.etablissement ?? undefined : undefined))}
        {cell("specialite", spe || vide,
          choix("specialite", () => ctx.options.specialite, v.specialiteId ?? "", !v.specialiteId && spe ? spe : undefined))}
        {cell("nom", <span className="font-medium">{v.nomFamille}</span>, texte("nom", v.nomFamille), cn("sticky z-[1] bg-card", ctx.avecSelection ? "left-9" : "left-0"))}
        {cell("prenom", v.prenom ?? "", texte("prenom", v.prenom ?? ""))}
        {cell("grade", v.titre === "AUTRE" && v.gradeBrut
          ? <span className="italic" title="Grade hors liste (fichier) — choisissez un grade">{v.gradeBrut}</span>
          : v.grade,
          choix("grade", () => ctx.options.grade, v.titre === "AUTRE" && v.gradeBrut ? "" : v.titre))}
        {cell("statut", v.statut ? STATUT_LABELS[v.statut] : vide,
          choix("statut", () => ctx.options.statut, v.statut ?? ""))}
        {cell("q1", v.q1 === null ? vide : fmt(v.q1), texte("q1", fmt(v.q1), true), "text-center tabular-nums")}
        {cell("q2", v.q2 === null ? vide : fmt(v.q2), texte("q2", fmt(v.q2), true), "text-center tabular-nums")}
        <td className="whitespace-nowrap border-b border-border px-2.5 py-1.5 text-right tabular-nums">{pourcent(pct)}</td>
        {cell("potentiel", v.lettre ? (
          <span className="inline-flex items-center">
            <LettreBadge lettre={v.lettre} />
            {v.forcee && <span className="ml-1 text-[11px] text-warning" title={`Forcé — calculé : ${libelleLettre(v.lettreCalculee)} · ${v.forcee.motif}`}>✎</span>}
          </span>
        ) : vide, choix("potentiel", () => [
          ...(v.forcee ? [{ valeur: "__calc", libelle: `Calculée (${libelleLettre(v.lettreCalculee)})` }] : []),
          ...LETTRES_FORCABLES.map((x) => ({ valeur: x, libelle: x === "NC" ? "Non ciblé" : x })),
        ], v.forcee?.valeur ?? ""), "text-center")}
        <td className="whitespace-nowrap border-b border-border px-1 py-1.5 text-center">
          <button type="button" aria-label={`Actions : ${v.nomFamille}`} onClick={(e) => ctx.ouvrirMenu(id, e.currentTarget)} className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </td>
      </tr>
      {detail && (
        <tr className="bg-secondary/20">
          <td colSpan={nbCols} className="border-b border-border px-4 py-3 text-xs">
            <p className="font-semibold">
              <Link href={`/praticiens/${id}`} className="hover:underline">{[v.prenom, v.nomFamille].filter(Boolean).join(" ")}</Link>
              {v.lettreCalculee && <span className="font-normal text-muted-foreground"> · calculé : {libelleLettre(v.lettreCalculee)}</span>}
            </p>
            {v.pourquoi.length > 0
              ? <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">{v.pourquoi.map((t, i) => <li key={i}>{t}</li>)}</ul>
              : <p className="text-muted-foreground">Règles non publiées : aucun calcul.</p>}
            {v.forcee && <p className="mt-1"><span className="text-warning">✎</span> Forcé à {libelleLettre(v.forcee.valeur)} — {v.forcee.motif}</p>}
          </td>
        </tr>
      )}
    </>
  );
});

function Cellule({ id, col, editable, enEdition, etat, ctx, className, editeur, children }: {
  id: string; col: Colonne; editable: boolean; enEdition: boolean; etat: EtatCellule | undefined; ctx: CtxLigne;
  className?: string; editeur: () => React.ReactNode; children: React.ReactNode;
}) {
  return (
    <td
      data-cellule={editable ? `${id}|${col}` : undefined}
      tabIndex={editable && !enEdition ? 0 : undefined}
      onClick={editable && !enEdition ? () => ctx.commencer(id, col) : undefined}
      onKeyDown={editable && !enEdition ? (e) => ctx.toucheCellule(e, id, col) : undefined}
      className={cn(
        "relative whitespace-nowrap border-b border-border px-2.5 py-1.5 align-middle",
        editable && !enEdition && "cursor-pointer hover:bg-secondary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60",
        enEdition && "p-0.5",
        etat === "erreur" && "bg-destructive/10",
        className,
      )}
    >
      {enEdition ? editeur() : children}
      {etat === "envoi" && <Loader2 className="absolute right-0.5 top-0.5 h-3 w-3 animate-spin text-muted-foreground" aria-label="Enregistrement" />}
    </td>
  );
}

/** « 8,9 % » — une décimale ; « — » quand l'affinité ne se calcule pas. */
function pourcent(a: number | null): React.ReactNode {
  if (a === null) return <span className="text-muted-foreground">—</span>;
  return `${String(Math.round(a * 1000) / 10).replace(".", ",")} %`;
}

// ─────────────────────────────── Les éditeurs ───────────────────────────────

function touchesDeSortie(e: React.KeyboardEvent, valider: (dep: Deplacement) => void, annuler: () => void): boolean {
  if (e.key === "Enter") { e.preventDefault(); valider(e.shiftKey ? "haut" : "bas"); return true; }
  if (e.key === "Tab") { e.preventDefault(); valider(e.shiftKey ? "gauche" : "droite"); return true; }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); annuler(); return true; }
  return false;
}

function EditeurTexte({ initial, numerique, selectionner, onValider, onAnnuler }: {
  initial: string; numerique: boolean; selectionner: boolean; onValider: (brut: string, dep: Deplacement) => void; onAnnuler: (refocaliser: boolean) => void;
}) {
  const [texte, setTexte] = React.useState(initial);
  const fait = React.useRef(false);
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectionner) el.select(); else el.setSelectionRange(el.value.length, el.value.length);
  }, [selectionner]);
  const sortir = (dep: Deplacement) => { if (fait.current) return; fait.current = true; onValider(texte, dep); };
  const annuler = () => { if (fait.current) return; fait.current = true; onAnnuler(true); };
  return (
    <input
      ref={ref} value={texte} inputMode={numerique ? "decimal" : undefined} aria-label="Valeur"
      onChange={(e) => setTexte(e.target.value)}
      onKeyDown={(e) => { touchesDeSortie(e, sortir, annuler); }}
      onBlur={() => sortir(null)}
      onClick={(e) => e.stopPropagation()}
      className={cn("w-full min-w-[80px] rounded-md border border-primary bg-background px-2 py-1 text-sm outline-none", numerique && "w-[64px] min-w-0 text-center")}
    />
  );
}

/** UN MENU DÉROULANT QUI SE TAPE : la liste filtre à la frappe, ↑ ↓ choisissent, Entrée / Tab valident, Échap annule. */
function EditeurChoix({ options, courant, recherche, selectionner, onValider, onAnnuler }: {
  options: Choix[]; courant: string; recherche: string; selectionner: boolean; onValider: (brut: string, dep: Deplacement) => void; onAnnuler: (refocaliser: boolean) => void;
}) {
  const [q, setQ] = React.useState(recherche);
  const idListe = React.useId();
  const [ancre, setAncre] = React.useState<HTMLInputElement | null>(null);
  const fait = React.useRef(false);
  const filtrees = React.useMemo(() => {
    const mots = plier(q).split(/\s+/).filter(Boolean);
    const r = mots.length ? options.filter((o) => { const t = plier(`${o.libelle} ${o.detail ?? ""}`); return mots.every((m) => t.includes(m)); }) : options;
    return mots.length ? r.slice(0, 150) : r;
  }, [options, q]);
  const [iBrut, setI] = React.useState(() => (recherche ? 0 : Math.max(0, options.findIndex((o) => o.valeur === courant))));
  const i = Math.max(0, Math.min(iBrut, filtrees.length - 1));
  const qPrec = React.useRef(q);
  React.useEffect(() => { if (qPrec.current !== q) { qPrec.current = q; setI(0); } }, [q]);
  React.useEffect(() => {
    if (!ancre) return;
    ancre.focus();
    if (selectionner) ancre.select(); else ancre.setSelectionRange(ancre.value.length, ancre.value.length);
  }, [ancre, selectionner]);
  const listeRef = React.useRef<HTMLDivElement | null>(null);
  const iRef = React.useRef(i);
  iRef.current = i;
  const voir = (el: HTMLElement | null, k: number) => el?.querySelector<HTMLElement>(`[data-i="${k}"]`)?.scrollIntoView({ block: "nearest" });
  React.useEffect(() => { voir(listeRef.current, i); }, [i]);
  // La liste naît dans le panneau flottant après coup : à sa naissance, l'option en cours est amenée en vue.
  const poserListe = React.useCallback((el: HTMLDivElement | null) => { listeRef.current = el; voir(el, iRef.current); }, []);

  const choisir = (o: Choix | undefined, dep: Deplacement) => {
    if (fait.current) return;
    fait.current = true;
    if (o) onValider(o.valeur, dep); else onAnnuler(true);
  };
  const annuler = (refocaliser: boolean) => { if (fait.current) return; fait.current = true; onAnnuler(refocaliser); };
  const courantLib = options.find((o) => o.valeur === courant)?.libelle ?? "";
  return (
    <>
      <input
        ref={setAncre} value={q} placeholder={courantLib || "Choisir…"} aria-label="Choisir" role="combobox" aria-expanded={true} aria-controls={idListe} aria-autocomplete="list"
        onChange={(e) => setQ(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(filtrees.length - 1, x + 1)); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); return; }
          touchesDeSortie(e, (dep) => choisir(filtrees[i], dep), () => annuler(true));
        }}
        className="w-full min-w-[140px] rounded-md border border-primary bg-background px-2 py-1 text-sm outline-none"
      />
      {ancre && (
        <Flottant ancre={ancre} onFermer={() => annuler(false)} largeur={Math.max(220, Math.min(360, ancre.getBoundingClientRect().width + 80))} garderFocus>
          <div ref={poserListe} id={idListe} role="listbox" className="py-1 text-sm">
            {filtrees.map((o, k) => (
              <div
                key={o.valeur || "__vide"} data-i={k} role="option" aria-selected={k === i}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setI(k)}
                onClick={() => choisir(o, "ici")}
                className={cn("flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5", k === i && "bg-secondary", o.valeur === courant && "font-semibold")}
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">{o.libelle}</span>
                {o.detail && <span className="shrink-0 text-xs text-muted-foreground">{o.detail}</span>}
              </div>
            ))}
            {filtrees.length === 0 && <p className="px-3 py-2 text-muted-foreground">Aucun résultat.</p>}
          </div>
        </Flottant>
      )}
    </>
  );
}

function FormMotif({ lettre, calculee, onValider, onAnnuler }: { lettre: Lettre; calculee: Lettre | null; onValider: (motif: string) => void; onAnnuler: () => void }) {
  const [t, setT] = React.useState("");
  const ok = t.trim().length >= 3;
  return (
    <form className="space-y-2 p-3 text-sm" onSubmit={(e) => { e.preventDefault(); if (ok) onValider(t.trim()); }}>
      <p className="font-medium">Forcer à {libelleLettre(lettre)} <span className="font-normal text-muted-foreground">(calculé : {libelleLettre(calculee)})</span></p>
      <input autoFocus value={t} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onAnnuler(); } }} placeholder="Motif (obligatoire)" aria-label="Motif" className={cn(champ, "w-full")} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onAnnuler}>Annuler</Button>
        <Button type="submit" size="sm" disabled={!ok}>Forcer</Button>
      </div>
    </form>
  );
}

// ─────────────────────────────── Le filtre d'une colonne ───────────────────────────────

function PanneauFiltre({ col, etat, setEtat, lignes }: { col: Colonne; etat: EtatTableau; setEtat: React.Dispatch<React.SetStateAction<EtatTableau>>; lignes: LigneTri[] }) {
  const f = FILTRE_DE[col]!;
  if (estTexte(f)) {
    return (
      <div className="p-3">
        <input autoFocus value={etat.textes[f] ?? ""} onChange={(e) => { const t = e.target.value; setEtat((x) => ({ ...x, textes: { ...x.textes, [f]: t } })); }} placeholder="Contient…" aria-label={`${LIBELLES[col]} contient`} className={cn(champ, "w-full")} />
      </div>
    );
  }
  if (estPlage(f)) {
    const p = etat.plages[f] ?? { min: null, max: null };
    const poser = (cle: "min" | "max", s: string) => {
      const t = s.trim().replace(",", ".");
      const n = t === "" ? null : Number(t);
      if (n !== null && !Number.isFinite(n)) return;
      setEtat((x) => ({ ...x, plages: { ...x.plages, [f]: { ...(x.plages[f] ?? { min: null, max: null }), [cle]: n } } }));
    };
    return (
      <div className="flex items-center gap-2 p-3 text-sm">
        <input autoFocus defaultValue={fmt(p.min)} onChange={(e) => poser("min", e.target.value)} inputMode="decimal" placeholder="min" aria-label="Minimum" className={cn(champ, "w-20")} />
        <span className="text-muted-foreground">à</span>
        <input defaultValue={fmt(p.max)} onChange={(e) => poser("max", e.target.value)} inputMode="decimal" placeholder="max" aria-label="Maximum" className={cn(champ, "w-20")} />
        {f === "pct" && <span className="text-muted-foreground">%</span>}
      </div>
    );
  }
  return (
    <div className="max-h-[inherit] overflow-y-auto">
      <ListeFiltre f={f as FiltreListe} etat={etat} setEtat={setEtat} lignes={lignes} />
      {col === "cdr" && (
        <div className="border-t border-border">
          <p className="px-3 pt-2 text-[11px] font-medium uppercase text-muted-foreground">In / Out</p>
          <ListeFiltre f="io" etat={etat} setEtat={setEtat} lignes={lignes} />
        </div>
      )}
    </div>
  );
}

function ListeFiltre({ f, etat, setEtat, lignes }: { f: FiltreListe; etat: EtatTableau; setEtat: React.Dispatch<React.SetStateAction<EtatTableau>>; lignes: LigneTri[] }) {
  const [q, setQ] = React.useState("");
  const valeurs = React.useMemo(() => valeursDuFiltre(lignes, f, (l) => libelleFiltre(f, l)), [lignes, f]);
  const choisis = etat.listes[f] ?? [];
  const mots = plier(q).trim();
  const montrees = mots ? valeurs.filter((v) => plier(v.libelle).includes(mots)) : valeurs;
  return (
    <div className="text-sm">
      {valeurs.length > 8 && (
        <div className="p-2 pb-1"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher…" aria-label="Chercher une valeur" className={cn(champ, "w-full py-1")} /></div>
      )}
      <div className="py-1">
        {montrees.map((v) => (
          <label key={v.valeur || "__vide"} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-secondary">
            <input type="checkbox" checked={choisis.includes(v.valeur)} onChange={() => setEtat((x) => basculerValeur(x, f, v.valeur))} className="h-4 w-4" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{v.libelle}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{v.n}</span>
          </label>
        ))}
        {montrees.length === 0 && <p className="px-3 py-1.5 text-muted-foreground">Aucune valeur.</p>}
      </div>
      {choisis.length > 0 && (
        <button type="button" onClick={() => setEtat((x) => retirerFiltre(x, f))} className="w-full border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground">Tout afficher</button>
      )}
    </div>
  );
}

// ─────────────────────────────── Le panneau flottant ───────────────────────────────

/**
 * UN PANNEAU POSÉ SOUS SON ANCRE, hors du cadre qui défile (portail) : un menu dans un tableau à défilement serait rogné.
 * Il suit l'ancre quand le tableau défile, s'ouvre au-dessus s'il manque de place, et se ferme au clic ailleurs ou à Échap.
 */
function Flottant({ ancre, onFermer, largeur, garderFocus, children }: { ancre: HTMLElement; onFermer: () => void; largeur: number; garderFocus?: boolean; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; left: number; maxH: number } | null>(null);
  const fermer = React.useRef(onFermer);
  fermer.current = onFermer;
  React.useLayoutEffect(() => {
    const placer = () => {
      const r = ancre.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const left = Math.max(8, Math.min(r.left, vw - largeur - 8));
      const dessous = vh - r.bottom - 12, dessus = r.top - 12;
      setPos(dessous >= 220 || dessous >= dessus
        ? { top: r.bottom + 4, left, maxH: Math.max(140, Math.min(360, dessous)) }
        : { bottom: vh - r.top + 4, left, maxH: Math.max(140, Math.min(360, dessus)) });
    };
    placer();
    window.addEventListener("scroll", placer, true);
    window.addEventListener("resize", placer);
    return () => { window.removeEventListener("scroll", placer, true); window.removeEventListener("resize", placer); };
  }, [ancre, largeur]);
  React.useEffect(() => {
    const ailleurs = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || ancre.contains(t)) return;
      fermer.current();
    };
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape" && !garderFocus) fermer.current(); };
    document.addEventListener("mousedown", ailleurs);
    document.addEventListener("touchstart", ailleurs);
    document.addEventListener("keydown", echap);
    return () => {
      document.removeEventListener("mousedown", ailleurs);
      document.removeEventListener("touchstart", ailleurs);
      document.removeEventListener("keydown", echap);
    };
  }, [ancre, garderFocus]);
  if (!pos || typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: largeur, maxHeight: pos.maxH }} className="fixed z-50 overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
      {children}
    </div>,
    document.body,
  );
}
