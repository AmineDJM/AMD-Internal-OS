"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationResumee } from "../../domaine/conversations";
import type { DossierVue } from "../../domaine/dossiers";
import {
  archiverMaConversation, epinglerMaConversation, listerMesConversations, listerMesDossiers, rangerMaConversation,
  rechercherMesConversations, renommerMaConversation, supprimerMaConversation,
} from "@/modules/assistant-ia/actions-conversations";
import { sansBloquer } from "@/lib/journal";

/**
 * LA LISTE DES CONVERSATIONS ET DES DOSSIERS, CÔTÉ ÉCRAN (décision 0027) — partagée par l'ERP et l'app.
 *
 * Relue à l'ouverture, après chaque envoi (le titre provisoire, puis le titre proposé, arrivent du serveur) et toutes
 * les 20 s. La recherche (titres ET contenu) part 250 ms après la dernière frappe ; vide, la liste revient.
 */
export function useConversations() {
  const [conversations, setConversations] = useState<ConversationResumee[]>([]);
  const [archivees, setArchivees] = useState<ConversationResumee[] | null>(null);
  const [dossiers, setDossiers] = useState<DossierVue[]>([]);
  const [recherche, setRecherche] = useState("");
  const [trouvees, setTrouvees] = useState<ConversationResumee[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [charge, setCharge] = useState(false);

  const relire = useCallback(async () => {
    const [c, d] = await Promise.all([
      listerMesConversations().catch(sansBloquer("use-conversations.lister", null)),
      listerMesDossiers().catch(sansBloquer("use-conversations.dossiers", null)),
    ]);
    if (c?.ok) setConversations(c.conversations);
    if (d?.ok) setDossiers(d.dossiers);
    setCharge(true);
  }, []);

  useEffect(() => {
    void relire();
    const t = setInterval(() => void relire(), 20_000);
    // Un envoi : le titre provisoire est déjà là ; le titre proposé suit la première réponse (quelques secondes).
    const apresEnvoi = () => { void relire(); setTimeout(() => void relire(), 6_000); };
    window.addEventListener("assistant-fil:relancer", apresEnvoi);
    return () => { clearInterval(t); window.removeEventListener("assistant-fil:relancer", apresEnvoi); };
  }, [relire]);

  const minuteur = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(minuteur.current);
    if (recherche.trim().length < 2) { setTrouvees(null); return; }
    minuteur.current = setTimeout(() => {
      void rechercherMesConversations(recherche).then((r) => { if (r.ok) setTrouvees(r.conversations); }).catch(sansBloquer("use-conversations.rechercher"));
    }, 250);
    return () => clearTimeout(minuteur.current);
  }, [recherche]);

  /** Un geste sur une conversation : appliqué, puis la liste relue ; un refus est dit. */
  const geste = useCallback(async (f: () => Promise<{ ok: boolean; erreur?: string } | { ok: false; erreur: string }>) => {
    setErreur(null);
    const r = await f().catch(sansBloquer("use-conversations.geste", { ok: false as const, erreur: "Le geste n'a pas abouti. Réessayez." }));
    if (!r.ok) setErreur("erreur" in r && r.erreur ? r.erreur : "Le geste n'a pas abouti.");
    await relire();
    if (archivees) { const a = await listerMesConversations(true).catch(sansBloquer("use-conversations.archivees", null)); if (a?.ok) setArchivees(a.conversations); }
    return r.ok;
  }, [relire, archivees]);

  return {
    conversations, dossiers, recherche, setRecherche, trouvees, erreur, setErreur, charge, relire, archivees,
    voirArchivees: async (oui: boolean) => {
      if (!oui) { setArchivees(null); return; }
      const a = await listerMesConversations(true).catch(sansBloquer("use-conversations.archivees", null));
      setArchivees(a?.ok ? a.conversations : []);
    },
    renommer: (id: string, titre: string) => geste(() => renommerMaConversation(id, titre)),
    epingler: (id: string, oui: boolean) => geste(() => epinglerMaConversation(id, oui)),
    archiver: (id: string, oui: boolean) => geste(() => archiverMaConversation(id, oui)),
    supprimer: (id: string) => geste(() => supprimerMaConversation(id)),
    ranger: (id: string, dossierId: string | null) => geste(() => rangerMaConversation(id, dossierId)),
  };
}

export type EtatConversations = ReturnType<typeof useConversations>;
