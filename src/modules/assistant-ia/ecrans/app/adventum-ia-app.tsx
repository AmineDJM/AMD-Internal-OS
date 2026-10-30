"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brain, EyeOff, Menu, PanelRight, Settings, X } from "lucide-react";
import { ChatMessageList, type ChatMessage } from "../chat-message-list";
import { BoutonJoindre, PiecesEnAttente, type PieceOuvrable } from "../pieces-jointes";
import { EnregistreurVocal } from "../enregistreur-vocal";
import { MemoirePanel } from "../memoire-panel";
import { TravauxPanel } from "../travaux-panel";
import { ApercuPiece } from "../apercu-piece";
import { Atelier } from "../atelier/atelier";
import { depuisListe } from "../depot-navigateur";
import { useFil } from "../use-fil";
import { usePieces } from "../use-pieces";
import { useConversations } from "../conversations/use-conversations";
import { ListeConversations } from "../conversations/liste-conversations";
import { PanneauDuDossier } from "../conversations/dossier-panneau";
import { SaisieAdventum } from "./saisie";
import { Tiroir, type OngletTiroir } from "./tiroir";
import { appliquerTheme, lireTheme, Reglages, type Theme } from "./reglages";
import { BoutonVoixTempsReel } from "../voix-temps-reel";
import { enregistrerServiceWorker, mettreEnFile, viderLaFile, type VocalEnFile } from "./hors-ligne";
import { texteDemandeModification } from "../../domaine/lecture/depot";
import { ZoneDepot } from "../zone-depot";
import { creerMaConversation, reglerMaConversationPrivee } from "@/modules/assistant-ia/actions-conversations";
import { confirmerIntentionAssistantIA } from "@/modules/assistant-ia/actions";
import { doSignOut } from "@/lib/actions/auth-actions";
import { DialoguesProvider } from "@/components/ui/dialogue";
import "./theme.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ADVENTUM IA — L'APPLICATION (décision 0027, maquette validée par la Direction le 30/10/2026).
 *
 * Une conversation de type ChatGPT avec le MÊME assistant que l'ERP : mêmes outils, mêmes droits, même console,
 * mêmes repères ⟦Sn⟧, travaux qui continuent sur le worker app fermée. Rien n'est réécrit : le fil (`use-fil`), les
 * pièces (`use-pieces`), la liste des conversations, les cartes, la mémoire, les travaux, l'Atelier sont ceux du module.
 *
 *   • à gauche : marque, nouvelle conversation, recherche, dossiers, conversations par date ; mémoire et réglages ;
 *   • au centre : le fil (Markdown sûr, cartes à confirmer, « Mémoire mise à jour »), la saisie à trois voix ;
 *   • à droite (tiroir) : Notes, Travaux, Documents.
 * Sur téléphone (390 px) : la liste et le tiroir passent en plein écran, la saisie reste au-dessus de la barre système.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const SUGGESTIONS = [
  "Qu'est-ce que je dois valider aujourd'hui ?",
  "Prépare un point sur mes demandes en cours",
  "Résume le dernier document que je t'ai envoyé",
  "Quelles sont mes tâches de la semaine ?",
];

function prenom(nom?: string): string {
  return (nom ?? "").trim().split(/\s+/)[0] ?? "";
}

export function AdventumIaApp({ userName }: { userName?: string }) {
  return (
    <DialoguesProvider>
      <Application userName={userName} />
    </DialoguesProvider>
  );
}

function Application({ userName }: { userName?: string }) {
  const racine = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<Theme>("systeme");
  useEffect(() => { const t = lireTheme(); setTheme(t); appliquerTheme(t, racine.current); }, []);
  const changerTheme = (t: Theme) => { setTheme(t); appliquerTheme(t, racine.current); };

  // ── La conversation ouverte : `?c=` (lien, notification), sinon une NOUVELLE conversation (comme ChatGPT).
  const [conversation, setConversation] = useState<string | null>(null);
  const [nouvelle, setNouvelle] = useState<{ prive: boolean; dossierId: string | null } | null>({ prive: false, dossierId: null });
  const [listeOuverte, setListeOuverte] = useState(false);
  const [dossierOuvert, setDossierOuvert] = useState<string | null>(null);
  const [panneauDossier, setPanneauDossier] = useState<"nouveau" | string | null>(null);
  const [tiroir, setTiroir] = useState<OngletTiroir | null>(null);
  const [memoire, setMemoire] = useState(false);
  const [reglages, setReglages] = useState(false);
  const [travaux, setTravaux] = useState<{ ouvert: boolean; initial: string | null }>({ ouvert: false, initial: null });
  const [atelier, setAtelier] = useState<{ ouvert: boolean; plein: boolean; aOuvrir: { nodeId: string; jeton: number } | null }>({ ouvert: false, plein: false, aOuvrir: null });
  const [apercu, setApercu] = useState<PieceOuvrable | null>(null);
  const [brouillon, setBrouillon] = useState<{ texte: string; jeton: number } | null>(null);
  const [avis, setAvis] = useState<string | null>(null);
  const conversations = useConversations();

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const c = q.get("c");
    if (c) { setConversation(c); setNouvelle(null); }
    const t = q.get("travail");
    if (t) setTravaux({ ouvert: true, initial: t });
    enregistrerServiceWorker();
  }, []);

  const versUrl = (c: string | null) => window.history.replaceState(null, "", c ? `/ia?c=${encodeURIComponent(c)}` : "/ia");
  // Ce que le serveur dit de la conversation ouverte : titre, privée, dossier — sans attendre la relecture de la liste.
  const [meta, setMeta] = useState<{ id: string; titre: string | null; prive: boolean; dossierId: string | null } | null>(null);
  const surConversation = useCallback((c: { id: string; titre: string | null; prive: boolean; dossierId: string | null }) => {
    setMeta(c);
    setConversation((avant) => (avant === c.id ? avant : c.id));
    setNouvelle(null);
    versUrl(c.id);
  }, []);
  const ouvrir = (id: string) => { setNouvelle(null); setConversation(id); setListeOuverte(false); versUrl(id); };
  const nouvelleConversation = (dossierId: string | null = null) => {
    setConversation(null); setNouvelle({ prive: false, dossierId }); setListeOuverte(false); versUrl(null);
  };

  const f = useFil({ conversation, nouvelle, onConversation: surConversation });

  // LA VOIX EN DIRECT (gpt-live-1, lot J13) écrit dans la conversation OUVERTE — une « nouvelle » naît quand on parle.
  const cible = useRef({ conversation, nouvelle });
  cible.current = { conversation, nouvelle };
  const conversationPourLaVoix = useCallback(async (): Promise<string | null> => {
    const { conversation: c, nouvelle: n } = cible.current;
    if (!n) return c;
    const r = await creerMaConversation(n.prive, n.dossierId);
    if (!r.ok) return null;
    surConversation({ id: r.conversation, titre: null, prive: n.prive, dossierId: n.dossierId });
    return r.conversation;
  }, [surConversation]);
  const p = usePieces(f.setErreur);
  const listee = conversations.conversations.find((c) => c.id === conversation) ?? conversations.archivees?.find((c) => c.id === conversation);
  const ouverte = listee ?? (meta && meta.id === conversation ? { titre: meta.titre ?? "Conversation", prive: meta.prive, dossierId: meta.dossierId } : undefined);
  const commencee = f.fil.length > 0;
  const prive = nouvelle ? nouvelle.prive : !!ouverte?.prive;
  const dossierId = nouvelle ? nouvelle.dossierId : ouverte?.dossierId ?? null;
  const dossier = conversations.dossiers.find((d) => d.id === dossierId) ?? null;
  const titre = nouvelle ? (prive ? "Conversation privée" : "Nouvelle conversation") : ouverte?.titre ?? "Conversation";

  /** PRIVÉE : un choix d'AVANT le premier message — ensuite, le bouton est verrouillé (et le serveur refuse). */
  const basculerPrive = async () => {
    if (nouvelle) { setNouvelle({ ...nouvelle, prive: !nouvelle.prive }); return; }
    if (!conversation || commencee) return;
    const r = await reglerMaConversationPrivee(conversation, !prive);
    if (!r.ok) f.setErreur(r.erreur);
    await conversations.relire();
  };

  // ── HORS LIGNE (minimal) : un vocal dit sans réseau attend dans l'appareil et part au retour du réseau.
  const envoyerEnFile = useCallback(async (v: VocalEnFile): Promise<boolean> => {
    try {
      const fd = new FormData();
      fd.set("audio", new File([v.audio], `vocal.${v.audio.type.includes("mp4") ? "m4a" : "webm"}`, { type: v.audio.type || "audio/webm" }));
      fd.set("dureeS", String(v.dureeS));
      fd.set("pieces", "[]");
      if (v.conversation) fd.set("conversation", v.conversation);
      await fetch("/api/assistant-ia/vocal", { method: "POST", body: fd });
      return true; // un refus du serveur n'est pas une panne réseau : le vocal ne tourne pas en boucle
    } catch {
      return false;
    }
  }, []);
  useEffect(() => {
    const vider = () => void viderLaFile(envoyerEnFile).then((n) => {
      if (n) { setAvis(`${n} vocal${n > 1 ? "s" : ""} en attente envoyé${n > 1 ? "s" : ""}.`); window.dispatchEvent(new Event("assistant-fil:relancer")); }
    });
    vider();
    window.addEventListener("online", vider);
    return () => window.removeEventListener("online", vider);
  }, [envoyerEnFile]);

  const envoyer = async (texte: string): Promise<boolean> => {
    if (!texte.trim() && !p.piecesRef.current.length) return false;
    const pretes = await p.preparerPieces();
    if (!pretes) return false;
    return f.envoyer(texte, pretes);
  };

  const envoyerVocal = async (audio: Blob, dureeS: number) => {
    if (typeof navigator !== "undefined" && !navigator.onLine && !p.piecesRef.current.length && !nouvelle) {
      await mettreEnFile({ conversation, audio, dureeS });
      setAvis("Pas de réseau : le vocal attend dans l'appareil et partira tout seul au retour du réseau.");
      return;
    }
    const pretes = await p.preparerPieces();
    if (!pretes) return;
    const parti = await f.envoyerVocal(audio, dureeS, pretes);
    if (!parti && !pretes.length) {
      await mettreEnFile({ conversation, audio, dureeS });
      f.setErreur(null);
      setAvis("Connexion perdue : le vocal attend dans l'appareil et partira au retour du réseau.");
    }
  };

  const ouvrirDansAtelier = useCallback((piece: PieceOuvrable) => {
    setApercu(null);
    setAtelier({ ouvert: true, plein: false, aOuvrir: { nodeId: piece.id, jeton: Date.now() } });
  }, []);
  const demanderModification = (piece: PieceOuvrable) => {
    ouvrirDansAtelier(piece);
    p.joindreDuDrive(piece);
    setBrouillon({ texte: texteDemandeModification(piece.nom), jeton: Date.now() });
  };

  const documents = useMemo(() => {
    const vus = new Set<string>();
    const unique = (xs: PieceOuvrable[]) => xs.filter((x) => (vus.has(x.id) ? false : (vus.add(x.id), true)));
    const conv = unique(f.fil.flatMap((m: ChatMessage) => [...(m.pieces ?? []), ...(m.piecesRendues ?? [])]));
    return [
      { titre: "Cette conversation", pieces: conv },
      ...(dossier ? [{ titre: `Dossier « ${dossier.nom} »`, pieces: unique(dossier.documents) }] : []),
    ];
  }, [f.fil, dossier]);

  const bouton = "flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] hover:bg-[var(--aia-survol)]";

  return (
    <div ref={racine} data-testid="adventum-ia" className="adventum-ia fixed inset-0 flex overflow-hidden pt-[env(safe-area-inset-top)]">
      {/* ── LA LISTE DES CONVERSATIONS ─────────────────────────────────────────────── */}
      <div className={`${listeOuverte ? "fixed inset-0 z-40 flex" : "hidden"} lg:static lg:z-auto lg:flex lg:w-[260px] lg:shrink-0 lg:border-r lg:border-[var(--aia-filet)]`}>
        {listeOuverte && <button type="button" aria-label="Fermer la liste" onClick={() => setListeOuverte(false)} className="absolute inset-0 bg-slate-950/40 lg:hidden" />}
        <div className="relative flex h-full w-[82%] max-w-[320px] flex-col shadow-xl lg:w-full lg:max-w-none lg:shadow-none">
          <ListeConversations
            etat={conversations} courante={nouvelle ? null : conversation} onOuvrir={ouvrir} onNouvelle={nouvelleConversation}
            dossierOuvert={dossierOuvert} onDossier={(id) => { setDossierOuvert(id); if (id) setPanneauDossier(id); }}
            onCreerDossier={() => setPanneauDossier("nouveau")}
            entete={
              <div className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-3.5">
                {/* eslint-disable-next-line @next/next/no-img-element -- le logo provisoire, remplaçable tel quel (public/adventum-ia/) */}
                <img src="/adventum-ia/logo-complet.png" alt="Adventum Pharma" width={126} height={27} className="h-[27px] w-auto dark:rounded dark:bg-white dark:px-1" />
                <b className="flex-1 text-[15px] font-semibold tracking-tight text-[var(--aia-voix)]">IA</b>
                <button type="button" onClick={() => setListeOuverte(false)} aria-label="Fermer la liste" className={`${bouton} lg:hidden`}><X className="h-4 w-4" /></button>
              </div>
            }
            pied={
              <div className="flex flex-col gap-0.5">
                <button type="button" onClick={() => { setMemoire(true); setListeOuverte(false); }} className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-[14px] hover:bg-[var(--aia-survol)]">
                  <Brain className="h-4 w-4" aria-hidden /> Ce que l&apos;assistant retient
                </button>
                <button type="button" onClick={() => { setReglages(true); setListeOuverte(false); }} className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-[14px] hover:bg-[var(--aia-survol)]">
                  <Settings className="h-4 w-4" aria-hidden /> Réglages · voix, notifications
                </button>
              </div>
            }
          />
        </div>
      </div>

      {/* ── LA CONVERSATION ─────────────────────────────────────────────────────────── */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-[var(--aia-panneau)]">
        <header className="flex items-center gap-1.5 border-b border-[var(--aia-filet)] px-3 py-2.5">
          <button type="button" onClick={() => setListeOuverte(true)} aria-label="Ouvrir la liste des conversations" className={`${bouton} lg:hidden`}><Menu className="h-4 w-4" /></button>
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold" data-testid="titre-conversation">{titre}</h1>
          {dossier && <span className="hidden truncate rounded-full bg-[var(--aia-accent-doux)] px-2.5 py-0.5 text-[12px] text-[var(--aia-accent)] sm:inline">{dossier.nom}</span>}
          {prive && <span className="shrink-0 rounded-full bg-[var(--aia-prive-doux)] px-2.5 py-0.5 text-[12px] text-[var(--aia-prive)]" data-testid="badge-prive">Conversation privée</span>}
          <button
            type="button" onClick={() => void basculerPrive()} aria-pressed={prive} disabled={commencee} data-testid="bouton-prive"
            aria-label={commencee ? "Conversation commencée : son caractère privé ne change plus" : "Conversation privée"}
            title={commencee ? "Une conversation commencée ne peut plus devenir privée, ni cesser de l'être." : "Conversation privée : l'assistant n'utilise pas votre mémoire et ne retient rien ; supprimée après 30 jours."}
            className={`${bouton} aria-pressed:bg-[var(--aia-prive-doux)] aria-pressed:text-[var(--aia-prive)] disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <EyeOff className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => setTiroir((t) => (t ? null : "notes"))} aria-pressed={!!tiroir} aria-label="Notes, travaux et documents" title="Notes, travaux et documents"
            className={`${bouton} aria-pressed:bg-[var(--aia-accent-doux)] aria-pressed:text-[var(--aia-accent)]`}>
            <PanelRight className="h-4 w-4" />
          </button>
        </header>

        {commencee || f.vueExacte ? (
          <ChatMessageList apparence="app" messages={f.vueExacte ? f.locaux : f.fil} isLoading={f.attente} onConfirmIntent={confirmerIntentionAssistantIA} onOuvrirPiece={setApercu} />
        ) : (
          <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-4 py-6 text-center" data-testid="accueil">
            {/* eslint-disable-next-line @next/next/no-img-element -- le logo provisoire, remplaçable tel quel */}
            <img src="/adventum-ia/logo-marque.png" alt="" width={48} height={48} className="h-12 w-12" />
            <h2 className="text-[24px] font-semibold tracking-tight">Bonjour{prenom(userName) ? ` ${prenom(userName)}` : ""}, par quoi on commence ?</h2>
            {dossier && <p className="text-[13px] text-[var(--aia-accent)]">Dans le dossier « {dossier.nom} » : ses consignes et ses documents s&apos;appliquent.</p>}
            <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => void envoyer(s)}
                  className="rounded-xl border border-[var(--aia-filet)] px-3 py-2.5 text-left text-[13.5px] hover:bg-[var(--aia-survol)]">{s}</button>
              ))}
            </div>
            {prive && <p className="text-[13px] text-[var(--aia-prive)]">Conversation privée : l&apos;assistant n&apos;utilise pas votre mémoire et ne retient rien. Elle est supprimée après 30 jours.</p>}
          </div>
        )}

        <div className="mx-auto w-full max-w-3xl px-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1 sm:px-6">
          {f.erreur && <p role="alert" className="mb-1 px-2 text-[12.5px] text-[var(--aia-danger)]">{f.erreur}</p>}
          <p aria-live="polite" className={p.avisDepot || avis ? "mb-1 px-2 text-[12.5px] text-[var(--aia-prive)]" : "sr-only"} data-testid="avis-depot">{p.avisDepot ?? avis}</p>
          <SaisieAdventum
            onEnvoyer={envoyer} brouillon={brouillon} envoiBloque={p.televersement} peutEnvoyerVide={p.pieces.length > 0}
            dessus={p.pieces.length ? <PiecesEnAttente pieces={p.pieces} onRetirer={p.retirer} verrou={p.televersement} /> : undefined}
            joindre={<BoutonJoindre onFichiers={(liste) => p.joindre(depuisListe(liste))} desactive={p.televersement} />}
            vocal={f.vueExacte ? undefined : <EnregistreurVocal onVocal={(a, d) => void envoyerVocal(a, d)} desactive={p.televersement} />}
            voix={f.vueExacte ? undefined : (
              <BoutonVoixTempsReel conversation={conversationPourLaVoix}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--aia-filet)] text-[var(--aia-voix)] hover:bg-[var(--aia-voix-doux)] disabled:opacity-40" />
            )}
          />
        </div>

        {p.survol && <ZoneDepot apparence="app" />}
      </main>

      {/* ── LE TIROIR : NOTES, TRAVAUX, DOCUMENTS ────────────────────────────────────── */}
      {tiroir && (
        <div className="fixed inset-0 z-40 flex lg:static lg:z-auto lg:w-[320px] lg:shrink-0">
          <div className="flex h-full w-full flex-col pt-[env(safe-area-inset-top)] lg:pt-0">
            <Tiroir
              onglet={tiroir} onOnglet={setTiroir} onFermer={() => setTiroir(null)}
              onOuvrirTravaux={(id) => setTravaux({ ouvert: true, initial: id ?? null })}
              documents={documents} onOuvrirPiece={setApercu}
              onAtelier={() => setAtelier((a) => ({ ...a, ouvert: true }))}
              onDemander={(texte) => { setTiroir(null); setBrouillon({ texte, jeton: Date.now() }); }}
            />
          </div>
        </div>
      )}

      {atelier.ouvert && (
        <div className="fixed inset-0 z-50 flex bg-[var(--aia-panneau)]">
          <Atelier
            ouvert travaille={f.travaille || f.envoi} aOuvrir={atelier.aOuvrir} pleinEcran={atelier.plein}
            onAfficher={() => setAtelier((a) => ({ ...a, ouvert: true }))} onFermer={() => setAtelier({ ouvert: false, plein: false, aOuvrir: null })}
            onPleinEcran={() => setAtelier((a) => ({ ...a, plein: !a.plein }))} onConfirmIntent={confirmerIntentionAssistantIA}
          />
        </div>
      )}
      <ApercuPiece piece={apercu} onFermer={() => setApercu(null)} onDemanderModification={f.vueExacte ? undefined : demanderModification} onOuvrirAtelier={f.vueExacte ? undefined : ouvrirDansAtelier} />
      <MemoirePanel ouvert={memoire} onFermer={() => setMemoire(false)} />
      <TravauxPanel ouvert={travaux.ouvert} onFermer={() => setTravaux({ ouvert: false, initial: null })} travailInitial={travaux.initial} />
      <PanneauDuDossier panneau={panneauDossier} etat={conversations} onPanneau={setPanneauDossier} onDossierOuvert={setDossierOuvert} onNouvelleConversation={nouvelleConversation} />
      {reglages && (
        <Reglages
          theme={theme} onTheme={changerTheme} reponseVocale={f.reponseVocale} onReponseVocale={() => void f.basculerReponseVocale()}
          onFermer={() => setReglages(false)}
          deconnexion={<form action={doSignOut}><button type="submit" className="text-[14px] text-[var(--aia-danger)] hover:underline">Se déconnecter</button></form>}
        />
      )}
    </div>
  );
}
