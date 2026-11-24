"use client";

import * as React from "react";
import { cleParPersonne } from "@/lib/vue-exacte-ui";
import {
  aEnvoyer, apresEnvoi, CLE_BROUILLONS_VISITE, lireBrouillons, rangerBrouillon,
  type BrouillonVisite, type IssueEnvoiBrouillon,
} from "@/lib/sfe/brouillons-visite";
import { REFUS_SANS_MOTIF } from "@/components/shared/use-action";
import { envoyerAvecDelai } from "./envoi-visite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FILE DES RAPPORTS EN ATTENTE, DANS LE TÉLÉPHONE (11/2026).
 *
 * Les règles sont pures (`sfe/brouillons-visite.ts`) ; ici, le stockage et le réveil. Le stockage est le
 * `localStorage` RANGÉ PAR PERSONNE (`cleParPersonne`) : deux délégués qui se passent un téléphone ne
 * s'envoient pas leurs comptes rendus. Un rapport ne porte que du texte — pas besoin d'IndexedDB, que la file
 * vocale du J13 utilise pour ses fichiers audio.
 *
 * La file se vide au retour du réseau (`online`), à l'ouverture de l'écran, et toutes les minutes tant qu'il reste
 * quelque chose : le navigateur ne signale pas toujours le retour du réseau d'un téléphone sorti d'un sous-sol.
 * Sans stockage (navigation privée), la file vit en mémoire le temps de l'écran.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

function relire(personneId: string): BrouillonVisite[] {
  try {
    return lireBrouillons(localStorage.getItem(cleParPersonne(CLE_BROUILLONS_VISITE, personneId)));
  } catch {
    return []; // stockage indisponible : la file vit en mémoire, l'écran le dira par l'indicateur
  }
}

function ecrire(personneId: string, liste: readonly BrouillonVisite[]): void {
  try {
    if (liste.length === 0) localStorage.removeItem(cleParPersonne(CLE_BROUILLONS_VISITE, personneId));
    else localStorage.setItem(cleParPersonne(CLE_BROUILLONS_VISITE, personneId), JSON.stringify(liste));
  } catch {
    // stockage plein ou interdit : la file reste en mémoire pour cet écran
  }
}

const enLigneMaintenant = () => typeof navigator === "undefined" || navigator.onLine !== false;

/** Reconstruit le formulaire d'un brouillon, champ pour champ, tel qu'il avait été rempli. */
export function formulaireDe(b: BrouillonVisite): FormData {
  const fd = new FormData();
  for (const [k, v] of b.champs) fd.append(k, v);
  return fd;
}

export function useBrouillonsVisite(personneId: string, onEnvoye: () => void) {
  const [liste, setListe] = React.useState<BrouillonVisite[]>([]);
  const [enLigne, setEnLigne] = React.useState(true);
  const courante = React.useRef<BrouillonVisite[]>([]);
  const enCours = React.useRef(false);
  // Le rappel de l'écran hôte change à chaque rendu : on lit le dernier, sans relancer l'abonnement au réseau.
  const rappel = React.useRef(onEnvoye);
  rappel.current = onEnvoye;

  const poser = React.useCallback((n: BrouillonVisite[]) => {
    courante.current = n;
    setListe(n);
    ecrire(personneId, n);
  }, [personneId]);

  const garder = React.useCallback((b: BrouillonVisite) => poser(rangerBrouillon(courante.current, b)), [poser]);
  const retirer = React.useCallback((id: string) => poser(courante.current.filter((b) => b.id !== id)), [poser]);

  const vider = React.useCallback(async () => {
    if (enCours.current || !enLigneMaintenant()) return;
    const file = aEnvoyer(courante.current);
    if (file.length === 0) return;
    enCours.current = true;
    let envoyes = 0;
    try {
      for (const b of file) {
        const avant = enLigneMaintenant();
        let issue: IssueEnvoiBrouillon;
        try {
          const r = await envoyerAvecDelai(b.sorte, formulaireDe(b));
          issue = r.ok ? { kind: "OK" } : { kind: "REFUS", erreur: r.error ?? REFUS_SANS_MOTIF };
        } catch {
          issue = { kind: "RESEAU" };
        }
        const suite = apresEnvoi(b, issue, avant);
        if (suite) poser(rangerBrouillon(courante.current.filter((x) => x.id !== b.id), suite));
        else { poser(courante.current.filter((x) => x.id !== b.id)); envoyes += 1; }
        // Le réseau est retombé : inutile d'user la batterie sur les suivants.
        if (issue.kind === "RESEAU") break;
      }
    } finally {
      enCours.current = false;
    }
    if (envoyes > 0) rappel.current();
  }, [poser]);

  /** Remettre en file un brouillon « à vérifier » ou refusé — c'est la personne qui le décide, après vérification. */
  const renvoyer = React.useCallback((id: string) => {
    poser(courante.current.map((b) => (b.id === id ? { ...b, etat: "EN_ATTENTE" as const, erreur: null } : b)));
    void vider();
  }, [poser, vider]);

  React.useEffect(() => {
    courante.current = relire(personneId);
    setListe(courante.current);
    setEnLigne(enLigneMaintenant());
    const enLigneRevenu = () => { setEnLigne(true); void vider(); };
    const horsLigne = () => setEnLigne(false);
    window.addEventListener("online", enLigneRevenu);
    window.addEventListener("offline", horsLigne);
    void vider();
    const minuterie = setInterval(() => { if (courante.current.some((b) => b.etat === "EN_ATTENTE")) void vider(); }, 60_000);
    return () => {
      window.removeEventListener("online", enLigneRevenu);
      window.removeEventListener("offline", horsLigne);
      clearInterval(minuterie);
    };
  }, [personneId, vider]);

  return { liste, enLigne, garder, retirer, renvoyer, vider };
}
