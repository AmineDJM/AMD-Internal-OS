/**
 * LE RECENSEMENT UNIQUE DES DOUBLONS DE FACTURES — en LECTURE SEULE (Direction, 14/10/2026).
 *
 * « On fait un passage unique sur les factures déjà en base pour lister aux Finances les doublons existants. »
 * Le script lit toutes les factures connues (registre Legal, pièces des demandes de paiement, fichiers « Facture » des
 * dossiers), les groupe par la règle du blocage (`factures/identite.ts`) et imprime les groupes CERTAINS puis
 * PROBABLES. Il n'appelle AUCUN modèle (les pièces déjà lues le sont par leur lecture gardée) et n'écrit RIEN.
 *
 * LA LECTURE SEULE EST TENUE PAR LA BASE, pas par une promesse : une seule connexion, mise en
 * `default_transaction_read_only` avant la première requête — une écriture échouerait (« cannot execute … in a
 * read-only transaction »). Les mêmes groupes se lisent à l'écran Finances › Doublons de factures.
 *
 *   npm run factures:doublons              — le rapport lisible
 *   npm run factures:doublons -- --json    — le même, en JSON
 */

function urlUneConnexion(brute: string | undefined): string {
  if (!brute) throw new Error("DATABASE_URL absente.");
  const u = new URL(brute);
  u.searchParams.set("connection_limit", "1");
  return u.toString();
}

async function main() {
  process.env.DATABASE_URL = urlUneConnexion(process.env.DATABASE_URL);
  const { prisma } = await import("@/lib/prisma");
  await prisma.$executeRawUnsafe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  const lectureSeule = await prisma.$queryRawUnsafe<{ transaction_read_only: string }[]>("SHOW transaction_read_only");
  if (lectureSeule[0]?.transaction_read_only !== "on") throw new Error("La session n'est pas en lecture seule : arrêt.");

  const { recenserDoublonsFactures } = await import("@/lib/factures/recensement");
  const r = await recenserDoublonsFactures();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    const certains = r.groupes.filter((g) => g.niveau === "CERTAIN");
    const probables = r.groupes.filter((g) => g.niveau === "PROBABLE");
    console.log(`Factures examinées : ${r.facturesExaminees}`);
    console.log(`Groupes CERTAINS : ${certains.length} · Groupes PROBABLES : ${probables.length}`);
    for (const g of r.groupes) {
      console.log(`\n[${g.niveau}] ${g.membres.length} pièces — ${g.raisons.join(" ")} (groupe ${g.signature})`);
      for (const m of g.membres) {
        const ident = [m.nature, m.numero ? `n° ${m.numero}` : null, m.fournisseur, m.date, m.ttc != null ? `${m.ttc.toLocaleString("fr-FR")} DZD` : null].filter(Boolean).join(" · ");
        console.log(`  - ${m.module} · ${m.dossier.titre} · ${m.piece}${ident ? ` · ${ident}` : ""} · ${m.paiement ? `${m.paiement} — ` : ""}${m.etat}${m.dossier.lien ? ` · ${m.dossier.lien}` : ""}`);
      }
    }
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[recensement des doublons] échec :", err instanceof Error ? err.message : err);
  process.exit(1);
});
