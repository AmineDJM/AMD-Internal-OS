import { profilDAcces } from "../../domaine/profil-acces";
import type { CurrentUser } from "@/lib/session";
import { identiteDonneesDe } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";
import { simulerEnEssai } from "@/platform/ia/hors-requete";
import { avecIdentiteDonnees } from "@/platform/donnees/contexte";
import { proprietaire } from "@/platform/ia/proprietaire";
import { deposerMessage, ETAT, lireFil, nouvelleConversation, traiterFil } from "../fil/service";
import { filPourEcran } from "../fil/ecran";
import {
  ESSAI_ECHANGES_MAX, ESSAI_MESSAGE_MAX, ESSAI_REPONSE_MAX, type EchangeEssai, type IssueEssai,
} from "../../domaine/essai";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ESSAYER L'AGENT D'UNE PERSONNE — le Super Admin, avant de l'ouvrir en production (Direction, 03/11/2026).
 *
 * ── CE QUI EST JOUÉ : LE VRAI CHEMIN, PAS UNE COPIE ──────────────────────────────────────
 *
 * Le message passe par les fonctions mêmes que l'écran de la personne appelle : `deposerMessage`, puis `traiterFil` →
 * `jouerTourDuFil` → `jouerTour` (consigne, profil, mémoire, familles, périmètres, outils, garde de sortie), puis
 * `lireFil` → `filPourEcran` (ce que son écran aurait reçu). Rien n'est réécrit pour l'essai : un écart entre l'essai et
 * la production ne peut venir que d'ici, et ce qui suit est ce qui le ferme.
 *
 * ── AU NOM DE LA PERSONNE, ENTIÈREMENT ───────────────────────────────────────────────────
 *
 *   • son IDENTITÉ et ses DROITS : `proprietaire` (la reconstruction que son vrai tour emploie, droits relus en base) ;
 *     sous le geste, `requireUser` / `getCurrentUser` rendent la personne — jamais le Super Admin qui essaie ;
 *   • la GARDE DES DONNÉES (D3/D4) juge la personne (`avecIdentiteDonnees`) : sans cela, dans le corps de cette action,
 *     elle aurait jugé le Super Admin, et l'essai aurait ouvert des bases qui lui restent fermées en production.
 *
 * ── RIEN NE RESTE, RIEN NE SORT ──────────────────────────────────────────────────────────
 *
 * Une SIMULATION transactionnelle (`simulerEnEssai`) : toute écriture (sa conversation, ses cartes, sa mémoire,
 * ses notifications, sa consommation) est annulée à la fin ; courriel, poussée, stockage, site, appels sortants sont
 * notés et neutralisés. Seul l'appel au fournisseur de modèles part (sinon il n'y a rien à juger), et chaque requête est
 * isolée par un point de sauvegarde (un refus rattrapé n'interrompt pas la suite, comme en vrai). Son assistant à elle
 * n'en garde aucune trace ; l'essai est inscrit à l'audit, au nom du Super Admin, avec ce qu'il a coûté.
 *
 * ── CE QUI PEUT DIFFÉRER, DIT ────────────────────────────────────────────────────────────
 *
 * Le MODÈLE n'est pas déterministe : deux essais du même message peuvent être formulés autrement — comme deux envois
 * de la personne. Ce qu'il peut LIRE, lui, est le même : mêmes outils, mêmes droits, mêmes données.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un tour de fond dure jusqu'à 4 min (`ASSISTANT_FOND_TIMEOUT_MS`) ; la capture de mémoire et le titre suivent. */
const DELAI_ESSAI_MS = (Number(process.env.ASSISTANT_FOND_TIMEOUT_MS) || 240_000) + 90_000;

/** Les lignes de la conversation elle-même : l'essai les montre en clair (le fil), pas comme « ce qui serait écrit ». */
const MODELES_DE_LA_CONVERSATION = new Set(["AssistantIaFil", "AssistantIaTour"]);

/** Un essai à la fois par processus : chacun tient une connexion à la base pendant tout son tour. */
let essaisEnCours = 0;

export async function essayerAgentDe(admin: CurrentUser, cibleId: string, message: string, precedents: EchangeEssai[]): Promise<IssueEssai> {
  if (!profilDAcces(admin).superAdmin) return { ok: false, erreur: "Réservé au Super Admin, hors « Vue exacte »." };
  const texte = (message ?? "").trim();
  if (!texte) return { ok: false, erreur: "Écrivez le message à essayer." };
  if (texte.length > ESSAI_MESSAGE_MAX) return { ok: false, erreur: `Un essai porte sur un message de ${ESSAI_MESSAGE_MAX} caractères au plus.` };
  const echanges = (Array.isArray(precedents) ? precedents : []).slice(-ESSAI_ECHANGES_MAX)
    .filter((e) => e && typeof e.question === "string" && typeof e.reponse === "string")
    .map((e) => ({ question: e.question.slice(0, ESSAI_MESSAGE_MAX), reponse: e.reponse.slice(0, ESSAI_REPONSE_MAX) }));

  // SON identité, reconstruite comme pour son vrai tour (compte actif, droits relus en base).
  const cible = typeof cibleId === "string" && cibleId ? await proprietaire(cibleId) : null;
  if (!cible) return { ok: false, erreur: "Compte introuvable ou désactivé." };
  if (essaisEnCours > 0) return { ok: false, erreur: "Un essai est déjà en cours : attendez sa réponse." };

  essaisEnCours++;
  try {
    const { issue, diff } = await simulerEnEssai(cible, { origine: "essai-agent" }, () => avecIdentiteDonnees(identiteDonneesDe(cible), async () => {
      const debut = new Date();
      const c = await nouvelleConversation(cible.id);
      if (!c.ok) return { refus: c.erreur, ecran: null, consommation: null };
      // LES ÉCHANGES PRÉCÉDENTS DE L'ESSAI, tels qu'ils ont été répondus : le tour les relit comme un fil ordinaire (le
      // contexte part de `depuisLe` ; chaque réponse suit sa question).
      const depuis = new Date(Date.now() - 3_600_000);
      await prisma.assistantIaFil.update({ where: { id: c.conversation }, data: { depuisLe: depuis } });
      for (const [i, e] of echanges.entries()) {
        const q = await prisma.assistantIaTour.create({ data: { filId: c.conversation, userId: cible.id, role: "user", contenu: e.question, etat: ETAT.TRAITE, createdAt: new Date(depuis.getTime() + (2 * i + 1) * 1000) } });
        await prisma.assistantIaTour.create({ data: { filId: c.conversation, userId: cible.id, role: "assistant", contenu: e.reponse, etat: ETAT.TERMINE, repondA: q.id, createdAt: new Date(depuis.getTime() + (2 * i + 2) * 1000) } });
      }
      // La personne est devant son écran (elle vient d'écrire) : présente, elle n'est pas notifiée — comme en vrai.
      await prisma.assistantIaFil.update({ where: { id: c.conversation }, data: { consulteLe: new Date() } });
      const d = await deposerMessage(cible.id, texte, [], null, c.conversation);
      if (!d.ok) return { refus: d.erreur, ecran: null, consommation: null };
      await traiterFil(cible.id, c.conversation);
      const ecran = await filPourEcran(cible, await lireFil(cible.id, 80, c.conversation));
      // Ce que l'essai a coûté — lu avant l'annulation (le journal de consommation de la personne n'en garde rien).
      const conso = await prisma.modelCallLog.aggregate({
        where: { userId: cible.id, at: { gte: debut } },
        _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, costUsd: true },
      });
      return {
        refus: null, ecran,
        consommation: { appels: conso._count._all, jetonsEntree: conso._sum.inputTokens ?? 0, jetonsSortie: conso._sum.outputTokens ?? 0, coutUsd: Number(conso._sum.costUsd ?? 0) },
      };
    }), { delaiMs: DELAI_ESSAI_MS, horsDuDiff: MODELES_DE_LA_CONVERSATION });

    const r = issue.resultat;
    const echec = !issue.ok ? issue.erreur ?? "l'essai n'a pas abouti" : r?.refus ?? null;
    await recordAudit({
      actorId: admin.id, action: "VALIDATE", module: "Centre de contrôle IA", field: "Essai de l'agent d'une personne",
      summary: `Essai de l'agent de ${cible.name} : « ${texte.slice(0, 160)} »${echec ? ` — non abouti : ${echec.slice(0, 160)}` : ""}`
        + ` — ${r?.consommation?.appels ?? 0} appel(s) de modèle, ${r?.consommation?.jetonsEntree ?? 0} + ${r?.consommation?.jetonsSortie ?? 0} jetons, ${(r?.consommation?.coutUsd ?? 0).toFixed(4)} $ (rien enregistré chez la personne)`,
    }).catch(sansBloquer("assistant-ia.essai.audit"));

    if (!issue.ok) return { ok: false, erreur: `L'essai n'a pas abouti : ${echec}` };
    return {
      ok: true,
      personne: { id: cible.id, nom: cible.name, role: cible.role },
      refus: r?.refus ?? null,
      tours: r?.ecran?.tours ?? [],
      ecritures: diff.lignes.map((l) => l.phrase),
      sorties: diff.effets.map((e) => e.phrase),
      consommation: r?.consommation ?? { appels: 0, jetonsEntree: 0, jetonsSortie: 0, coutUsd: 0 },
      dureeMs: issue.fin - issue.debut,
    };
  } finally {
    essaisEnCours--;
  }
}
