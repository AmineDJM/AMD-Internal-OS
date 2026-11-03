/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN PROCESSUS QUI FAIT AVANCER LA FILE D'INTÉGRATION — et qu'on peut TUER (lot O2, décision 0059,
 * `src/lib/missions/equipe/processus.test.ts`). Aucun réseau : la forge est un VRAI dépôt git local (`RACINE`), partagé
 * par tous les processus du banc ; la base est la base locale.
 *
 *   DEPOSE={chantierId,tacheCle,branche,sha}  à `DEPART_MS` (horloge murale), dépose cette tâche verte dans la file ;
 *   puis fait avancer la file de (`DEPOT`, `CIBLE`) jusqu'à ce qu'elle soit vide (60 s au plus) ; écrit « FIN {json} ».
 *   SONDE=apres-fusion|avant-avance : le processus se FIGE à ce moment (écrit « BLOQUE <moment> ») — le banc l'abat.
 *   DECALAGE_MS : l'horloge du processus est en avance d'autant (un bail échu sans attendre).
 *
 *   npx tsx scripts/bench/equipe-processus.ts
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import { forgeGitLocale } from "@/lib/missions/chantiers/integration-test-outils";
import { avancerFile, deposerEnFile } from "@/lib/missions/equipe/integration";

const env = (k: string, d = "") => process.env[k] ?? d;

async function main(): Promise<void> {
  const forge = forgeGitLocale(env("RACINE"));
  const decalage = Number(env("DECALAGE_MS", "0"));
  const clock = { now: () => new Date(Date.now() + decalage) };
  const [proprietaire, nom] = env("DEPOT").split("/") as [string, string];
  const cible = env("CIBLE");
  const depose = env("DEPOSE") ? (JSON.parse(env("DEPOSE")) as { chantierId: string; tacheCle: string; branche: string; sha: string }) : null;
  const depart = Number(env("DEPART_MS", "0"));
  while (Date.now() < depart) await new Promise((r) => setTimeout(r, 2));
  if (depose) await deposerEnFile({ programmeId: env("PROGRAMME_ID"), chantierId: depose.chantierId, tacheCle: depose.tacheCle, depot: { proprietaire, nom }, cible, branche: depose.branche, shaTache: depose.sha });
  console.log("DEPOSE");
  const sonde = env("SONDE");
  const t0 = Date.now();
  const pas: { id: string; statut: string }[] = [];
  while (Date.now() - t0 < 60_000) {
    const r = await avancerFile(`${proprietaire}/${nom}`.toLowerCase(), cible, {
      forge, clock,
      sonde: async (m) => { if (sonde === m) { console.log(`BLOQUE ${m}`); await new Promise<never>(() => undefined); } },
    });
    if (r) pas.push(r);
    const restantes = await prisma.integrationFile.count({ where: { depot: `${proprietaire}/${nom}`.toLowerCase(), cible, statut: { in: ["EN_FILE", "EN_COURS", "CI", "A_VALIDER"] } } });
    if (!restantes) break;
    await new Promise((x) => setTimeout(x, 30));
  }
  console.log(`FIN ${JSON.stringify(pas)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
