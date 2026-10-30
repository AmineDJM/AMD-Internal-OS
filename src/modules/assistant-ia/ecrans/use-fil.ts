"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "./chat-message-list";
import type { AudioDuTour, LecturePiece, VocalDuTour } from "../domaine/lecture/regles";
import { envoyerAuFil, reglerMaReponseVocale } from "@/modules/assistant-ia/actions";
import { creerMaConversation } from "@/modules/assistant-ia/actions-conversations";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FIL D'UNE CONVERSATION, CÔTÉ ÉCRAN — une seule implémentation pour l'ERP (`/assistant`) et l'app
 * Adventum IA (décision 0027).
 *
 * La conversation vit sur le serveur : à l'ouverture, on la relit telle qu'elle est ; tant qu'un tour s'écrit, une
 * lecture toutes les 0,9 s ; sinon toutes les 15 s (la présence). « Nouvelle conversation » (`nouvelle`) n'existe
 * pas encore en base : rien n'est lu ; le PREMIER envoi la crée — privée ou non, dans un dossier ou non — puis écrit.
 * En « Vue exacte », rien n'est écrit dans le fil de la personne regardée : conversation de l'onglet, jouée dans la requête.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un tour du fil tel que le serveur le rend (`/api/assistant-ia/fil`). */
export interface TourDuFil {
  id: string;
  role: "user" | "assistant";
  contenu: string;
  etat: "EN_ATTENTE" | "EN_COURS" | "TRAITE" | "TERMINE" | "ECHEC";
  pieces?: { id: string; nom: string }[] | null;
  blocs?: ChatMessage["blocs"] | null;
  intent?: ChatMessage["intent"] | null;
  memoireProposee?: ChatMessage["memoireProposee"] | null;
  notesProposees?: ChatMessage["notesProposees"] | null;
  outils?: string[];
  etapes?: string[];
  vocal?: VocalDuTour | null;
  lecture?: LecturePiece[] | null;
  audio?: AudioDuTour | null;
  piecesRendues?: { id: string; nom: string }[] | null;
  createdAt: string;
}

export function versMessage(t: TourDuFil): ChatMessage {
  if (t.role === "user") {
    return {
      id: t.id, role: "user", content: t.contenu, pieces: t.pieces ?? undefined, createdAt: t.createdAt,
      vocal: t.vocal ?? null, lectures: t.lecture ?? null,
      etat: t.etat === "EN_ATTENTE" ? "attente" : undefined,
    };
  }
  const redaction = t.etat === "EN_COURS";
  return {
    id: t.id, role: "assistant", content: t.contenu, createdAt: t.createdAt,
    blocs: t.blocs ?? undefined, intent: t.intent ?? null, memoireProposee: t.memoireProposee ?? null, notesProposees: t.notesProposees ?? null, audio: t.audio ?? null,
    piecesRendues: t.piecesRendues ?? null,
    outilsAppeles: redaction ? t.etapes ?? [] : (t.outils?.length ? t.outils : t.etapes ?? []),
    etat: redaction ? "redaction" : t.etat === "ECHEC" ? "echec" : undefined,
  };
}

export interface CibleFil {
  /** La conversation ouverte ; `null` = la conversation courante du serveur (ancien écran, ancien lien). */
  conversation: string | null;
  /** « Nouvelle conversation » : pas encore en base — le premier envoi la crée avec ces choix. */
  nouvelle?: { prive: boolean; dossierId: string | null } | null;
  /** Le serveur a dit quelle conversation est ouverte (courante lue, ou nouvelle créée au premier envoi). */
  onConversation?: (c: { id: string; titre: string | null; prive: boolean; dossierId: string | null }) => void;
  /**
   * « Vue exacte » : le tour joué DANS la requête, sans rien garder — l'action de l'écran `/assistant`, qui la passe.
   * Absente (app Adventum IA), la Vue exacte n'écrit rien et le dit.
   */
  tourLocal?: TourLocal;
}

export type TourLocal = (texte: string, page: undefined, historique: { role: "user" | "assistant"; content: string }[], pieces: Pieces) => Promise<
  | { ok: true; messageId: string; content: string; blocs?: ChatMessage["blocs"]; memoireProposee?: ChatMessage["memoireProposee"]; outilsAppeles?: string[]; intent?: ChatMessage["intent"] }
  | { ok: false; error?: string }
>;

type Pieces = { id: string; nom: string }[];

export function useFil({ conversation, nouvelle, onConversation, tourLocal }: CibleFil) {
  const [fil, setFil] = useState<ChatMessage[]>([]);
  const [travaille, setTravaille] = useState(false);
  const [vueExacte, setVueExacte] = useState(false);
  const [locaux, setLocaux] = useState<ChatMessage[]>([]);
  const [localEnCours, setLocalEnCours] = useState(false);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  // L'option « réponse vocale » est un réglage de la personne : elle suit d'un appareil à l'autre.
  const [reponseVocale, setReponseVocale] = useState(false);

  const lire = useCallback(async (): Promise<boolean> => {
    if (nouvelle) return false;
    try {
      const r = await fetch(`/api/assistant-ia/fil${conversation ? `?c=${encodeURIComponent(conversation)}` : ""}`, { cache: "no-store" });
      if (!r.ok) return false;
      const d = (await r.json()) as {
        tours: TourDuFil[]; enCours: boolean; vueExacte: boolean; reponseVocale?: boolean;
        conversation?: { id: string; titre: string | null; prive: boolean; dossierId: string | null };
      };
      setVueExacte(d.vueExacte);
      setReponseVocale(d.reponseVocale === true);
      setFil(d.tours.map(versMessage));
      setTravaille(d.enCours);
      if (d.conversation) onConversation?.(d.conversation);
      return d.enCours;
    } catch {
      return false;
    }
  }, [conversation, nouvelle, onConversation]);

  // Changer de conversation : on n'affiche jamais l'ancienne sous le titre de la nouvelle — sauf quand la « nouvelle »
  // vient de NAÎTRE au premier envoi : son message provisoire reste affiché jusqu'à la lecture du serveur.
  const vientDeNaitre = useRef(false);
  useEffect(() => {
    if (vientDeNaitre.current) { vientDeNaitre.current = false; return; }
    setFil([]); setTravaille(false); setErreur(null);
  }, [conversation, nouvelle]);

  useEffect(() => {
    let arret = false;
    let minuteur: ReturnType<typeof setTimeout> | undefined;
    const boucle = async () => {
      clearTimeout(minuteur);
      const enCours = await lire();
      if (!arret) minuteur = setTimeout(boucle, enCours ? 900 : 15_000);
    };
    void boucle();
    const relancer = () => void boucle();
    const auRetour = () => { if (document.visibilityState === "visible") void boucle(); };
    window.addEventListener("assistant-fil:relancer", relancer);
    document.addEventListener("visibilitychange", auRetour);
    return () => {
      arret = true;
      clearTimeout(minuteur);
      window.removeEventListener("assistant-fil:relancer", relancer);
      document.removeEventListener("visibilitychange", auRetour);
    };
  }, [lire]);

  /** La conversation où écrire : celle ouverte, ou — pour une nouvelle — créée maintenant (privée choisie ICI). */
  const conversationPourEcrire = async (): Promise<string | null | { erreur: string }> => {
    if (!nouvelle) return conversation;
    const r = await creerMaConversation(nouvelle.prive, nouvelle.dossierId);
    if (!r.ok) return { erreur: r.erreur };
    vientDeNaitre.current = true;
    onConversation?.({ id: r.conversation, titre: null, prive: nouvelle.prive, dossierId: nouvelle.dossierId });
    return r.conversation;
  };

  /** Vue exacte seulement : le tour joué dans la requête, comme avant, sans rien garder. */
  const envoyerLocal = async (text: string, pretes: Pieces) => {
    const userMsg: ChatMessage = { id: `usr-${Date.now()}`, role: "user", content: text, pieces: pretes, createdAt: new Date().toISOString() };
    const historique = locaux.map((m) => ({ role: m.role, content: m.content }));
    setLocaux((prev) => [...prev, userMsg]);
    if (!tourLocal) {
      setLocaux((prev) => [...prev, { id: `err-${Date.now()}`, role: "assistant", content: "Indisponible en « Vue exacte » dans Adventum IA : ouvrez l'Assistant de l'ERP.", etat: "echec" }]);
      return;
    }
    setLocalEnCours(true);
    try {
      const res = await tourLocal(text, undefined, historique, pretes);
      setLocaux((prev) => [...prev, res.ok
        ? { id: res.messageId, role: "assistant", content: res.content, blocs: res.blocs, memoireProposee: res.memoireProposee ?? null, outilsAppeles: res.outilsAppeles, intent: res.intent || null, createdAt: new Date().toISOString() }
        : { id: `err-${Date.now()}`, role: "assistant", content: res.error || "Une erreur est survenue lors du traitement.", etat: "echec" }]);
    } catch {
      setLocaux((prev) => [...prev, { id: `err-${Date.now()}`, role: "assistant", content: "La connexion a été interrompue. Réessayez dans un instant.", etat: "echec" }]);
    } finally {
      setLocalEnCours(false);
    }
  };

  /**
   * DÉPOSER, AVEC UN MESSAGE PROVISOIRE : affiché tout de suite (remplacé par le tour du serveur à la lecture suivante),
   * la conversation créée si elle est nouvelle, puis `deposer` (qui rend le refus à dire, ou `null`). Au moindre échec,
   * le provisoire s'en va et l'erreur est dite. « reseau » : la connexion a coupé (rien n'est parti).
   */
  const deposerAvecProvisoire = async (provisoire: ChatMessage, deposer: (cible: string | null) => Promise<string | null>, coupure: string): Promise<"ok" | "refus" | "reseau"> => {
    const retirer = () => setFil((prev) => prev.filter((m) => m.id !== provisoire.id));
    setFil((prev) => [...prev, provisoire]);
    setTravaille(true);
    setEnvoi(true);
    try {
      const cible = await conversationPourEcrire();
      const refus = cible && typeof cible === "object" ? cible.erreur : await deposer(cible);
      if (refus) { retirer(); setErreur(refus); return "refus"; }
      return "ok";
    } catch {
      retirer();
      setErreur(coupure);
      return "reseau";
    } finally {
      setEnvoi(false);
      window.dispatchEvent(new Event("assistant-fil:relancer"));
    }
  };

  /** ENVOYER ne bloque jamais : le message rejoint la file, l'assistant le traite après les précédents. */
  const envoyer = async (text: string, pretes: Pieces): Promise<boolean> => {
    setErreur(null);
    if (vueExacte) { await envoyerLocal(text, pretes); return true; }
    let basculer = false;
    const provisoire: ChatMessage = { id: `prov-${Date.now()}`, role: "user", content: text, pieces: pretes, etat: "attente", createdAt: new Date().toISOString() };
    const issue = await deposerAvecProvisoire(provisoire, async (cible) => {
      const r = await envoyerAuFil(text, JSON.stringify(pretes), cible ?? undefined);
      if (r.ok) return null;
      if ("vueExacte" in r && r.vueExacte) { basculer = true; return null; }
      return r.erreur;
    }, "La connexion a été interrompue : le message n'est pas parti. Réessayez.");
    if (basculer) { setFil((prev) => prev.filter((m) => m.id !== provisoire.id)); setVueExacte(true); await envoyerLocal(text, pretes); return true; }
    return issue === "ok";
  };

  /**
   * UN VOCAL PART COMME UN MESSAGE : affiché tout de suite (lisible depuis l'enregistrement local), puis déposé dans
   * le Drive et le fil (`/api/assistant-ia/vocal`) ; la transcription et la réponse arrivent par la lecture du fil.
   * Rend `false` si le vocal n'est pas parti faute de réseau — l'appelant peut le mettre en file hors ligne.
   */
  const envoyerVocal = async (audio: Blob, dureeS: number, pretes: Pieces): Promise<boolean> => {
    if (vueExacte) { setErreur("Les messages vocaux sont indisponibles en « Vue exacte »."); return true; }
    setErreur(null);
    const provisoire: ChatMessage = {
      id: `prov-vocal-${Date.now()}`, role: "user", content: "", pieces: pretes, etat: "attente", createdAt: new Date().toISOString(),
      vocal: { id: null, local: URL.createObjectURL(audio), dureeS, etat: "TRANSCRIPTION" },
    };
    const issue = await deposerAvecProvisoire(provisoire, async (cible) => {
      const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
      const fd = new FormData();
      fd.set("audio", new File([audio], `vocal.${ext}`, { type: audio.type || "audio/webm" }));
      fd.set("dureeS", String(dureeS));
      fd.set("pieces", JSON.stringify(pretes));
      if (cible) fd.set("conversation", cible);
      const r = await fetch("/api/assistant-ia/vocal", { method: "POST", body: fd });
      const j = (await r.json().catch(sansBloquer("use-fil.envoyerVocal.json", {}))) as { ok?: boolean; error?: string };
      return r.ok && j.ok ? null : j.error ?? "Le vocal n'est pas parti. Réessayez.";
    }, "La connexion a été interrompue : le vocal n'est pas parti.");
    return issue !== "reseau";
  };

  const basculerReponseVocale = async () => {
    const voulu = !reponseVocale;
    setReponseVocale(voulu);
    const r = await reglerMaReponseVocale(voulu).catch(sansBloquer("use-fil.reponseVocale", null));
    if (!r || !r.ok) { setReponseVocale(!voulu); setErreur(r && !r.ok ? r.erreur : "Réglage non enregistré. Réessayez."); }
  };

  const redige = fil.some((m) => m.etat === "redaction");
  return {
    fil, locaux, setLocaux, vueExacte, travaille, envoi, erreur, setErreur, reponseVocale, basculerReponseVocale,
    envoyer, envoyerVocal,
    /** L'indicateur « Consultation en cours » ne double pas une réponse qui s'écrit déjà sous les yeux. */
    attente: vueExacte ? localEnCours : (travaille || envoi) && !redige,
    occupeLocal: vueExacte && localEnCours,
  };
}
