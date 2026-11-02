import { prisma } from "@/lib/prisma";
import { ditQuiEstLaPersonne } from "@/platform/ia/memoire-identite";
import { attendu } from "@/lib/journal";
import { censurerTexte } from "../domaine/filtre-confidentialite";
import {
  CONSIGNE_CONSOLIDATION, doitConsolider, ECART_CONSOLIDATION_MS, entreeConsolidation, jetonsStockes, lireConsolidation, validerGroupe,
  type FaitStocke,
} from "../domaine/memoire/consolidation";
import { auNomDe, lireReglagesAssistantIa } from "./consommation";
import { genererTexte, modelesFactices } from "./generer";
import { jetonsDeLaMemoire, purgerHistoriqueMemoire } from "./memoire";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONSOLIDATION DE LA MÉMOIRE — exécution (règle : `domaine/memoire/consolidation.ts`).
 *
 * UN appel du modèle rapide par personne, en lot, quand sa mémoire occupe 85 % de son budget en jetons — au plus une
 * fois par jour (`AssistantIaPreference.memoireConsolideeLe`). Chaque groupe validé crée UN fait (origine
 * « consolidation ») ; les faits repris passent à l'historique (`active = false`, `remplaceLe`, `consolideDans`) et y
 * restent 12 mois : « annuler » sur le fait consolidé les rend actifs. Appelée après une capture qui fait franchir le
 * seuil, et par la tâche quotidienne `assistant.memoire` (qui purge aussi l'historique de plus de 12 mois).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Consolideur = (consigne: string, entree: string) => Promise<{ ok: true; texte: string } | { ok: false; raison: string }>;
const consolideurParDefaut: Consolideur = (c, e) => genererTexte(c, e, 60_000, { role: "rapide", origine: "memoire" });

export interface BilanConsolidation {
  fait: boolean;
  motif: "sous-le-seuil" | "trop-tot" | "modele" | "rien" | "consolide";
  jetonsAvant: number;
  jetonsApres: number;
  budget: number;
  groupes: number;
  faitsRepris: number;
  refuses: { contenu: string; raison: string }[];
}

const JOUR_MS = 24 * 3600_000;
const jours = (d: Date | null, maintenant: Date) => (d ? Math.max(0, Math.floor((maintenant.getTime() - d.getTime()) / JOUR_MS)) : null);

export async function consoliderMemoire(userId: string, o: { force?: boolean; maintenant?: Date; consolider?: Consolideur } = {}): Promise<BilanConsolidation> {
  const maintenant = o.maintenant ?? new Date();
  const budget = (await lireReglagesAssistantIa()).memoireJetonsBudget;
  const actifs = await prisma.assistantMemoryItem.findMany({
    where: { userId, active: true }, select: { id: true, type: true, content: true, createdAt: true, lastUsedAt: true }, orderBy: { createdAt: "asc" },
  });
  const faits: FaitStocke[] = actifs.map((a) => ({ id: a.id, sorte: a.type, contenu: a.content, ageJours: jours(a.createdAt, maintenant) ?? 0, rappelJours: jours(a.lastUsedAt, maintenant) }));
  const jetonsAvant = jetonsStockes(faits);
  const bilan = (motif: BilanConsolidation["motif"], x: Partial<BilanConsolidation> = {}): BilanConsolidation =>
    ({ fait: false, motif, jetonsAvant, jetonsApres: jetonsAvant, budget, groupes: 0, faitsRepris: 0, refuses: [], ...x });
  if (!o.force && !doitConsolider(jetonsAvant, budget)) return bilan("sous-le-seuil");
  const pref = await prisma.assistantIaPreference.findUnique({ where: { userId }, select: { memoireConsolideeLe: true } });
  if (!o.force && pref?.memoireConsolideeLe && maintenant.getTime() - pref.memoireConsolideeLe.getTime() < ECART_CONSOLIDATION_MS) return bilan("trop-tot");
  const consolider = o.consolider ?? (modelesFactices() ? null : consolideurParDefaut);
  if (!consolider) return bilan("modele");
  // Marqué AVANT l'appel : deux déclencheurs simultanés (capture + tâche) ne paient pas deux fois.
  await prisma.assistantIaPreference.upsert({ where: { userId }, create: { userId, memoireConsolideeLe: maintenant }, update: { memoireConsolideeLe: maintenant } });

  const { texte, cles } = entreeConsolidation(faits, budget);
  const r = await auNomDe(userId, () => consolider(CONSIGNE_CONSOLIDATION, censurerTexte(texte).texte), null);
  if (!r.ok) {
    console.warn("[assistant-memoire] consolidation", r.raison);
    return bilan("modele");
  }
  const parId = new Map(faits.map((f) => [f.id, f]));
  const refuses: BilanConsolidation["refuses"] = [];
  let groupes = 0;
  let faitsRepris = 0;
  for (const g of lireConsolidation(r.texte, cles)) {
    const remplaces = g.remplace.map((id) => parId.get(id)).filter((f): f is FaitStocke => !!f);
    const v = validerGroupe(g, remplaces);
    if (!v.ok || censurerTexte(g.contenu).censure) { refuses.push({ contenu: g.contenu, raison: v.ok ? "confidentiel" : v.raison }); continue; }
    if (ditQuiEstLaPersonne(g.contenu)) { refuses.push({ contenu: g.contenu, raison: "identité : vient du compte" }); continue; }
    const fait = await prisma.$transaction(async (tx) => {
      const neuf = await tx.assistantMemoryItem.create({ data: { userId, type: g.sorte, content: g.contenu, origine: "consolidation", confidence: 0.8 } });
      // ÉCRITURE CONDITIONNELLE : seuls les faits encore actifs et à CETTE personne sont repris ; sinon on défait le groupe.
      const pris = await tx.assistantMemoryItem.updateMany({ where: { id: { in: g.remplace }, userId, active: true }, data: { active: false, remplaceLe: maintenant, consolideDans: neuf.id } });
      if (pris.count !== g.remplace.length) throw new Error("faits changés entre-temps");
      return pris.count;
    }).catch(attendu("groupe défait : un fait a changé entre la lecture et l'écriture", 0));
    if (fait) { groupes += 1; faitsRepris += fait; } else refuses.push({ contenu: g.contenu, raison: "faits changés entre-temps" });
  }
  if (refuses.length) console.info("[assistant-memoire] groupes refusés par la règle", refuses.map((x) => x.raison));
  const jetonsApres = await jetonsDeLaMemoire(userId);
  return bilan(groupes ? "consolide" : "rien", { fait: groupes > 0, jetonsApres, groupes, faitsRepris, refuses });
}

/**
 * LA TÂCHE QUOTIDIENNE `assistant.memoire` : purge l'historique de plus de 12 mois, puis consolide les mémoires qui
 * dépassent 85 % de leur budget (une requête SQL les trouve sans charger les autres). Idempotente ; au plus une fois
 * toutes les 6 heures par processus (la tâche tourne à chaque battement).
 */
let derniereTache = 0;
export async function tacheMemoire(maintenant = new Date()): Promise<{ purges: number; consolidees: number } | null> {
  if (maintenant.getTime() - derniereTache < 6 * 3600_000) return null;
  derniereTache = maintenant.getTime();
  const { purges } = await purgerHistoriqueMemoire(maintenant);
  const budget = (await lireReglagesAssistantIa()).memoireJetonsBudget;
  // Une approximation par la LONGUEUR suffit à présélectionner ; `consoliderMemoire` recompte au compteur calibré.
  const seuilCaracteres = Math.floor(budget * 0.85 * 3.5);
  const candidats = await prisma.$queryRaw<{ userId: string }[]>`
    SELECT "userId" FROM "AssistantMemoryItem" WHERE "active" = true GROUP BY "userId" HAVING SUM(LENGTH("content") + 3) >= ${seuilCaracteres}`;
  let consolidees = 0;
  for (const c of candidats) if ((await consoliderMemoire(c.userId, { maintenant })).fait) consolidees += 1;
  return { purges, consolidees };
}

/** Pour les tests : la tâche repart (sa garde de 6 h est par processus). */
export function oublierDerniereTacheMemoire(): void {
  derniereTache = 0;
}
