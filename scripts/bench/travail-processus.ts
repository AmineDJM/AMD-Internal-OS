/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN PROCESSUS QUI CONDUIT UN TRAVAIL — et qu'on peut TUER (J8, décision 0023, `travaux/robustesse.test.ts`).
 *
 * Le banc de robustesse lance ce script comme un vrai processus (web ou worker), le laisse avancer jusqu'à une
 * SONDE, puis l'abat par `SIGKILL` — l'arrêt brutal d'un redéploiement : pas de `finally`, pas de bail rendu,
 * une étape « en cours » en base. Le processus suivant arrive avec l'horloge avancée et reprend.
 *
 * La persona est un DOUBLE qui inscrit chaque effet dans un journal sur disque (une ligne JSON par appel,
 * `appendFileSync`) : c'est sur ce journal, qui survit au processus, que le banc compte les écritures et les
 * étapes refaites. Aucune clé de modèle, aucun appel réseau.
 *
 *   npx tsx scripts/bench/travail-processus.ts   (variables : voir `env` ci-dessous)
 *
 *   TRAVAIL_ID      le travail à conduire
 *   HORLOGE_MS      l'instant (horloge factice) de ce processus
 *   JOURNAL         le fichier où le double inscrit ses effets
 *   SONDE           « type:motif:n » — se BLOQUE au n-ième appel de ce type dont l'étape contient le motif
 *                   (types : lire, raisonner, apresGeste, partager, livrable, apresLivrable, fin) ; écrit « BLOQUE … »
 *   EXECUTEUR       « web » | « worker » (le banc de concurrence en lance un de chaque)
 *   LENTEUR_MS      durée de chaque raisonnement (pour que deux processus se chevauchent)
 *   RESPONSABLE_ID  le N+1 que rend `responsable` (escalades)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";

const env = (k: string, d = "") => process.env[k] ?? d;
const TRAVAIL = env("TRAVAIL_ID");
const JOURNAL = env("JOURNAL");
const T0 = Number(env("HORLOGE_MS", String(Date.now())));
const [SONDE_TYPE, SONDE_MOTIF = "", SONDE_N = "1"] = env("SONDE").split(":");
const LENTEUR = Number(env("LENTEUR_MS", "0"));
const EXECUTEUR = env("EXECUTEUR", "worker");

const compte = new Map<string, number>();
const noter = (o: Record<string, unknown>) => fs.appendFileSync(JOURNAL, `${JSON.stringify({ ...o, pid: process.pid, executeur: EXECUTEUR })}\n`);
const JAMAIS = () => new Promise<never>(() => undefined);

/** La sonde : au n-ième passage par ce point (pour cette étape), le processus se fige — le banc l'abat. */
async function sonde(type: string, etape: string): Promise<void> {
  if (type !== SONDE_TYPE || !etape.includes(SONDE_MOTIF)) return;
  const n = (compte.get(type) ?? 0) + 1;
  compte.set(type, n);
  if (n !== Number(SONDE_N)) return;
  process.stdout.write(`BLOQUE ${type} ${etape}\n`);
  await JAMAIS();
}

async function main(): Promise<void> {
  const { prisma } = await import("../../src/lib/prisma");
  const { balayerTravaux } = await import("../../src/lib/missions/travaux/balayage");
  type Persona = import("../../src/lib/missions/travaux/persona").PersonaTravaux;
  const clock = { now: () => new Date(T0) };
  const lu = () => (fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);

  const persona: Persona = {
    persona: "ASSISTANT_IA",
    nom: "Assistant IA",
    refusTravail: async () => null,
    catalogue: async () => ({
      lectures: [{ nom: "lister_demandes", libelle: "Demandes listées" }],
      gestes: [{ nom: "relancer", libelle: "Relance envoyée", famille: "ECRITURES", libelleFamille: "Écritures métier" }],
    }),
    lire: async (_p, outil) => {
      noter({ effet: "lire", outil });
      await sonde("lire", outil);
      return { ok: true, sortie: JSON.stringify({ demandes: Array.from({ length: 50 }, (_, i) => ({ id: `d${i + 1}`, montant: 1000 * (i + 1) })) }) };
    },
    refusGeste: async () => null,
    ecrire: async (_p, geste, entree) => {
      noter({ effet: "ecrire", geste, n: entree.n ?? null });
      return { ok: true, resultat: { envoye: true }, message: "Relance envoyée." };
    },
    raisonner: async (_p, d) => {
      const etape = /── ÉTAPE : (.*) ──/.exec(d.texte)?.[1] ?? "?";
      noter({ effet: "raisonner", etape, voitReponse: d.texte.includes("devis signé ci-joint") });
      await sonde("raisonner", etape);
      if (LENTEUR) await new Promise((r) => setTimeout(r, LENTEUR));
      const usage = { entree: 1000, sortie: 200, coutUsd: 0.01 };
      if (d.consigne.includes("LIVRABLE")) return { ok: true, texte: `# Rapport\n\n${etape} — fait.\n\n| Lot | Montant |\n|---|---|\n| 1 | 1000 |`, usage };
      return { ok: true, texte: JSON.stringify({ resultat: `analyse de ${etape}`, trouvailles: [`trouvaille ${etape}`], notes: [] }), usage };
    },
    plafonds: async () => ({ travailUsd: 20, mensuelUsd: 1000, depenseMoisUsd: 0, jourAtteint: false }),
    pieces: {
      visibles: async (_u, ids) => ids.map((nodeId) => ({ nodeId, nom: `pièce ${nodeId}` })),
      partager: async (ids, userId) => {
        noter({ effet: "partager", ids, userId });
        await sonde("partager", "demande");
      },
    },
    responsable: async () => env("RESPONSABLE_ID") || null,
    deposerLivrable: async (_p, d) => {
      // LA REPRISE RETROUVE le document déjà déposé (le journal fait office de Drive) — jamais deux exemplaires.
      const deja = d.reprise ? lu().find((l) => l.effet === "livrable" && l.cle === d.cle) : undefined;
      if (!deja) noter({ effet: "livrable", cle: d.cle, format: d.format });
      await sonde("livrable", d.titre);
      return { ok: true, document: { nodeId: `doc-${d.cle.slice(0, 8)}`, nom: `${d.titre}.${d.format}`, format: d.format, lien: "/drive/x" } };
    },
  };
  const PAS_SUSPENDU = async () => ({ suspendues: false, depuis: null, parId: null }) as never;
  // LES SONDES DE LA CONDUITE : juste après un geste (reçu clos, étape pas encore écrite), juste après un dépôt de livrable.
  const sondes = { apresGeste: (k: string) => sonde("apresGeste", k), apresLivrable: (k: string) => sonde("apresLivrable", k) };
  // UN PASSAGE DE BATTEMENT, puis d'autres tant que le travail avance.
  for (let i = 0; i < 30; i += 1) {
    const b = await balayerTravaux({ personas: { ASSISTANT_IA: persona }, clock, interrupteur: PAS_SUSPENDU, seulement: [TRAVAIL], executeur: EXECUTEUR as "web" | "worker", sondes });
    const c = b.conduits[0];
    const statut = (await prisma.mission.findUnique({ where: { id: TRAVAIL }, select: { status: true } }))?.status;
    if (statut === "COMPLETED" || statut === "FAILED" || statut === "CANCELLED") break;
    if (c?.arret === "BAIL") { process.stdout.write("BAIL\n"); await new Promise((r) => setTimeout(r, 200)); continue; }
    if (!c || c.executees + c.echouees === 0) break;
  }
  await sonde("fin", "");
  const statut = (await prisma.mission.findUnique({ where: { id: TRAVAIL }, select: { status: true } }))?.status;
  process.stdout.write(`FIN ${statut}\n`);
  await prisma.$disconnect();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
