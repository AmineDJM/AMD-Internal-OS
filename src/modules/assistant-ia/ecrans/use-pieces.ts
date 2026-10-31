"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PieceJointe } from "./pieces-jointes";
import { deposeDesFichiers, depuisListe, lireDepot, nommerCollage, televerser } from "./depot-navigateur";
import { useDepotDossier } from "./depot-dossier";
import { avertissementPiece, miniaturePossible, phraseRefus, planifierDepot, retirerPieces, type Parcours } from "../domaine/lecture/depot";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES DU MESSAGE EN PRÉPARATION (décision 0015) — une seule implémentation pour l'ERP et l'app Adventum IA.
 *
 * Chaque fichier déposé, collé ou choisi devient une PUCE — rien n'est téléversé avant l'envoi. Les bornes (nombre,
 * taille, doublons) et les fichiers système écartés sont dits en clair. Le glisser-déposer vaut sur toute la fenêtre
 * (la zone de dépôt apparaît dès que des FICHIERS la survolent) ; coller une image ou un fichier en fait une puce.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function usePieces(onErreur: (e: string) => void) {
  const [pieces, setPieces] = useState<PieceJointe[]>([]);
  // Les pièces du message en préparation, lues par l'envoi (l'état React n'est pas encore à jour dans un même geste).
  const piecesRef = useRef<PieceJointe[]>([]);
  useEffect(() => { piecesRef.current = pieces; }, [pieces]);
  const [televersement, setTeleversement] = useState(false);
  const [avisDepot, setAvisDepot] = useState<string | null>(null);
  const [survol, setSurvol] = useState(false);
  // J11 + K3 : au-delà de 6 pièces (dossier OU fichiers isolés), UNE puce — le mode « dépôt » (décisions 0030, 0033).
  const depot = useDepotDossier(setAvisDepot);
  const proposerDossier = useRef(depot.proposer);
  proposerDossier.current = depot.proposer;

  const joindre = useCallback((parcours: Parcours<File>) => {
    // K3 (décision 0033) : au-delà de 6 pièces, le DÉPÔT D'OFFICE — les puces locales du message le rejoignent.
    const locales = piecesRef.current.filter((p) => p.fichier && !p.id);
    const deja = locales.map((p) => ({ chemin: p.nom, fichier: p.fichier! }));
    if (proposerDossier.current(parcours, deja, piecesRef.current.length - locales.length)) {
      if (locales.length) {
        for (const p of locales) if (p.miniature) URL.revokeObjectURL(p.miniature);
        piecesRef.current = piecesRef.current.filter((p) => !locales.includes(p));
        setPieces(piecesRef.current);
      }
      return;
    }
    const dejaLa = piecesRef.current.map((p) => ({ chemin: p.nom, taille: p.taille ?? 0 }));
    const { acceptes, refus } = planifierDepot(dejaLa, parcours.trouves.map((t) => ({ ...t, taille: t.fichier.size })));
    const neuves: PieceJointe[] = acceptes.map((a) => ({
      cle: `${Date.now()}-${Math.random().toString(36).slice(2)}`, nom: a.chemin, taille: a.fichier.size, type: a.fichier.type,
      fichier: a.fichier, etat: "attente", avertissement: avertissementPiece(a.chemin),
      miniature: miniaturePossible(a.fichier.name, a.fichier.type) ? URL.createObjectURL(a.fichier) : undefined,
    }));
    if (neuves.length) {
      piecesRef.current = [...piecesRef.current, ...neuves];
      setPieces(piecesRef.current);
    }
    setAvisDepot(phraseRefus(refus, parcours.ignores, parcours.tronque));
  }, []);

  /** Ajouter une pièce DÉJÀ dans le Drive (« Demander une modification », document d'un dossier…). */
  const joindreDuDrive = useCallback((p: { id: string; nom: string }) => {
    if (piecesRef.current.some((x) => x.id === p.id)) return;
    piecesRef.current = [...piecesRef.current, { cle: `drive-${p.id}`, nom: p.nom, id: p.id, etat: "prete" }];
    setPieces(piecesRef.current);
  }, []);

  /** Retirer des puces : rien n'a été téléversé, rien ne reste dans le Drive ; la miniature est libérée. */
  const retirer = useCallback((cles: string[]) => {
    const { restantes, retirees } = retirerPieces(piecesRef.current, cles);
    for (const p of retirees) if (p.miniature) URL.revokeObjectURL(p.miniature);
    piecesRef.current = restantes;
    setPieces(restantes);
    setAvisDepot(retirees.length ? `${retirees.length} pièce${retirees.length > 1 ? "s" : ""} retirée${retirees.length > 1 ? "s" : ""}.` : null);
  }, []);

  const majPiece = (cle: string, maj: Partial<PieceJointe>) => {
    piecesRef.current = piecesRef.current.map((p) => (p.cle === cle ? { ...p, ...maj } : p));
    setPieces(piecesRef.current);
  };

  /**
   * À L'ENVOI SEULEMENT : chaque fichier part dans le Drive (progression sur sa puce). Un échec arrête l'envoi — le
   * message ne part pas avec une pièce manquante ; la puce dit pourquoi. Rend les pièces prêtes, ou `null`.
   */
  const preparerPieces = async (): Promise<{ id: string; nom: string }[] | null> => {
    setTeleversement(true);
    try {
      // J11 : les pièces venues d'un dossier rejoignent son arborescence recréée dans le Drive.
      let cibles: Record<string, string> = {};
      try {
        cibles = await depot.ciblesDesPieces(piecesRef.current.filter((p) => !p.id && p.fichier).map((p) => ({ chemin: p.nom, taille: p.taille ?? 0 })));
      } catch (e) {
        onErreur(`${e instanceof Error ? e.message : "Le dossier n'a pas pu être recréé dans votre Drive."} Le message n'est pas parti.`);
        return null;
      }
      for (const p of [...piecesRef.current]) {
        if (p.id || !p.fichier) continue;
        majPiece(p.cle, { etat: "envoi", progression: 0, erreur: undefined });
        const r = await televerser(p.fichier, (part) => majPiece(p.cle, { progression: part }), cibles[p.nom]);
        if ("erreur" in r) {
          majPiece(p.cle, { etat: "erreur", erreur: r.erreur });
          onErreur(`« ${p.nom} » n'a pas pu être joint : ${r.erreur} Le message n'est pas parti — retirez la pièce ou réessayez.`);
          return null;
        }
        majPiece(p.cle, { etat: "prete", id: r.id, fichier: undefined, progression: 1 });
      }
      const pretes = piecesRef.current.filter((p): p is PieceJointe & { id: string } => !!p.id).map((p) => ({ id: p.id, nom: p.nom }));
      for (const p of piecesRef.current) if (p.miniature) URL.revokeObjectURL(p.miniature);
      piecesRef.current = [];
      setPieces([]);
      setAvisDepot(null);
      return pretes;
    } finally {
      setTeleversement(false);
    }
  };

  // ── LE GLISSER-DÉPOSER, SUR TOUTE LA CONVERSATION ──────────────────────────────────────────────
  const profondeur = useRef(0);
  useEffect(() => {
    const entre = (e: DragEvent) => {
      if (!deposeDesFichiers(e.dataTransfer)) return;
      e.preventDefault();
      profondeur.current++;
      setSurvol(true);
    };
    const passe = (e: DragEvent) => {
      if (!deposeDesFichiers(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const sort = (e: DragEvent) => {
      if (!deposeDesFichiers(e.dataTransfer)) return;
      profondeur.current = Math.max(0, profondeur.current - 1);
      if (!profondeur.current) setSurvol(false);
    };
    const depose = (e: DragEvent) => {
      if (!deposeDesFichiers(e.dataTransfer) || !e.dataTransfer) return;
      // Jamais la page qui s'en va vers le fichier : le dépôt est pour la conversation.
      e.preventDefault();
      profondeur.current = 0;
      setSurvol(false);
      const dt = e.dataTransfer;
      void (async () => {
        try { joindre(await lireDepot(dt)); } catch { setAvisDepot("Le dépôt n'a pas pu être lu. Réessayez avec le trombone."); }
      })();
    };
    const quitte = () => { profondeur.current = 0; setSurvol(false); };
    window.addEventListener("dragenter", entre);
    window.addEventListener("dragover", passe);
    window.addEventListener("dragleave", sort);
    window.addEventListener("drop", depose);
    window.addEventListener("dragend", quitte);
    return () => {
      window.removeEventListener("dragenter", entre);
      window.removeEventListener("dragover", passe);
      window.removeEventListener("dragleave", sort);
      window.removeEventListener("drop", depose);
      window.removeEventListener("dragend", quitte);
    };
  }, [joindre]);

  // COLLER (Ctrl+V) une image ou un fichier : il devient une puce ; un texte collé reste du texte.
  useEffect(() => {
    const colle = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files ?? []);
      if (!f.length) return;
      e.preventDefault();
      joindre(depuisListe(f.map(nommerCollage)));
    };
    document.addEventListener("paste", colle);
    return () => document.removeEventListener("paste", colle);
  }, [joindre]);

  return { pieces, piecesRef, joindre, joindreDuDrive, retirer, preparerPieces, televersement, avisDepot, survol, depot };
}
