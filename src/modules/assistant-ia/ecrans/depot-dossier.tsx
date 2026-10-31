"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, FolderOpen, FolderUp, Loader2, X } from "lucide-react";
import { useBackgroundUpload, type BilanEnvoi } from "@/components/layout/background-upload";
import { useLimitesEnvoi } from "@/components/layout/use-limites-envoi";
import { envoiArborescenceDrive } from "@/components/drive/envoi-drive";
import { sansBloquer } from "@/lib/journal";
import {
  BORNES_DOSSIER_DEFAUT, dossierDe, lotFini, modeDuDepot, phraseLot, planifierDossier, raisonBorneFichiers, restantsAEnvoyer,
  type EtatLot,
} from "../domaine/lecture/depot-dossier";
import { phraseRefus, tailleLisible, type FichierTrouve, type Parcours } from "../domaine/lecture/depot";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉPÔT DE DOSSIER, CÔTÉ ÉCRAN (lot J11, décision 0030).
 *
 *   • Un dossier glissé de PLUS DE 10 fichiers passe en mode « dépôt de dossier » : une seule puce (« Dossier « X » —
 *     300 fichiers · 1,2 Go »), plus de limite de 10 — la borne est réglable (1 000 fichiers, 2 Go par défaut).
 *   • RIEN NE PART AVANT ENTRÉE (décision 0015) : à l'envoi, le serveur ouvre le lot (racine nommée, sous-dossiers), puis
 *     le GESTIONNAIRE D'ENVOIS de l'application (le même que le Drive : six en parallèle, envoi direct au stockage par
 *     morceaux au-delà du seuil, reprise des parties, contenu déjà connu non retransféré) dépose chaque fichier dans SON
 *     dossier ; le message part aussitôt — la lecture suit en arrière-plan.
 *   • REPRISE : redéposer le même dossier retrouve le lot ; seuls les fichiers absents du Drive repartent.
 *   • Un dossier de 10 fichiers au plus reste en puces, mais ses fichiers rejoignent aussi leur arborescence recréée.
 *   • LE SUIVI : n fichiers, lus, échoués, en file — sous la conversation tant que la lecture n'est pas finie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface DossierEnAttente {
  nom: string;
  fichiers: FichierTrouve<File>[];
  octets: number;
}

interface OuvertureLot {
  ok: true; lotId: string; racineId: string; nom: string; repris: boolean;
  map: Record<string, string>; deja: { relatif: string; taille: number }[]; refus: { chemin: string; raison: string }[];
}

async function ouvrirLot(fichiers: { chemin: string; taille: number }[], mode: "MESSAGE" | "DOSSIER"): Promise<OuvertureLot | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/assistant-ia/depot-dossier", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fichiers, mode }),
    });
    const b = (await res.json().catch(sansBloquer("depot-dossier.ouvrirLot.json", {}))) as OuvertureLot | { error?: string };
    return res.ok && "lotId" in b ? b : { ok: false, error: ("error" in b && b.error) || `Le serveur a répondu ${res.status}.` };
  } catch {
    return { ok: false, error: "Connexion interrompue : le dossier n'a pas été ouvert dans votre Drive." };
  }
}

const relatifDe = (chemin: string, racineUnique: boolean) => (racineUnique ? chemin.split("/").slice(1).join("/") : chemin);
const racineUnique = (chemins: string[]) => chemins.length > 0 && chemins.every((c) => c.includes("/")) && new Set(chemins.map((c) => c.split("/")[0])).size === 1;

/** Le dépôt de dossier de la conversation : la puce en attente, l'envoi, la cible des pièces d'un petit dossier. */
export function useDepotDossier(onAvis: (avis: string | null) => void) {
  const [dossier, setDossier] = useState<DossierEnAttente | null>(null);
  const [relance, setRelance] = useState(0);
  const { enqueue } = useBackgroundUpload();
  const limites = useLimitesEnvoi();

  /** Le dépôt est-il un DOSSIER au-delà de 10 pièces ? Alors il devient la puce du mode « dépôt de dossier ». */
  const proposer = useCallback((parcours: Parcours<File>, dejaLa: number): boolean => {
    if (modeDuDepot(parcours.trouves, dejaLa) !== "dossier") return false;
    const { acceptes, refus, octets } = planifierDossier(parcours.trouves.map((t) => ({ ...t, taille: t.fichier.size })));
    if (!acceptes.length) { onAvis(phraseRefus(refus, parcours.ignores, parcours.tronque)); return true; }
    const premiers = new Set(acceptes.map((a) => a.chemin.split("/")[0]));
    setDossier({ nom: premiers.size === 1 ? [...premiers][0]! : `${premiers.size} dossiers`, fichiers: acceptes, octets });
    const tronque = parcours.tronque ? raisonBorneFichiers(BORNES_DOSSIER_DEFAUT) : null;
    onAvis([phraseRefus(refus, parcours.ignores, false), tronque].filter(Boolean).join(" ") || null);
    return true;
  }, [onAvis]);

  const retirer = useCallback(() => { setDossier(null); onAvis("Dossier retiré : rien n'a été envoyé."); }, [onAvis]);

  /**
   * À L'ENVOI : ouvre le lot, confie les fichiers au gestionnaire d'envois (chacun dans son dossier), et rend la ligne
   * que le message porte (« Dossier déposé… ») — `null` si le lot n'a pas pu s'ouvrir (le message ne part pas).
   */
  const envoyer = useCallback(async (): Promise<string | null> => {
    if (!dossier) return null;
    const r = await ouvrirLot(dossier.fichiers.map((f) => ({ chemin: f.chemin, taille: f.fichier.size })), "DOSSIER");
    if (!r.ok) { onAvis(null); throw new Error(r.error); }
    const unique = racineUnique(dossier.fichiers.map((f) => f.chemin));
    const tous = dossier.fichiers.map((f) => ({ file: f.fichier, relatif: relatifDe(f.chemin, unique), taille: f.fichier.size }));
    const restants = restantsAEnvoyer(tous, r.deja);
    const clore = (statut: "TERMINE" | "ABANDONNE") => fetch(`/api/assistant-ia/depot-dossier/${r.lotId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ statut }),
    }).catch(sansBloquer("depot-dossier.clore")).finally(() => setRelance((n) => n + 1));
    if (restants.length) {
      enqueue(envoiArborescenceDrive({
        label: `Dossier « ${r.nom} » (${restants.length} fichier${restants.length > 1 ? "s" : ""})`,
        entrees: restants.map((x) => ({ file: x.file, path: x.relatif })),
        map: r.map, parentId: r.racineId, limites,
        onJobDone: (b: BilanEnvoi) => { void clore(b.annule ? "ABANDONNE" : "TERMINE"); },
      }));
    } else void clore("TERMINE");
    setDossier(null);
    setRelance((n) => n + 1);
    const refusServeur = r.refus.length ? phraseRefus(r.refus) : null;
    onAvis([r.repris ? `Reprise du dossier « ${r.nom} » : ${tous.length - restants.length} fichier(s) déjà dans votre Drive, ${restants.length} à envoyer.` : null, refusServeur].filter(Boolean).join(" ") || null);
    return `Dossier déposé : « ${r.nom} » — ${tous.length} fichier${tous.length > 1 ? "s" : ""}, recréé dans mon Drive (/drive/${r.racineId}).`;
  }, [dossier, enqueue, limites, onAvis]);

  /**
   * UN PETIT DOSSIER (≤ 10 pièces, en puces) : ses fichiers rejoignent aussi leur arborescence recréée. Rend, pour chaque
   * chemin, le dossier du Drive où le déposer — `{}` quand aucune pièce ne vient d'un dossier.
   */
  const ciblesDesPieces = useCallback(async (pieces: { chemin: string; taille: number }[]): Promise<Record<string, string>> => {
    const deDossier = pieces.filter((p) => p.chemin.includes("/"));
    if (!deDossier.length) return {};
    const r = await ouvrirLot(deDossier, "MESSAGE");
    if (!r.ok) throw new Error(r.error);
    const unique = racineUnique(deDossier.map((p) => p.chemin));
    setRelance((n) => n + 1);
    return Object.fromEntries(deDossier.map((p) => {
      const dir = dossierDe(relatifDe(p.chemin, unique));
      return [p.chemin, dir ? r.map[dir] ?? r.racineId : r.racineId];
    }));
  }, []);

  return { dossier, proposer, retirer, envoyer, ciblesDesPieces, relance };
}

/** La puce du mode « dépôt de dossier ». */
export function PuceDossier({ dossier, onRetirer, verrou }: { dossier: DossierEnAttente; onRetirer: () => void; verrou?: boolean }) {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50/80 px-3 py-2 text-sm text-sky-950 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100" data-testid="puce-dossier">
      <FolderUp aria-hidden className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">Dossier « {dossier.nom} »</p>
        <p className="text-xs text-sky-800/80 dark:text-sky-200/80">
          {dossier.fichiers.length.toLocaleString("fr-FR")} fichiers · {tailleLisible(dossier.octets)} — recréé dans votre Drive à l&apos;envoi, puis lu par la Bibliothèque
        </p>
      </div>
      <button type="button" onClick={onRetirer} disabled={verrou} aria-label={`Retirer le dossier ${dossier.nom}`}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-sky-800 hover:bg-sky-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:text-sky-200 dark:hover:bg-sky-900">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** LE SUIVI des dépôts de dossier : tant qu'un lot n'est pas lu, sa barre (lus / fichiers) et sa phrase. */
export function SuiviDepots({ relance }: { relance: number }) {
  const [lots, setLots] = useState<EtatLot[]>([]);
  const minuteur = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let vivant = true;
    const lire = async () => {
      const res = await fetch("/api/assistant-ia/depot-dossier", { cache: "no-store" }).catch(sansBloquer("depot-dossier.suivi", null));
      const b = res?.ok ? ((await res.json().catch(sansBloquer("depot-dossier.suivi.json", { lots: [] }))) as { lots: EtatLot[] }) : { lots: [] };
      if (!vivant) return;
      // Les lots finis depuis plus d'une heure ne s'affichent plus : le panneau suit ce qui est en cours.
      const recents = b.lots.filter((l) => !lotFini(l) || Date.now() - new Date(l.createdAt).getTime() < 3_600_000);
      setLots(recents);
      if (recents.some((l) => !lotFini(l))) minuteur.current = setTimeout(lire, 4000);
    };
    void lire();
    return () => { vivant = false; if (minuteur.current) clearTimeout(minuteur.current); };
  }, [relance]);
  if (!lots.length) return null;
  return (
    <section aria-label="Dépôts de dossier" className="mb-2 space-y-1.5" data-testid="suivi-depots">
      {lots.map((l) => {
        const fini = lotFini(l);
        const part = l.annonces ? Math.round(((l.lus + l.ignores + l.echoues) / l.annonces) * 100) : 0;
        return (
          <div key={l.id} className="rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900/70">
            <div className="flex items-center gap-2">
              {fini ? <CheckCircle2 aria-hidden className="h-4 w-4 text-emerald-600" /> : <Loader2 aria-hidden className="h-4 w-4 animate-spin text-sky-600" />}
              <span className="min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-zinc-100">« {l.nom} »</span>
              <a href={`/drive/${l.racineId}`} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-medium text-sky-700 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-950">
                <FolderOpen aria-hidden className="h-3.5 w-3.5" /> Drive
              </a>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={part} aria-label={`Lecture du dossier ${l.nom}`}>
              <div className="h-full rounded-full bg-sky-500 transition-[width]" style={{ width: `${part}%` }} />
            </div>
            <p role="status" className="mt-1 text-slate-600 dark:text-zinc-400">{phraseLot(l)}</p>
          </div>
        );
      })}
    </section>
  );
}
