/**
 * BANC RÉEL DU LOT K7 (décision 0037) — « l'assistant fait ce que font les écrans », au vrai modèle, sur `amd_bench`.
 *
 *   1. LE SCÉNARIO EXACT DE LA DIRECTION : « Génère le suivi Regulatory et envoie-le à Amel Haddad. » — par le chemin du
 *      produit (`jouerTour`). Attendu : l'export appelé, le classeur dans le Drive (« Exports »), une CARTE d'envoi avec
 *      la pièce ; puis la carte confirmée (`confirmerIntentionAssistantIA`, sous la personne) ; puis le message REÇU
 *      par Amel, avec la pièce, qu'elle peut ouvrir.
 *   2. CINQ AUTRES EXPORTS, chacun en une phrase de tous les jours.
 *
 * Imprime les outils appelés, la réponse, le fichier, la latence et le COÛT (journal des appels de modèle). Base LOCALE
 * seulement ; acteur : le Super Admin du banc (`super@adventum-bench.dz`).
 *
 *   BENCH_SEED_ALLOW=1 npm run adam:bench:seed   # une fois
 *   npm run bench:live -- scripts/bench/k7-exports.ts
 */
import { prisma } from "@/lib/prisma";
import { personneDuGeste, executerHorsRequete } from "@/lib/contexte-geste";
import type { CurrentUser } from "@/lib/session";
import { jouerTour } from "@/modules/assistant-ia/api";
import { confirmerIntentionAssistantIA } from "@/modules/assistant-ia/actions";

const DEMANDES = [
  "Exporte en Excel les dossiers Regulatory en attente ANPP.",
  "Donne-moi l'Excel de l'appel d'offres PCH AO 2026/14.",
  "Sors-moi l'annuaire des médecins en Excel.",
  "Exporte le pilotage de la force de vente de ce mois.",
  "Exporte le suivi du coaching.",
];

const coutDepuis = async (userId: string, depuis: Date) => {
  const a = await prisma.modelCallLog.findMany({ where: { userId, at: { gte: depuis } }, select: { inputTokens: true, outputTokens: true, costUsd: true } });
  return { appels: a.length, entree: a.reduce((s, x) => s + (x.inputTokens ?? 0), 0), sortie: a.reduce((s, x) => s + (x.outputTokens ?? 0), 0), coutUsd: Math.round(a.reduce((s, x) => s + Number(x.costUsd ?? 0), 0) * 10000) / 10000 };
};

const exportsDepuis = (userId: string, depuis: Date) => prisma.driveNode.findMany({
  where: { ownerId: userId, type: "FILE", createdAt: { gte: depuis }, parent: { name: "Exports" } }, select: { id: true, name: true, size: true },
});

async function tour(user: CurrentUser, texte: string) {
  const t0 = new Date();
  const r = await jouerTour(user, { texte, pieces: [], historique: [] });
  return {
    ok: r.ok, ms: Date.now() - t0.getTime(),
    outils: r.ok ? r.outilsAppeles : [], reponse: r.ok ? r.content.slice(0, 600) : r.error,
    carte: r.ok && r.intent ? { id: r.intent.id, kind: r.intent.kind, titre: r.intent.title, champs: r.intent.fields, avertissements: r.intent.warnings ?? [] } : null,
    fichiers: await exportsDepuis(user.id, t0), cout: await coutDepuis(user.id, t0),
  };
}

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("Base locale seulement.");
  const sa = await prisma.user.findUniqueOrThrow({ where: { email: "super@adventum-bench.dz" }, select: { id: true } });
  const amel = await prisma.user.findUniqueOrThrow({ where: { email: "amel.haddad@adventum-bench.dz" }, select: { id: true, name: true } });
  const user = (await personneDuGeste(sa.id))!;
  const debut = new Date();

  // ── 1. Le scénario de la Direction ─────────────────────────────────────────────────────────────────────
  const s = await tour(user, `Génère le suivi Regulatory et envoie-le à ${amel.name}.`);
  console.info("SCÉNARIO DIRECTION", JSON.stringify(s, null, 2));
  let confirmation: unknown = null;
  let recu: unknown = null;
  if (s.carte) {
    confirmation = (await executerHorsRequete(user, "essai", () => confirmerIntentionAssistantIA(s.carte!.id))).resultat;
    const m = await prisma.message.findFirst({
      where: { senderId: user.id, createdAt: { gte: debut }, conversation: { members: { some: { userId: amel.id } } } },
      orderBy: { createdAt: "desc" },
      select: { body: true, attachments: { select: { name: true, driveNodeId: true } } },
    });
    const partage = m?.attachments[0]?.driveNodeId
      ? await prisma.driveShare.count({ where: { nodeId: m.attachments[0].driveNodeId, userId: amel.id } }) : 0;
    recu = { message: m, amelPeutOuvrir: partage > 0 };
  }
  console.info("CONFIRMATION", JSON.stringify(confirmation), "\nREÇU PAR AMEL", JSON.stringify(recu, null, 2));

  // ── 2. Cinq autres exports ─────────────────────────────────────────────────────────────────────────────
  const autres = [];
  for (const d of DEMANDES) {
    const r = await tour(user, d);
    autres.push({ demande: d, ...r });
    console.info(`\n« ${d} »`, JSON.stringify(r, null, 2));
  }
  const total = await coutDepuis(user.id, debut);
  const verdict = {
    scenario: Boolean(s.fichiers.length && s.carte && (confirmation as { ok?: boolean } | null)?.ok && (recu as { amelPeutOuvrir?: boolean } | null)?.amelPeutOuvrir),
    autres: autres.map((a) => ({ demande: a.demande, fichier: a.fichiers[0]?.name ?? null, ms: a.ms })),
    total,
  };
  console.info("\nVERDICT", JSON.stringify(verdict, null, 2));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
