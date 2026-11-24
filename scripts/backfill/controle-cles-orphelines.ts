import { prisma } from "@/lib/prisma";
import { resolveProductId } from "@/lib/products/resolve";
import { controlerCles } from "@/modules/pilotage/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRÔLE DES CLÉS ORPHELINES — en ligne de commande (lot « mémoire », lot 2 du recensement des données IA).
 *
 * Ce script n'a pas sa propre logique : il appelle `controlerCles` (module `pilotage`), le passage que la tâche
 * `pilotage.instantane` lance chaque jour en LECTURE. Idempotent, et il n'efface RIEN :
 *   • les liens d'influence restés sur une fiche médecin absorbée par une fusion (avant que la fusion ne les repointe)
 *     passent à la fiche gardée ; un lien que la gardée porte déjà, ou un lien entre les deux fiches, est SIGNALÉ ;
 *   • les lignes d'études de marché reçoivent leur produit quand la molécule le désigne certainement ;
 *   • le bilan est écrit en signaux datés (source « controle_cles ») et affiché ici.
 *
 *     npx tsx scripts/backfill/controle-cles-orphelines.ts             # compter et signaler seulement
 *     npx tsx scripts/backfill/controle-cles-orphelines.ts --corriger  # repointer et rattacher
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

async function main(): Promise<void> {
  const corriger = process.argv.includes("--corriger");
  const b = await controlerCles({ corriger, resoudreProduit: corriger ? resolveProductId : undefined });
  console.log(`Contrôle des clés du ${b.jour} (${corriger ? "correction" : "lecture seule"}) :`);
  console.log(`  fusions de fiches médecin lues ............ ${b.fusionsLues}`);
  console.log(`  liens d'influence sur une fiche absorbée .. ${b.liensSurFicheAbsorbee}${corriger ? ` (repointés : ${b.liensRepointes})` : ""}`);
  console.log(`  doublons après repointage (signalés) ...... ${b.doublonsSignales}`);
  console.log(`  boucles après repointage (signalées) ...... ${b.bouclesSignalees}`);
  console.log(`  liens sur une fiche archivée sans fusion .. ${b.liensSurFicheArchivee}`);
  console.log(`  liens sans fiche (clé cassée) ............. ${b.liensSansFiche}`);
  if (corriger) console.log(`  études de marché rattachées à un produit .. ${b.etudesRattachees} / ${b.etudesExaminees}`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
