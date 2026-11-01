/**
 * BANC RÉEL DE « L'EXPORT DE TOUT » (lot K7 suite, décision 0037 § 7 — Direction, 01/11/2026), parcimonieux, au vrai
 * modèle, sur `amd_bench`, par le chemin du produit (`jouerTour`, historique compris) :
 *
 *   1. « Exporte-moi les demandes de paiement en attente en Excel. »                    → exporter_demandes_paiement
 *   2. « Donne-moi la liste des médecins de Blida. » puis
 *      « Exporte la liste des médecins de Blida que tu viens de me donner en PDF. »      → relue, puis exporter_donnees
 *   3. « Fais-moi le tableau des demandes de paiement par état, avec le montant total. » puis
 *      « Exporte ce tableau en CSV. »                                                    → recalculé, puis exporter_donnees
 *
 * Imprime, tour par tour : outils, réponse, fichiers déposés au Drive « Exports », coût. Trois médecins de Blida (et un
 * d'Alger) sont semés pour le temps du banc, puis retirés. Base LOCALE seulement.
 *
 *   npm run bench:live -- scripts/bench/k7-export-de-tout.ts
 */
import { prisma } from "@/lib/prisma";
import { executerHorsRequete, personneDuGeste } from "@/lib/contexte-geste";
import type { CurrentUser } from "@/lib/session";
import { jouerTour } from "@/modules/assistant-ia/api";

const TAG = `__k7tout_${Date.now().toString(36)}`;
type Echange = { role: "user" | "assistant"; content: string };

async function tour(user: CurrentUser, texte: string, historique: Echange[]) {
  const t0 = new Date();
  // SOUS LA PERSONNE : une lecture de l'ERP (capacité R0) ne s'exécute que dans la session de la personne — le banc
  // n'a pas de requête, il se met dans son geste (comme `simulation-essai.ts`). Sans cela : « votre session ouverte ».
  const r = (await executerHorsRequete(user, "essai", () => jouerTour(user, { texte, pieces: [], historique }))).resultat;
  const appels = await prisma.modelCallLog.findMany({ where: { userId: user.id, at: { gte: t0 } }, select: { costUsd: true, inputTokens: true } });
  const fichiers = await prisma.driveNode.findMany({ where: { ownerId: user.id, type: "FILE", createdAt: { gte: t0 }, parent: { name: "Exports" } }, select: { name: true, size: true, mimeType: true } });
  const sortie = {
    demande: texte, ok: r.ok, ms: Date.now() - t0.getTime(), outils: r.ok ? r.outilsAppeles : [], reponse: r.ok ? r.content.slice(0, 700) : r.error,
    fichiers, appels: appels.length, coutUsd: Math.round(appels.reduce((s, a) => s + Number(a.costUsd ?? 0), 0) * 10000) / 10000,
  };
  console.info(JSON.stringify(sortie, null, 2));
  return { ...sortie, contenu: r.ok ? r.content : "" };
}

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("Base locale seulement.");
  const sa = await prisma.user.findUniqueOrThrow({ where: { email: "super@adventum-bench.dz" }, select: { id: true } });
  const user = (await personneDuGeste(sa.id))!;
  await prisma.medicalDoctor.createMany({
    data: [
      { name: `Dr Amrani Karim ${TAG}`, specialty: "Cardiologie", wilaya: "Blida", institution: "CHU Blida Frantz Fanon" },
      { name: `Dr Belkacem Nadia ${TAG}`, specialty: "Oncologie", wilaya: "Blida", institution: "CHU Blida Frantz Fanon" },
      { name: `Dr Cherif Yasmine ${TAG}`, specialty: "Pédiatrie", wilaya: "Blida", institution: "EPH Blida Boufarik" },
      { name: `Dr Djebbar Omar ${TAG}`, specialty: "Cardiologie", wilaya: "Alger", institution: "CHU Mustapha" },
    ],
  });
  const resultats = [];
  // `BANC_SEUL=2` : seulement la phrase des médecins (rejouer sans repayer les autres).
  const seul = process.env.BANC_SEUL ?? "";
  try {
    if (!seul || seul === "1") resultats.push(await tour(user, "Exporte-moi les demandes de paiement en attente en Excel.", []));
    if (!seul || seul === "2") {
      const liste = await tour(user, "Donne-moi la liste des médecins de Blida.", []);
      resultats.push(liste);
      resultats.push(await tour(user, "Exporte la liste des médecins de Blida que tu viens de me donner en PDF.", [
        { role: "user", content: "Donne-moi la liste des médecins de Blida." }, { role: "assistant", content: liste.contenu },
      ]));
    }
    if (seul && seul !== "3") return;
    const tableau = await tour(user, "Fais-moi le tableau des demandes de paiement par état, avec le montant total.", []);
    resultats.push(tableau);
    resultats.push(await tour(user, "Exporte ce tableau en CSV.", [
      { role: "user", content: "Fais-moi le tableau des demandes de paiement par état, avec le montant total." }, { role: "assistant", content: tableau.contenu },
    ]));
  } finally {
    await prisma.medicalDoctor.deleteMany({ where: { name: { endsWith: TAG } } });
  }
  console.info("\nVERDICT", JSON.stringify({
    tours: resultats.map((r) => ({ demande: r.demande, fichiers: r.fichiers.map((f) => f.name), outils: r.outils, ms: r.ms, coutUsd: r.coutUsd })),
    coutTotalUsd: Math.round(resultats.reduce((s, r) => s + r.coutUsd, 0) * 10000) / 10000,
  }, null, 2));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
