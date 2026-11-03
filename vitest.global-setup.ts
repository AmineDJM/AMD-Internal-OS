/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SIÈGE STABLE DU CENTRE DE VALIDATIONS — posé une fois par `npm test`, avant tout fichier.
 *
 * Tout bon de commande pose une demande de validation adressée au siège du centre : le PLUS
 * ANCIEN Directeur Général actif, à défaut le plus ancien Super Admin (`centreValidatorFrom`,
 * §118.148). La base de tests n'avait AUCUN Directeur Général permanent. Dès qu'un banc en créait
 * un pour ses propres besoins — douze fichiers le font —, c'était LUI que tous les autres bancs
 * désignaient comme validateur de leurs BC, le temps qu'il existe. Puis son banc voulait le
 * supprimer : la clé étrangère des étapes de validation l'en empêchait, le compte restait, et le
 * run suivant tombait sur l'unicité de son adresse. MESURÉ : `__refmkt__dg@t.dz`, 21 étapes de
 * validation posées par d'AUTRES bancs à son nom.
 *
 * Un siège créé le 1er janvier 2000 est plus ancien que tout compte qu'un banc peut créer : il
 * est TOUJOURS choisi, et plus aucun compte de banc ne l'est. Aucun mot de passe ne lui ouvre de
 * session (l'empreinte « ! » ne correspond à rien).
 *
 * Ce n'est pas une donnée de production, et rien ne peut en faire une : `prisma.ts` refuse, à son
 * import, toute base de tests qui ne soit pas LOCALE (§118.90) — ce fichier passe par lui.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export const SIEGE_DE_BANC = "siege-dg@banc-de-tests.local";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉSIDU D'UN PASSAGE — mesuré à chaque suite, et TENU sur une suite complète (F1, 03/11/2026).
 *
 * Les tables que les bancs faisaient grossir sont comptées à l'ouverture, puis à la fermeture APRÈS le ménage de fin :
 * la différence est ce que ce passage laisse en base, dit table par table. Sur une suite COMPLÈTE (aucun fichier ni
 * filtre sur la ligne de commande — `npm test`), le résidu de chaque table ne dépasse pas son plafond
 * (`vitest.residu.json`) : un banc neuf qui laisse ses pièces, ses blobs ou ses comptes fait échouer la suite en le
 * nommant. ⚠ UN PLAFOND NE SE RELÈVE JAMAIS : un dépassement se corrige dans le banc qui sème (`menage-de-banc.ts`,
 * `retirerComptesPerimes`), et un chiffre qui baisse se reporte dans le fichier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export const TABLES_SURVEILLEES = [
  "User", "Notification", "Document", "StoredFile", "DriveNode", "FileVersion", "FileBlob", "FileBlobChunk", "Piece",
  "PieceLien", "BibliothequeFiche", "AssistantGesteJournal", "AssistantEffet", "EffetSortantDiffere",
] as const;
let ouverture: Record<string, number> | null = null;

type ClientDeComptage = { $queryRawUnsafe: <T>(q: string) => Promise<T> };
async function compterLesTables(prisma: ClientDeComptage): Promise<Record<string, number>> {
  const lignes = await prisma.$queryRawUnsafe<{ t: string; n: number }[]>(
    TABLES_SURVEILLEES.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM "${t}"`).join(" UNION ALL "));
  return Object.fromEntries(lignes.map((l) => [l.t, l.n]));
}

/** Une suite COMPLÈTE : `vitest run` sans fichier ni filtre (les options, elles, ne restreignent rien). */
function suiteComplete(argv: readonly string[] = process.argv): boolean {
  const apres = argv.slice(argv.findIndex((a) => a === "run") + 1);
  return argv.includes("run") && !apres.some((a) => !a.startsWith("-") && !/^\w+=/.test(a))
    && !apres.some((a) => /^(-t|--testNamePattern|--project|--dir)\b/.test(a));
}


export async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const { prisma } = await import("./src/lib/prisma");
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    // Pas de base joignable : les bancs qui en ont besoin se sautent d'eux-mêmes (`describe.skip`).
    return;
  }
  const doyen = new Date("2000-01-01T00:00:00.000Z");
  await prisma.user.upsert({
    where: { email: SIEGE_DE_BANC },
    create: {
      email: SIEGE_DE_BANC, name: "Siège DG — banc de tests", passwordHash: "!",
      role: "GENERAL_MANAGER", isActive: true, createdAt: doyen,
    },
    update: { role: "GENERAL_MANAGER", isActive: true, createdAt: doyen },
  });
  ouverture = await compterLesTables(prisma);
  await prisma.$disconnect();
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MÉNAGE DE FIN DE SUITE — ce qu'aucun banc ne peut ranger seul (F1, 03/11/2026).
 *
 * La base de tests grossissait sans fin d'un passage à l'autre (mesuré chez le parent : 22 Go, jusqu'au disque plein
 * — ENOSPC — et des bancs qui tombaient pour cela). Deux résidus ne relèvent d'AUCUN banc en particulier :
 *
 *   • LES BLOBS ORPHELINS. Un banc retire ses documents ; le contenu (FileBlob, FileBlobChunk) reste, parce que le
 *     ramasse-miettes du stockage est, par conception, un geste d'administration (`purgeOrphanBlobs`). Mesuré ici :
 *     18 228 blobs sur 20 728 que plus rien ne tient (1,5 Go). On passe LE RAMASSE-MIETTES DE PRODUCTION, tel quel :
 *     il lit dans le schéma tout ce qui peut tenir un blob et épargne un blob pris depuis moins d'une heure — ceux de
 *     ce passage partiront au suivant.
 *   • LE JOURNAL DES GESTES D'UN COMPTE DISPARU. Les bancs retirent leurs comptes, pas toujours le journal des gestes
 *     (`AssistantGesteJournal`, ses `AssistantEffet`) ni les envois différés (`EffetSortantDiffere`) faits en leur nom :
 *     `principalId` n'est pas une clé étrangère. Mesuré : 70 556 envois et 55 746 effets au nom de comptes qui
 *     n'existent plus. Un geste dont le principal n'existe plus ne peut plus être ni annulé ni rétabli par personne :
 *     c'est un reste de banc, et seulement cela ici (`prisma.ts` refuse toute base de tests qui ne soit pas LOCALE).
 *
   • LA BOÎTE DES DEUX COMPTES PERMANENTS de la base de tests : le siège DG posé ci-dessus et le compte système
 *     d'Adam (`lib/missions/agent/account.ts`). Ils sont notifiés PAR RÔLE par chaque banc (« Autorisation de paiement
 *     demandée »…), aucun banc ne peut retirer ce que les autres leur envoient, et rien ne lit leur boîte d'un passage
 *     à l'autre. Mesuré : 16 231 et 11 705 notifications.
 *
   • LES PIÈCES DU REGISTRE déposées par un compte qui n'existe plus et que plus rien ne désigne
 *     (`retirerPiecesDeComptesDisparus`, `menage-de-banc.ts`) : le registre survit par conception à ses documents, et
 *     un passage en laissait ~1 000. Les nœuds Drive sans auteur, eux, ne sont JAMAIS ménagés ici : un dossier système
 *     sans auteur peut contenir les fichiers d'un monde persistant (le banc d'audit) — chaque banc retire les siens.
 *
 * Rien d'autre n'est retiré à un compte qui existe encore, ni à un blob que quelque chose tient.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function teardown(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const { prisma } = await import("./src/lib/prisma");
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return;
  }
  try {
    // D'ABORD les comptes dont un banc a DIFFÉRÉ le retrait (retenus par la ligne d'un voisin, `menage-de-banc.ts`) :
    // plus aucun banc ne tourne, plus rien ne les retient — et leurs gestes partent juste après, avec ceux des disparus.
    const { retirerComptesDifferes } = await import("./src/lib/actions/internes/menage-de-banc");
    const differes = await retirerComptesDifferes();
    const sortants = await prisma.$executeRaw`
      DELETE FROM "EffetSortantDiffere" e
      WHERE e."principalId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = e."principalId")`;
    const gestes = await prisma.$executeRaw`
      DELETE FROM "AssistantGesteJournal" g
      WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = g."principalId")`;
    const { ADAM_EMAIL } = await import("./src/lib/missions/agent/account");
    const boites = await prisma.notification.deleteMany({ where: { user: { email: { in: [SIEGE_DE_BANC, ADAM_EMAIL] } } } });
    const { retirerPiecesDeComptesDisparus } = await import("./src/lib/actions/internes/menage-de-banc");
    const pieces = await retirerPiecesDeComptesDisparus();
    const { purgeOrphanBlobs } = await import("./src/lib/drive-storage");
    const blobs = await purgeOrphanBlobs();
    console.log(`[ménage de fin de suite] ${differes} compte(s) au retrait différé ; ${gestes} geste(s) et ${sortants} envoi(s) différé(s) de comptes disparus ; ${boites.count} notification(s) des comptes permanents ; ${pieces} pièce(s) de comptes disparus ; ${blobs.count} blob(s) orphelin(s) (${Math.round(blobs.bytes / 1_048_576)} Mo).`);
    if (ouverture) {
      const fermeture = await compterLesTables(prisma);
      const residu = Object.fromEntries(TABLES_SURVEILLEES.map((t) => [t, (fermeture[t] ?? 0) - (ouverture![t] ?? 0)]));
      console.log(`[résidu du passage] ${TABLES_SURVEILLEES.map((t) => `${t} ${residu[t]! >= 0 ? "+" : ""}${residu[t]}`).join(" · ")}`);
      if (suiteComplete()) {
        const { readFileSync } = await import("node:fs");
        const plafonds = JSON.parse(readFileSync(new URL("./vitest.residu.json", import.meta.url), "utf8")) as { plafonds: Record<string, number>; sansPlafond?: string[] };
        const depasses = TABLES_SURVEILLEES.filter((t) => !plafonds.sansPlafond?.includes(t) && residu[t]! > (plafonds.plafonds[t] ?? 0));
        if (depasses.length) {
          throw new Error(`Résidu d'une suite complète au-dessus du plafond (vitest.residu.json) — ${depasses.map((t) => `${t} +${residu[t]} > ${plafonds.plafonds[t] ?? 0}`).join(", ")}. Le banc qui sème doit retirer ce qu'il sème (menage-de-banc.ts) ; un plafond ne se relève jamais.`);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

