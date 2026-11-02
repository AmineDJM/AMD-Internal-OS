/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE JEU DE DONNÉES DU BANC ADAM — une entreprise pharma plausible, jetable, LOCALE.
 *
 *   BENCH_SEED_ALLOW=1 npx tsx scripts/bench/seed-adam-bench.ts          # (re)sème
 *   BENCH_SEED_ALLOW=1 npx tsx scripts/bench/seed-adam-bench.ts --clean  # retire tout
 *
 * ── POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────────────────
 *
 * La règle du produit est « aucune donnée simulée » — en PRODUCTION. Un banc de latence, de
 * coût et de justesse, lui, a besoin d'une base dont il connaît la vérité terrain : on ne peut
 * pas vérifier qu'Adam répond « Raihana » si personne ne sait qui porte le dossier. Ce script
 * fabrique cette vérité, la consigne (manifeste), et sait la retirer sans toucher au reste.
 *
 * ── LES TROIS GARDES ─────────────────────────────────────────────────────────────────────
 *
 *   1. Il REFUSE toute base qui n'est pas locale (hôte ≠ localhost/127.0.0.1) : semer une
 *      entreprise fictive dans la base d'Adventum serait une faute, pas une erreur.
 *   2. Il exige BENCH_SEED_ALLOW=1 : un `npm run` distrait ne sème rien.
 *   3. Tout ce qu'il crée est inscrit dans `bench-out/adam-bench-manifest.json` ; `--clean`
 *      (ou une re-exécution) retire EXACTEMENT ces lignes, par identifiant.
 *
 * Les noms sont fictifs. La vérité terrain que le banc vérifie est écrite dans `VERITES`
 * (exportée) — le banc l'importe, il ne la recopie pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
// Le client PARTAGÉ, et non un second : c'est lui qui porte la garde de base de banc, et un
// second client la contournerait en silence — une porte gardée à côté d'une porte ouverte
// (§118.71). L'import suffit à l'armer : il refuse AVANT la première requête.
import { prisma, estUneBaseDeBancOuDEssai } from "@/lib/prisma";
const MANIFEST = path.join(process.cwd(), "bench-out", "adam-bench-manifest.json");
export const BENCH_PASSWORD = "Bench12345!";
export const BENCH_DOMAIN = "adventum-bench.dz";

const DAY = 86_400_000;
const now = new Date();
const inDays = (d: number) => new Date(now.getTime() + d * DAY);
const at = (d: number, h: number) => { const x = inDays(d); x.setUTCHours(h - 1, 0, 0, 0); return x; }; // Africa/Algiers = UTC+1

/** La vérité terrain — ce que le banc a le droit d'attendre. */
export const VERITES = {
  /**
   * LE COMPTE TECHNIQUE DU BANC. Quatre bancs cherchent `role: "SUPER_ADMIN"` — dont un par
   * `orderBy: { createdAt: "asc" }`. Dans une base partagée, ils tombaient sur un administrateur
   * de PRODUCTION : le banc mesurait avec une identité étrangère à sa propre vérité terrain.
   * Il est créé EN PREMIER, il porte le domaine du banc, donc les deux retraits le connaissent.
   */
  admin: { name: "Racine du banc", email: `super@${BENCH_DOMAIN}` },
  pdg: { name: "Yacine Benali", email: `yacine.benali@${BENCH_DOMAIN}` },
  delegue: { name: "Fatma Zahra Bensaid", email: `fatma.bensaid@${BENCH_DOMAIN}` },
  personnes: {
    amel: { name: "Amel Haddad", email: `amel.haddad@${BENCH_DOMAIN}`, salaire: 240_000 },
    raihana: { name: "Raihana Cherif", email: `raihana.cherif@${BENCH_DOMAIN}`, salaire: 95_000 },
    khaled: { name: "Khaled Mansouri", email: `khaled.mansouri@${BENCH_DOMAIN}`, salaire: 185_000 },
    nesrine: { name: "Nesrine Boudiaf", email: `nesrine.boudiaf@${BENCH_DOMAIN}`, salaire: 120_000 },
    sofiane: { name: "Sofiane Kaci", email: `sofiane.kaci@${BENCH_DOMAIN}`, salaire: 210_000 },
    mehdi: { name: "Mehdi Larbi", email: `mehdi.larbi@${BENCH_DOMAIN}`, salaire: 130_000 },
  },
  produits: {
    nivolumab: { ref: "REG-2026-9011", dci: "Nivolumab", brand: "Nivolex", statut: "AWAITING_ANPP", responsable: "Amel Haddad", etape: "Évaluation ANPP — réserves reçues le 20/08/2026" },
    pembrolizumab: { ref: "REG-2026-9012", dci: "Pembrolizumab", brand: "Pembrolix", statut: "IN_PREPARATION", responsable: "Raihana Cherif", blocage: "CPP légalisé manquant" },
    trastuzumab: { ref: "REG-2026-9015", dci: "Trastuzumab", brand: "Trastuzex", statut: "BLOCKED", responsable: "Raihana Cherif", blocage: "certificat GMP du fabricant expiré depuis le 30/06/2026 — renouvellement attendu de Hetero Labs" },
    lenvatinib: { ref: "REG-2026-9014", dci: "Lenvatinib", brand: "Lenvatix", statut: "RESPONDING_TO_QUERIES", responsable: "Amel Haddad" },
    inexistant: { dci: "Ruxolitinib" },
  },
  contratHetero: { titre: "Contrat de distribution exclusive — Hetero Labs", fin: "2026-09-30", montant: 42_000_000 },
  factureImprimerie: { titre: "Facture n° 2026-0891 — Imprimerie El Djazaïr", montant: 380_000 },
  paiements: { hikma: { titre: "Règlement facture Hikma — lot 2026-07", montant: 2_450_000 }, imprimerie: { titre: "Acompte Imprimerie El Djazaïr — étiquetage Nivolex", montant: 380_000 } },
  pch: { ref: "AO 2026/14", titre: "Appel d'offres PCH 2026/14 — oncologie", echeanceJours: 5, caution: 5_000_000 },
  comite: { titre: "Comité de direction hebdomadaire", demainHeure: 9 },
  pv: { promesseAmel: "Amel Haddad s'engage à déposer la réponse aux réserves ANPP sur Nivolumab avant le 12 septembre 2026", promesseKhaled: "Khaled Mansouri : règlement de la facture Hikma sous 10 jours", promesseSofiane: "Sofiane Kaci : offre PCH AO 2026/14 finalisée le 8 septembre" },
  reserves: ["étude de bioéquivalence complète (rapport intégral et données brutes)", "maquettes d'étiquetage et notice en arabe et en français conformes à l'arrêté du 14 mars 2023", "CPP légalisé du pays d'origine daté de moins de six mois"],
} as const;

interface Manifest {
  createdAt: string;
  ids: Record<string, string[]>;
}

function lireManifest(): Manifest | null {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Manifest; } catch { return null; }
}

function garde(): void {
  // La MÊME lecture que `prisma.ts` — hôte local ET nom contenant « bench ». En écrire une
  // seconde ici donnerait deux vérités qui divergeraient au premier ajustement (§118.5), et
  // c'est la version en retard qui laisserait passer un semis dans la base de travail.
  const url = process.env.DATABASE_URL ?? "";
  if (!estUneBaseDeBancOuDEssai(url)) {
    let ou = "?";
    try { const u = new URL(url); ou = `${u.hostname}${u.pathname}`; } catch { /* URL illisible */ }
    throw new Error(
      `Refus : « ${ou} » n'est pas une base de banc (hôte local + nom contenant « bench »). `
      + `Le jeu du banc ne se sème JAMAIS ailleurs — lancer BENCH_SEED_ALLOW=1 npm run adam:bench:seed.`,
    );
  }
  if (process.env.BENCH_SEED_ALLOW !== "1") {
    throw new Error("Refus : BENCH_SEED_ALLOW=1 est exigé pour semer ou retirer le jeu du banc.");
  }
}

/**
 * Retire, dans l'ordre inverse des dépendances, tout ce que le manifeste connaît.
 *
 * ── UN NETTOYAGE PARTIEL NE DÉTRUIT PAS SA PROPRE TRACE ─────────────────────────────────
 *
 * La version précédente avalait chaque échec de suppression dans un `console.warn`, puis
 * effaçait le manifeste — le SEUL endroit qui savait quelles lignes existaient encore. Résultat
 * mesuré sur cette base : une société « Pharmagène Algérie » d'un semis d'il y a cinq jours,
 * orpheline pour toujours, plus un semis qui repart sur un terrain qu'il croit vierge et échoue
 * sur une contrainte d'unicité dont la cause est ailleurs. Un filtre silencieux ne laisse aucune
 * trace de ce qu'il retire (§118.52) ; ici il retirait la seule carte du terrain.
 *
 * Donc : ce qui résiste RESTE au manifeste, le compte est DIT à la fin, et le fichier ne
 * disparaît que lorsqu'il n'a plus rien à dire.
 */
async function nettoyer(m: Manifest): Promise<void> {
  const restants: Record<string, string[]> = {};
  const del = async (label: string, fn: (ids: string[]) => Promise<unknown>) => {
    const ids = m.ids[label] ?? [];
    if (ids.length === 0) return;
    try {
      await fn(ids);
    } catch (e) {
      restants[label] = ids;
      console.warn(`  · ${label} : ${ids.length} ligne(s) NON retirée(s) — ${(e as Error).message.slice(0, 120)}`);
    }
  };
  await del("auditLog", (ids) => prisma.auditLog.deleteMany({ where: { id: { in: ids } } }));
  await del("validationRequest", (ids) => prisma.validationRequest.deleteMany({ where: { id: { in: ids } } }));
  await del("calendarEvent", (ids) => prisma.calendarEvent.deleteMany({ where: { id: { in: ids } } }));
  await del("driveTextIndex", (ids) => prisma.driveTextIndex.deleteMany({ where: { id: { in: ids } } }));
  await del("fileVersion", (ids) => prisma.fileVersion.deleteMany({ where: { id: { in: ids } } }));
  await del("driveNode", (ids) => prisma.driveNode.deleteMany({ where: { id: { in: ids } } }));
  await del("fileBlob", (ids) => prisma.fileBlob.deleteMany({ where: { id: { in: ids } } }));
  await del("mailEntry", (ids) => prisma.mailEntry.deleteMany({ where: { id: { in: ids } } }));
  await del("mailPartner", (ids) => prisma.mailPartner.deleteMany({ where: { id: { in: ids } } }));
  await del("legalDocument", (ids) => prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }));
  await del("pchTender", (ids) => prisma.pchTender.deleteMany({ where: { id: { in: ids } } }));
  await del("expenseOrder", (ids) => prisma.expenseOrder.deleteMany({ where: { id: { in: ids } } }));
  await del("paymentRequest", (ids) => prisma.paymentRequest.deleteMany({ where: { id: { in: ids } } }));
  await del("task", (ids) => prisma.task.deleteMany({ where: { id: { in: ids } } }));
  await del("regulatoryDossier", (ids) => prisma.regulatoryDossier.deleteMany({ where: { id: { in: ids } } }));
  await del("regulatoryProduct", (ids) => prisma.regulatoryProduct.deleteMany({ where: { id: { in: ids } } }));
  await del("employee", (ids) => prisma.employee.deleteMany({ where: { id: { in: ids } } }));
  await del("department", (ids) => prisma.department.deleteMany({ where: { id: { in: ids } } }));
  await del("user", async (ids) => {
    await prisma.assistantMessage.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.assistantThread.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.assistantMemory.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.mission.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => undefined);
    // Ce que les DÉFIS du banc live ont produit : règles enseignées, fichiers émis ou déposés.
    await prisma.adamRule.deleteMany({ where: { OR: [{ ownerId: { in: ids } }, { subjectUserId: { in: ids } }] } }).catch(() => undefined);
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => undefined);
    return prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
  await del("company", (ids) => prisma.company.deleteMany({ where: { id: { in: ids } } }));

  const labels = Object.keys(restants);
  if (labels.length === 0) {
    fs.rmSync(MANIFEST, { force: true });
    return;
  }
  const total = labels.reduce((n, l) => n + restants[l]!.length, 0);
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify({ createdAt: m.createdAt, ids: restants } satisfies Manifest, null, 2));
  console.warn(
    `  ⚠ ${total} ligne(s) survivent au nettoyage (${labels.join(", ")}). Le manifeste les GARDE :\n`
    + `    relancer \`--clean\` après avoir levé la cause, sans quoi elles resteront orphelines.`,
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RETIRER LE JEU PRÉCÉDENT SANS MANIFESTE — parce que le manifeste est le fichier le plus
 * volatile du dépôt.
 *
 * ── CE QUI A ÉTÉ MESURÉ ──────────────────────────────────────────────────────────────────
 *
 * `bench-out/` est ignoré par git, donc perdu au premier conteneur neuf, alors que Postgres
 * garde ses lignes. Le semis repartait sur un terrain qu'il croyait vierge et échouait sur
 * `Unique constraint failed on (code)`, puis sur `(email)` — une erreur qui ne ressemble pas à
 * sa cause, sur la SEULE chose qui rend une campagne live possible (§118.84).
 *
 * ── LE FAIT SUR LEQUEL CE RETRAIT S'ARME ─────────────────────────────────────────────────
 *
 * `BENCH_DOMAIN` : les comptes du banc, et eux seuls, vivent sur `@adventum-bench.dz`. Ce
 * n'est pas une variable qu'un semis futur devrait penser à poser — c'est ce que le banc
 * ÉCRIT (§118.17). Tout ce qu'il fabrique est créé PAR l'un de ces comptes, donc le graphe des
 * clés étrangères suffit à le retrouver sans inventaire à la main.
 *
 * ── CE QU'IL NE TOUCHE JAMAIS ────────────────────────────────────────────────────────────
 *
 * Les sociétés et les départements du bootstrap (« Adventum Pharma », « DG », « REG »…) : ils
 * PRÉEXISTENT et le banc les réutilise. Un retrait qui les emporterait détruirait des données
 * qui ne sont pas les siennes — l'empreinte réelle dépasserait l'empreinte demandée (§118.16).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function retirerParIdentite(): Promise<void> {
  const comptes = await prisma.user.findMany({
    where: { email: { endsWith: `@${BENCH_DOMAIN}` } },
    select: { id: true },
  });
  if (comptes.length === 0) return;
  const ids = comptes.map((u) => u.id);
  console.log(`Jeu précédent : ${ids.length} compte(s) @${BENCH_DOMAIN} en base — retrait par identité…`);

  const par = async (label: string, fn: () => Promise<{ count: number }>) => {
    try {
      const r = await fn();
      if (r.count > 0) console.log(`  · ${label} : ${r.count}`);
    } catch (e) {
      // On DIT ce qui résiste : le semis qui suit échouerait sur une contrainte dont la cause
      // serait invisible, et c'est exactement le défaut qu'on est en train de fermer.
      console.warn(`  ⚠ ${label} : ${(e as Error).message.slice(0, 140)}`);
    }
  };
  // L'ORDRE EST CELUI DES DÉPENDANCES, comme le retrait par manifeste juste au-dessus.
  await par("auditLog", () => prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }));
  await par("validationRequest", () => prisma.validationRequest.deleteMany({ where: { requesterId: { in: ids } } }));
  await par("calendarEvent", () => prisma.calendarEvent.deleteMany({ where: { OR: [{ organizerId: { in: ids } }, { createdById: { in: ids } }] } }));
  await par("assistantMessage", () => prisma.assistantMessage.deleteMany({ where: { userId: { in: ids } } }));
  await par("assistantThread", () => prisma.assistantThread.deleteMany({ where: { userId: { in: ids } } }));
  await par("assistantMemory", () => prisma.assistantMemory.deleteMany({ where: { userId: { in: ids } } }));
  await par("assistantActionIntent", () => prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }));
  await par("adamRule", () => prisma.adamRule.deleteMany({ where: { OR: [{ ownerId: { in: ids } }, { subjectUserId: { in: ids } }] } }));
  await par("mission", () => prisma.mission.deleteMany({ where: { ownerId: { in: ids } } }));
  await par("driveTextIndex", () => prisma.driveTextIndex.deleteMany({ where: { node: { OR: [{ ownerId: { in: ids } }, { createdById: { in: ids } }] } } }));
  await par("fileVersion", () => prisma.fileVersion.deleteMany({ where: { node: { OR: [{ ownerId: { in: ids } }, { createdById: { in: ids } }] } } }));
  await par("driveNode", () => prisma.driveNode.deleteMany({ where: { OR: [{ ownerId: { in: ids } }, { createdById: { in: ids } }] } }));
  await par("mailEntry", () => prisma.mailEntry.deleteMany({ where: { OR: [{ createdById: { in: ids } }, { concernedUserId: { in: ids } }] } }));
  await par("legalDocument", () => prisma.legalDocument.deleteMany({ where: { createdById: { in: ids } } }));
  await par("paymentRequest", () => prisma.paymentRequest.deleteMany({ where: { requesterId: { in: ids } } }));
  await par("expenseOrder", () => prisma.expenseOrder.deleteMany({ where: { requestedById: { in: ids } } }));
  await par("pchTender", () => prisma.pchTender.deleteMany({ where: { createdById: { in: ids } } }));
  await par("task", () => prisma.task.deleteMany({ where: { createdById: { in: ids } } }));
  await par("regulatoryDossier", () => prisma.regulatoryDossier.deleteMany({ where: { createdById: { in: ids } } }));
  await par("regulatoryProduct", () => prisma.regulatoryProduct.deleteMany({ where: { createdById: { in: ids } } }));
  await par("employee", () => prisma.employee.deleteMany({ where: { userId: { in: ids } } }));
  await par("userCompanyAccess", () => prisma.userCompanyAccess.deleteMany({ where: { userId: { in: ids } } }));
  await par("user", () => prisma.user.deleteMany({ where: { id: { in: ids } } }));

  const restants = await prisma.user.count({ where: { email: { endsWith: `@${BENCH_DOMAIN}` } } });
  if (restants > 0) {
    throw new Error(
      `${restants} compte(s) @${BENCH_DOMAIN} survivent au retrait : le semis échouerait sur une `
      + `contrainte d'unicité dont la cause serait invisible. Lever la dépendance nommée ci-dessus.`,
    );
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA REMISE À ZÉRO — ce que ni le manifeste ni l'identité ne peuvent faire.
 *
 * ── LE DÉFAUT MESURÉ, ET IL EST STRUCTUREL ───────────────────────────────────────────────
 *
 * Le retrait par IDENTITÉ trouve une ligne par son AUTEUR. Or supprimer un compte NULLIFIE ce
 * lien au lieu de supprimer la ligne (`onDelete: SetNull`) : la ligne devient orpheline, donc
 * introuvable par le critère même qui l'aurait trouvée. Mesuré sur `amd_bench` : 78
 * `RegulatoryProduct` sans auteur, dont les huit références du semis — et un semis qui échoue
 * sur `REG-2026-9011` en accusant sa propre idempotence. La purge détruisait sa poignée, comme
 * le nettoyage détruisait son manifeste (§118.52), un cran plus bas.
 *
 * On ne referme pas ça avec une liste de clés uniques écrite à la main : le schéma en porte
 * QUATRE-VINGTS, et une liste manuelle est fausse le jour où quelqu'un en ajoute une, en
 * silence (§118.73). On cherche l'endroit où TOUTES les instances passent (§118.58) : la base
 * elle-même.
 *
 * ── POURQUOI C'EST PERMIS ICI, ET SEULEMENT ICI ──────────────────────────────────────────
 *
 * `prisma.ts` refuse d'ouvrir une base qui ne soit pas celle du banc — hôte local, nom
 * contenant « bench ». La base du banc lui APPARTIENT donc, et la vider est le geste normal
 * d'un banc reproductible (§118.73 : un run final se juge sur un état de départ identique).
 * La garde est néanmoins REDEMANDÉE juste avant le `TRUNCATE` : une opération destructrice
 * porte sa propre raison, elle ne l'emprunte pas à un appelant.
 *
 * La liste des tables vient d'`information_schema` — jamais du schéma Prisma recopié : une
 * table ajoutée demain est vidée sans que personne y pense.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function reinitialiser(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!estUneBaseDeBancOuDEssai(url)) throw new Error("Refus : la remise à zéro n'agit que sur une base de banc.");

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  const cibles = tables.map((t) => t.tablename).filter((t) => !t.startsWith("_prisma"));
  if (cibles.length === 0) throw new Error("Refus : aucune table trouvée — le schéma n'est pas déployé sur cette base.");

  const liste = cibles.map((t) => `"public"."${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${liste} RESTART IDENTITY CASCADE`);
  // Le manifeste ne décrit plus rien : le garder ferait échouer le retrait suivant sur des
  // identifiants qui n'existent plus, et un avertissement qui ne veut rien dire fait cesser de
  // lire les avertissements (§118.32).
  try { fs.rmSync(MANIFEST); } catch { /* absent : rien à retirer */ }
  console.log(`Base du banc remise à zéro : ${cibles.length} tables vidées.`);
}

async function semer(): Promise<void> {
  const ids: Record<string, string[]> = {};
  // Le manifeste s'écrit AU FIL DE L'EAU : un semis interrompu à mi-chemin reste retirable.
  const flush = () => {
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify({ createdAt: new Date().toISOString(), ids } satisfies Manifest, null, 2));
  };
  const note = (label: string, id: string) => { (ids[label] ??= []).push(id); flush(); return id; };
  const hash = bcrypt.hashSync(BENCH_PASSWORD, 10);

  // ── Sociétés & départements ──────────────────────────────────────────────────────────
  // Les sociétés peuvent PRÉEXISTER (le bootstrap crée « Adventum Pharma ») : on les réutilise
  // sans les inscrire au manifeste — le nettoyage ne retire que ce que ce script a créé.
  const societe = async (name: string, shortName: string, color: string) => {
    const existante = await prisma.company.findUnique({ where: { name }, select: { id: true } });
    if (existante) return existante;
    const c = await prisma.company.create({ data: { name, shortName, color }, select: { id: true } });
    note("company", c.id);
    return c;
  };
  const adventum = await societe("Adventum Pharma", "Adventum", "#0f766e");
  const pharmagene = await societe("Pharmagène Algérie", "Pharmagène", "#7c3aed");

  /**
   * LES DÉPARTEMENTS PEUVENT PRÉEXISTER — et `Department.code` est unique GLOBALEMENT.
   *
   * Le semis échouait sur `Unique constraint failed on (code)` : le bootstrap crée « DG », « REG »,
   * « FIN »… sous « Adventum Pharma », et le banc voulait les recréer. Deux conséquences, la
   * seconde pire que la première : la campagne LIVE entière était injouable, et l'erreur ne
   * ressemblait pas à sa cause (§118.84 — un banc qui ne peut pas tourner ne produit aucune trace
   * de ce qu'il n'a pas vérifié).
   *
   * La règle des SOCIÉTÉS existait déjà juste au-dessus ; c'est la même, un champ plus loin
   * (§118.61 : une réparation déplace une hypothèse, il faut retrouver tous ceux qui la lisaient).
   * Réutilisé ⇒ PAS inscrit au manifeste : le nettoyage ne retire que ce que ce script a créé.
   */
  const dept = async (name: string, code: string) => {
    const existant = await prisma.department.findUnique({ where: { code }, select: { id: true } });
    if (existant) return existant.id;
    const d = await prisma.department.create({ data: { name, code, companyId: adventum.id } });
    return note("department", d.id);
  };
  const dDG = await dept("Direction Générale", "DG");
  const dREG = await dept("Affaires Réglementaires", "REG");
  const dFIN = await dept("Finances", "FIN");
  const dRH = await dept("Ressources Humaines", "RH");
  const dVENTES = await dept("Ventes & Marchés publics", "VENTES");
  const dLOG = await dept("Supply Chain", "LOG");

  // ── Personnes : comptes + fiches RH ──────────────────────────────────────────────────
  type P = { key: string; name: string; email: string; role: Prisma.UserCreateInput["role"]; position: string; deptId: string; salaire: number; net: number };
  const P = VERITES.personnes;
  const personnes: P[] = [
    { key: "pdg", name: VERITES.pdg.name, email: VERITES.pdg.email, role: "DIRECTION", position: "Président-Directeur Général", deptId: dDG, salaire: 450_000, net: 320_000 },
    { key: "amel", name: P.amel.name, email: P.amel.email, role: "HEAD_OF_REGULATORY", position: "Directrice des Affaires Réglementaires", deptId: dREG, salaire: P.amel.salaire, net: 178_000 },
    { key: "raihana", name: P.raihana.name, email: P.raihana.email, role: "REGULATORY_ASSISTANT", position: "Chargée d'enregistrement", deptId: dREG, salaire: P.raihana.salaire, net: 74_000 },
    { key: "khaled", name: P.khaled.name, email: P.khaled.email, role: "FINANCE_BUDGET_MANAGER", position: "Directeur Administratif et Financier", deptId: dFIN, salaire: P.khaled.salaire, net: 139_000 },
    { key: "nesrine", name: P.nesrine.name, email: P.nesrine.email, role: "COORDINATOR", position: "Responsable Ressources Humaines", deptId: dRH, salaire: P.nesrine.salaire, net: 92_000 },
    { key: "sofiane", name: P.sofiane.name, email: P.sofiane.email, role: "HEAD_OF_SALES", position: "Directeur Commercial & Marchés publics", deptId: dVENTES, salaire: P.sofiane.salaire, net: 156_000 },
    { key: "mehdi", name: P.mehdi.name, email: P.mehdi.email, role: "LOGISTICS_MANAGER", position: "Responsable Supply Chain", deptId: dLOG, salaire: P.mehdi.salaire, net: 98_000 },
    { key: "delegue", name: VERITES.delegue.name, email: VERITES.delegue.email, role: "MEDICAL_DELEGATE", position: "Déléguée médicale — Alger Centre", deptId: dVENTES, salaire: 85_000, net: 66_000 },
  ];
  const U: Record<string, string> = {};
  const E: Record<string, string> = {};
  // AVANT tout le monde : le compte technique. Il n'a pas de fiche RH — ce n'est pas un salarié.
  U.admin = note("user", (await prisma.user.create({
    data: { name: VERITES.admin.name, email: VERITES.admin.email, passwordHash: hash, role: "SUPER_ADMIN", title: "Super Administrateur (banc)", isActive: true },
  })).id);
  for (const p of personnes) {
    const u = await prisma.user.create({ data: { name: p.name, email: p.email, passwordHash: hash, role: p.role, title: p.position, departmentId: p.deptId, isActive: true } });
    U[p.key] = note("user", u.id);
    const e = await prisma.employee.create({
      data: {
        fullName: p.name, email: p.email, position: p.position, departmentId: p.deptId, companyId: adventum.id, userId: u.id,
        baseSalary: p.salaire, netToPay: p.net, grossSalary: Math.round(p.salaire * 1.18), employerCost: Math.round(p.salaire * 1.45),
        hireDate: inDays(-900 - personnes.indexOf(p) * 120), contractType: "CDI", isActive: true,
      },
    });
    E[p.key] = note("employee", e.id);
  }
  // Hiérarchie : tout le monde rend compte au PDG, sauf Raihana (→ Amel) et la déléguée (→ Sofiane).
  await prisma.employee.updateMany({ where: { id: { in: [E.amel, E.khaled, E.nesrine, E.sofiane, E.mehdi] } }, data: { managerId: E.pdg } });
  await prisma.employee.update({ where: { id: E.raihana }, data: { managerId: E.amel } });
  await prisma.employee.update({ where: { id: E.delegue }, data: { managerId: E.sofiane } });
  await prisma.department.update({ where: { id: dREG }, data: { headId: E.amel } });
  await prisma.department.update({ where: { id: dFIN }, data: { headId: E.khaled } });
  await prisma.department.update({ where: { id: dVENTES }, data: { headId: E.sofiane } });
  await prisma.department.update({ where: { id: dDG }, data: { headId: E.pdg } });

  // LE PDG ENGAGE SES SOCIÉTÉS. L'écriture sur une entité se donne explicitement dans l'ERP
  // (`canEditCompany` : l'appartenance donne la lecture, pas l'écriture). Sans ces lignes, le PDG
  // du banc VOYAIT Adventum sans pouvoir émettre une pièce ni poser une règle en son nom — les
  // défis « fabrique » et « règle de société » tombaient sur un refus de droits, pas sur Adam.
  // C'est exactement ce que l'écran d'administration des accès accorde à un dirigeant. La
  // déléguée, elle, ne reçoit rien : c'est ce que les cas de permission mesurent.
  for (const companyId of [adventum.id, pharmagene.id]) {
    await prisma.userCompanyAccess.upsert({
      where: { userId_companyId: { userId: U.pdg, companyId } },
      update: { canEdit: true },
      create: { userId: U.pdg, companyId, canEdit: true },
    });
  }

  // ── Produits Regulatory (circuit ANPP coché = la même source que l'écran) ─────────────
  const wf = (done: string[], enCours?: string, dates: Record<string, string> = {}) => {
    const w: Record<string, { status: string; date?: string }> = {};
    for (const k of done) w[k] = { status: "DONE", ...(dates[k] ? { date: dates[k] } : {}) };
    if (enCours) w[enCours] = { status: "IN_PROGRESS" };
    return w;
  };
  const PREP = ["ctd", "presub_checklist", "sample", "bv25_req", "bv25_pay", "presub_req", "presub_ans"];
  const ADMIN = ["modules345", "bv75_req", "module1", "docs_check", "bv75_pay"];
  const produits: Prisma.RegulatoryProductCreateInput[] = [
    { reference: VERITES.produits.nivolumab.ref, dci: "Nivolumab", brandName: "Nivolex", dosage: "10 mg/ml", pharmaceuticalForm: "Solution à diluer pour perfusion", therapeuticClass: "Oncologie — immunothérapie", partnerLab: "Hetero Labs", countryOfOrigin: "Inde",
      status: "AWAITING_ANPP", priority: "CRITICAL", company: { connect: { id: adventum.id } }, responsible: { connect: { id: U.amel } }, assistant: { connect: { id: U.raihana } },
      targetDate: inDays(90), comments: "Réserves ANPP notifiées le 20/08/2026 (courrier ANPP/DE/2026-1147) : bioéquivalence, étiquetage bilingue, CPP légalisé. Réponse à déposer avant le 12/09/2026.",
      workflow: wf([...PREP, ...ADMIN, "rdv", "depot", "recevabilite"], "evaluation", { depot: "2026-06-10", recevabilite: "2026-07-02" }) },
    { reference: VERITES.produits.pembrolizumab.ref, dci: "Pembrolizumab", brandName: "Pembrolix", dosage: "100 mg/4 ml", pharmaceuticalForm: "Solution pour perfusion", therapeuticClass: "Oncologie — immunothérapie", partnerLab: "Julphar", countryOfOrigin: "Émirats arabes unis",
      status: "IN_PREPARATION", priority: "HIGH", company: { connect: { id: adventum.id } }, responsible: { connect: { id: U.raihana } },
      targetSubmissionDate: inDays(30), comments: "Dépôt bloqué : CPP légalisé manquant (demandé à Julphar le 12/08/2026, relancé le 26/08/2026).",
      workflow: wf([...PREP, "modules345", "bv75_req"], "module1") },
    { reference: "REG-2026-9013", dci: "Bictegravir + Emtricitabine + Ténofovir alafénamide", brandName: "Trivira", dosage: "50/200/25 mg", pharmaceuticalForm: "Comprimé pelliculé", therapeuticClass: "Antirétroviraux", partnerLab: "Cipla", countryOfOrigin: "Inde",
      status: "SUBMITTED", priority: "HIGH", company: { connect: { id: adventum.id } }, responsible: { connect: { id: U.amel } },
      workflow: wf([...PREP, ...ADMIN, "rdv", "depot"], "recevabilite", { depot: "2026-08-27" }) },
    { reference: VERITES.produits.lenvatinib.ref, dci: "Lenvatinib", brandName: "Lenvatix", dosage: "4 mg / 10 mg", pharmaceuticalForm: "Gélule", therapeuticClass: "Oncologie — inhibiteur de tyrosine kinase", partnerLab: "Hetero Labs", countryOfOrigin: "Inde",
      status: "RESPONDING_TO_QUERIES", priority: "MEDIUM", company: { connect: { id: adventum.id } }, responsible: { connect: { id: U.amel } }, assistant: { connect: { id: U.raihana } },
      comments: "Demande de compléments ANPP du 05/08/2026 (stabilité zone IVb) — réponse déposée le 01/09/2026.",
      workflow: wf([...PREP, ...ADMIN, "rdv", "depot", "recevabilite", "evaluation", "reponses_depot"], undefined, { depot: "2026-04-15", reponses_depot: "2026-09-01" }) },
    { reference: VERITES.produits.trastuzumab.ref, dci: "Trastuzumab", brandName: "Trastuzex", dosage: "440 mg", pharmaceuticalForm: "Poudre pour solution à diluer", therapeuticClass: "Oncologie — anticorps monoclonal", partnerLab: "Hetero Labs", countryOfOrigin: "Inde",
      status: "BLOCKED", priority: "HIGH", company: { connect: { id: adventum.id } }, responsible: { connect: { id: U.raihana } },
      comments: "BLOQUÉ : certificat GMP du fabricant (Hetero Biopharma, unité de Hyderabad) expiré depuis le 30/06/2026 — renouvellement attendu de Hetero Labs, relance envoyée le 25/08/2026. Sans GMP valide, la check-list de présoumission ne peut pas être close.",
      workflow: wf(["ctd"], "presub_checklist") },
    { reference: "REG-2026-9016", dci: "Nintedanib", brandName: "Nintedax", dosage: "150 mg", pharmaceuticalForm: "Capsule molle", therapeuticClass: "Pneumologie — fibrose pulmonaire", partnerLab: "Cipla", countryOfOrigin: "Inde",
      status: "DECISION_OBTAINED", priority: "MEDIUM", company: { connect: { id: adventum.id } }, responsible: { connect: { id: U.amel } },
      comments: "Décision d'enregistrement obtenue le 18/07/2026 — attestation de prix reçue.",
      workflow: wf([...PREP, ...ADMIN, "rdv", "depot", "recevabilite", "evaluation", "reponses_depot", "commission", "decision"], undefined, { decision: "2026-07-18" }) },
    { reference: "REG-2026-9017", dci: "Bosutinib", brandName: "Bosutix", dosage: "100 mg / 500 mg", pharmaceuticalForm: "Comprimé pelliculé", therapeuticClass: "Oncologie — LMC", partnerLab: "Cipla", countryOfOrigin: "Inde",
      status: "PRE_SUBMISSION", priority: "LOW", company: { connect: { id: pharmagene.id } }, responsible: { connect: { id: U.raihana } },
      workflow: wf(["ctd", "presub_checklist"], "sample") },
    { reference: "REG-2026-9018", dci: "Osimertinib", brandName: "Osimerix", dosage: "80 mg", pharmaceuticalForm: "Comprimé pelliculé", therapeuticClass: "Oncologie — CBNPC", partnerLab: "Julphar", countryOfOrigin: "Émirats arabes unis",
      status: "IN_PREPARATION", priority: "MEDIUM", company: { connect: { id: adventum.id } }, responsible: { connect: { id: U.amel } },
      workflow: wf([...PREP], "modules345") },
  ];
  const R: Record<string, string> = {};
  for (const p of produits) {
    const r = await prisma.regulatoryProduct.create({ data: p, select: { id: true, reference: true } });
    R[r.reference] = note("regulatoryProduct", r.id);
  }
  // Journal d'audit : l'activité des dossiers (ce que « quoi de neuf » et l'historique lisent).
  const audits: Prisma.AuditLogCreateManyInput[] = [
    { actorId: U.amel, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: R[VERITES.produits.nivolumab.ref], summary: "Réserves ANPP enregistrées — 3 points à lever", createdAt: inDays(-16) },
    { actorId: U.raihana, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: R[VERITES.produits.trastuzumab.ref], summary: "Dossier passé en BLOQUÉ — GMP fabricant expiré", createdAt: inDays(-11) },
    { actorId: U.raihana, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: R[VERITES.produits.pembrolizumab.ref], summary: "Relance Julphar pour le CPP légalisé", createdAt: inDays(-10) },
    { actorId: U.amel, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: R[VERITES.produits.lenvatinib.ref], summary: "Réponse aux compléments déposée à l'ANPP", createdAt: inDays(-4) },
    { actorId: U.amel, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: R["REG-2026-9013"], summary: "Dépôt officiel du dossier Trivira", createdAt: inDays(-9) },
  ];
  for (const a of audits) { const row = await prisma.auditLog.create({ data: a, select: { id: true } }); note("auditLog", row.id); }

  // ── Dossiers CTD (Regulatory Intelligence) ───────────────────────────────────────────
  for (const [ref, title, pid] of [
    ["CTD-2026-011", "Dossier CTD Nivolex (Nivolumab) — enregistrement initial", R[VERITES.produits.nivolumab.ref]],
    ["CTD-2026-012", "Dossier CTD Pembrolix (Pembrolizumab) — enregistrement initial", R[VERITES.produits.pembrolizumab.ref]],
    ["CTD-2026-014", "Dossier CTD Lenvatix (Lenvatinib) — réponses aux compléments", R[VERITES.produits.lenvatinib.ref]],
  ] as const) {
    const d = await prisma.regulatoryDossier.create({ data: { reference: ref, title, companyId: adventum.id, productId: pid, createdById: U.amel, status: "IN_REVIEW" }, select: { id: true } });
    note("regulatoryDossier", d.id);
  }

  // ── Tâches ───────────────────────────────────────────────────────────────────────────
  const taches: Prisma.TaskCreateManyInput[] = [
    { title: "Préparer la réponse aux réserves ANPP — Nivolex", assignedToId: U.amel, createdById: U.pdg, dueDate: inDays(6), priority: "CRITICAL", status: "IN_PROGRESS", module: "Regulatory", relatedEntityType: "REGULATORY_PRODUCT", relatedEntityId: R[VERITES.produits.nivolumab.ref] },
    { title: "Relancer Hetero Labs pour le certificat GMP — Trastuzex", assignedToId: U.raihana, createdById: U.amel, dueDate: inDays(-5), priority: "HIGH", status: "TODO", module: "Regulatory", relatedEntityType: "REGULATORY_PRODUCT", relatedEntityId: R[VERITES.produits.trastuzumab.ref] },
    { title: "Obtenir le CPP légalisé de Julphar — Pembrolix", assignedToId: U.raihana, createdById: U.amel, dueDate: inDays(-2), priority: "HIGH", status: "IN_PROGRESS", module: "Regulatory", relatedEntityType: "REGULATORY_PRODUCT", relatedEntityId: R[VERITES.produits.pembrolizumab.ref] },
    { title: "Finaliser l'offre technique et financière — AO PCH 2026/14 oncologie", assignedToId: U.sofiane, createdById: U.pdg, dueDate: inDays(3), priority: "CRITICAL", status: "IN_PROGRESS", module: "PCH" },
    { title: "Clôturer la déclaration G50 d'août", assignedToId: U.khaled, createdById: U.pdg, dueDate: inDays(-1), priority: "HIGH", status: "TODO", module: "Finances" },
    { title: "Renouvellement du contrat de distribution Hetero Labs — préparer l'avenant", assignedToId: U.khaled, createdById: U.pdg, dueDate: inDays(12), priority: "HIGH", status: "TODO", module: "Legal" },
    { title: "Plan de formation 2027 — recueillir les besoins des départements", assignedToId: U.nesrine, createdById: U.pdg, dueDate: inDays(20), priority: "MEDIUM", status: "TODO", module: "RH" },
    { title: "Inventaire tournant du dépôt de Rouiba — chaîne du froid", assignedToId: U.mehdi, createdById: U.pdg, dueDate: inDays(8), priority: "MEDIUM", status: "TODO", module: "Stocks" },
    { title: "Valider le budget marketing T4 — oncologie", assignedToId: U.pdg, createdById: U.sofiane, dueDate: inDays(2), priority: "HIGH", status: "TODO", module: "Budgets" },
    { title: "Signer la convention de sponsoring — congrès SAOM 2026", assignedToId: U.pdg, createdById: U.sofiane, dueDate: inDays(4), priority: "MEDIUM", status: "TODO", module: "Ad & Pro" },
    { title: "Mettre à jour le registre des visites médicales — Alger Centre", assignedToId: U.delegue, createdById: U.sofiane, dueDate: inDays(1), priority: "LOW", status: "TODO", module: "Force de vente" },
  ];
  for (const t of taches) { const row = await prisma.task.create({ data: t, select: { id: true } }); note("task", row.id); }

  // ── Paiements & ordres de dépense ────────────────────────────────────────────────────
  const paiements: Prisma.PaymentRequestCreateManyInput[] = [
    { reference: "PAY-2026-041", title: VERITES.paiements.hikma.titre, amount: VERITES.paiements.hikma.montant, payee: "Hikma Pharmaceuticals", requesterId: U.mehdi, status: "SUBMITTED", dueDate: inDays(4), urgency: "URGENT", companyId: adventum.id, submittedAt: inDays(-8), createdAt: inDays(-9), description: "Facture HK-2026-07-118 — lot antibiotiques injectables, échéance contractuelle à 30 jours." },
    { reference: "PAY-2026-042", title: VERITES.paiements.imprimerie.titre, amount: VERITES.paiements.imprimerie.montant, payee: "Imprimerie El Djazaïr", requesterId: U.amel, status: "SUBMITTED", dueDate: inDays(7), companyId: adventum.id, submittedAt: inDays(-3), createdAt: inDays(-3), description: "Acompte 50 % — maquettes d'étiquetage bilingue exigées par les réserves ANPP." },
    { reference: "PAY-2026-043", title: "Caution provisoire — AO PCH 2026/14", amount: VERITES.pch.caution, payee: "Trésor public — PCH", requesterId: U.sofiane, status: "APPROVED", dueDate: inDays(4), companyId: adventum.id, submittedAt: inDays(-6), decidedAt: inDays(-5), decidedById: U.pdg, createdAt: inDays(-6) },
    { reference: "PAY-2026-044", title: "BV 75 % — frais d'enregistrement ANPP Nivolex", amount: 1_200_000, payee: "ANPP", requesterId: U.amel, status: "SUBMITTED", dueDate: inDays(10), companyId: adventum.id, submittedAt: inDays(-1), createdAt: inDays(-1) },
  ];
  const PAY: Record<string, string> = {};
  for (const p of paiements) { const row = await prisma.paymentRequest.create({ data: p, select: { id: true, reference: true } }); PAY[row.reference] = note("paymentRequest", row.id); }
  const ordres: Prisma.ExpenseOrderCreateManyInput[] = [
    { reference: "OD-2026-118", label: "Règlement facture Hikma — lot 2026-07", beneficiary: "Hikma Pharmaceuticals", amount: VERITES.paiements.hikma.montant, status: "PENDING", centralStatus: "AWAITING", companyId: adventum.id, requestedById: U.mehdi, dueDate: inDays(4), sourceType: "PAYMENT_REQUEST", sourceId: PAY["PAY-2026-041"] },
    { reference: "OD-2026-119", label: "Acompte Imprimerie El Djazaïr — étiquetage Nivolex", beneficiary: "Imprimerie El Djazaïr", amount: VERITES.paiements.imprimerie.montant, status: "PENDING", centralStatus: "AWAITING", companyId: adventum.id, requestedById: U.amel, dueDate: inDays(7), sourceType: "PAYMENT_REQUEST", sourceId: PAY["PAY-2026-042"] },
    { reference: "OD-2026-115", label: "Caution provisoire — AO PCH 2026/14", beneficiary: "Trésor public — PCH", amount: VERITES.pch.caution, status: "PAID", centralStatus: "APPROVED", companyId: adventum.id, requestedById: U.sofiane, paidDate: inDays(-2), centralDecidedById: U.pdg, centralDecidedAt: inDays(-3) },
  ];
  for (const o of ordres) { const row = await prisma.expenseOrder.create({ data: o, select: { id: true } }); note("expenseOrder", row.id); }
  // Une validation où c'est le TOUR du PDG (alimente « ce qui attend une décision »).
  const val = await prisma.validationRequest.create({
    data: {
      reference: "VAL-2026-207", module: "Finances", title: "Validation — règlement facture Hikma (2 450 000 DZD)", requesterId: U.mehdi,
      entityType: "PAYMENT_REQUEST", entityId: PAY["PAY-2026-041"], createdAt: inDays(-8), currentOrder: 2, amount: VERITES.paiements.hikma.montant,
      steps: { create: [{ order: 1, validatorId: U.khaled, status: "APPROVED", decidedAt: inDays(-6) }, { order: 2, validatorId: U.pdg, status: "PENDING" }] },
    }, select: { id: true },
  });
  note("validationRequest", val.id);

  // ── Legal : contrats, chaîne devis → BC → facture ────────────────────────────────────
  const legal = async (d: Prisma.LegalDocumentUncheckedCreateInput) => { const row = await prisma.legalDocument.create({ data: d, select: { id: true } }); return note("legalDocument", row.id); };
  await legal({ reference: "CTR-2024-07", title: VERITES.contratHetero.titre, kind: "CONTRACT", counterparty: "Hetero Labs Ltd", status: "ACTIVE", amount: VERITES.contratHetero.montant, companyId: adventum.id, createdById: U.khaled,
    startDate: new Date("2024-10-01T00:00:00Z"), endDate: new Date("2026-09-30T00:00:00Z"), signedAt: new Date("2024-09-18T00:00:00Z"),
    notes: "Exclusivité Algérie sur Nivolex, Lenvatix, Trastuzex. Durée 24 mois, renouvellement par avenant — préavis 90 jours. Redevance 4 % du CA net." });
  await legal({ reference: "NDA-2026-03", title: "Accord de confidentialité — Julphar", kind: "NDA", counterparty: "Julphar Gulf Pharmaceutical Industries", status: "ACTIVE", companyId: adventum.id, createdById: U.khaled, startDate: inDays(-200), endDate: inDays(530) });
  const devis = await legal({ reference: "DEV-2026-0455", title: "Devis n° D-2026-0455 — Imprimerie El Djazaïr (étiquetage Nivolex)", kind: "QUOTE", counterparty: "Imprimerie El Djazaïr", status: "ACTIVE", amount: 760_000, companyId: adventum.id, createdById: U.amel, startDate: inDays(-20) });
  const bc = await legal({ reference: "BC-2026-0231", title: "Bon de commande n° BC-2026-0231 — Imprimerie El Djazaïr", kind: "PURCHASE_ORDER", counterparty: "Imprimerie El Djazaïr", status: "ACTIVE", amount: 760_000, companyId: adventum.id, createdById: U.khaled, chainFromId: devis, startDate: inDays(-15) });
  await legal({ reference: "FAC-2026-0891", title: VERITES.factureImprimerie.titre, kind: "INVOICE", counterparty: "Imprimerie El Djazaïr", status: "ACTIVE", amount: VERITES.factureImprimerie.montant, companyId: adventum.id, createdById: U.khaled, chainFromId: bc, startDate: inDays(-4), direction: "IN" });
  await legal({ reference: "ASS-2026-01", title: "Police d'assurance flotte automobile 2026 — SAA", kind: "INSURANCE", counterparty: "SAA Assurances", status: "ACTIVE", amount: 1_850_000, companyId: adventum.id, createdById: U.khaled, startDate: inDays(-300), endDate: inDays(60) });
  await legal({ reference: "CTR-2025-12", title: "Contrat de prestation logistique — Rouiba Frigo", kind: "CONTRACT", counterparty: "Rouiba Frigo SARL", status: "ACTIVE", amount: 9_600_000, companyId: adventum.id, createdById: U.mehdi, startDate: inDays(-250), endDate: inDays(115) });

  // ── Courriers (registre) ─────────────────────────────────────────────────────────────
  const partner = async (name: string, kind: string) => { const row = await prisma.mailPartner.create({ data: { name, kind }, select: { id: true } }); return note("mailPartner", row.id); };
  const pANPP = await partner("ANPP — Agence Nationale des Produits Pharmaceutiques", "Autorité");
  const pPCH = await partner("PCH — Pharmacie Centrale des Hôpitaux", "Client institutionnel");
  const pHetero = await partner("Hetero Labs Ltd", "Partenaire");
  const courriers: Prisma.MailEntryUncheckedCreateInput[] = [
    { reference: "CA-2026-0212", title: "Notification de réserves — dossier Nivolex (Nivolumab) — ANPP/DE/2026-1147", direction: "INCOMING", partnerId: pANPP, receivedAt: inDays(-16), departmentId: dREG, concernedUserId: U.amel, createdById: U.raihana, companyId: adventum.id, notes: "Trois réserves : bioéquivalence, étiquetage bilingue, CPP légalisé. Délai de réponse : 30 jours." },
    { reference: "CA-2026-0218", title: "Convocation à l'ouverture des plis — AO PCH 2026/14 oncologie", direction: "INCOMING", partnerId: pPCH, receivedAt: inDays(-6), departmentId: dVENTES, concernedUserId: U.sofiane, createdById: U.nesrine, companyId: adventum.id },
    { reference: "CA-2026-0205", title: "Demande de compléments — dossier Lenvatix (stabilité zone IVb)", direction: "INCOMING", partnerId: pANPP, receivedAt: inDays(-31), departmentId: dREG, concernedUserId: U.amel, createdById: U.raihana, companyId: adventum.id },
    { reference: "CD-2026-0147", title: "Réponse aux compléments ANPP — dossier Lenvatix", direction: "OUTGOING", partnerId: pANPP, sentAt: inDays(-4), departmentId: dREG, concernedUserId: U.amel, createdById: U.raihana, companyId: adventum.id },
    { reference: "CD-2026-0149", title: "Relance certificat GMP Hetero Biopharma — Trastuzex", direction: "OUTGOING", partnerId: pHetero, sentAt: inDays(-11), departmentId: dREG, concernedUserId: U.raihana, createdById: U.raihana, companyId: adventum.id },
  ];
  for (const c of courriers) { const row = await prisma.mailEntry.create({ data: c, select: { id: true } }); note("mailEntry", row.id); }

  // ── Marchés PCH ──────────────────────────────────────────────────────────────────────
  const marches: Prisma.PchTenderUncheckedCreateInput[] = [
    { reference: VERITES.pch.ref, title: VERITES.pch.titre, products: "Nivolumab 10 mg/ml, Pembrolizumab 100 mg, Trastuzumab 440 mg", supplier: "Hetero Labs / Julphar", supplierCountry: "Inde / EAU", quantity: 12_000, value: 180_000_000, status: "IN_PROGRESS", publishedAt: inDays(-25), submissionDeadline: inDays(VERITES.pch.echeanceJours), responsibleId: U.sofiane, companyId: adventum.id, cautionAmount: VERITES.pch.caution, cautionDeposited: false, createdById: U.sofiane,
      notes: "Caution provisoire (5 000 000 DZD) accordée au centre de paiement mais pas encore déposée au Trésor ; offre technique en attente du CPP Pembrolix (pièce exigée au lot 2)." },
    { reference: "AO 2026/09", title: "Appel d'offres PCH 2026/09 — antirétroviraux", products: "Bictegravir/Emtricitabine/TAF", supplier: "Cipla", supplierCountry: "Inde", quantity: 40_000, value: 96_000_000, status: "COMPLETED", publishedAt: inDays(-120), submissionDeadline: inDays(-80), submittedAt: inDays(-82), awardDate: inDays(-40), responsibleId: U.sofiane, companyId: adventum.id, cautionAmount: 2_000_000, cautionDeposited: true, createdById: U.sofiane },
    { reference: "AO 2026/03", title: "Appel d'offres PCH 2026/03 — cardiologie", products: "Bisoprolol, Ramipril", supplier: "Julphar", supplierCountry: "EAU", quantity: 200_000, value: 54_000_000, status: "LOST", publishedAt: inDays(-220), submissionDeadline: inDays(-190), submittedAt: inDays(-192), responsibleId: U.sofiane, companyId: adventum.id, createdById: U.sofiane, notes: "Perdu sur le prix (offre 6 % au-dessus du moins-disant)." },
  ];
  for (const m of marches) { const row = await prisma.pchTender.create({ data: m, select: { id: true } }); note("pchTender", row.id); }

  // ── Drive : dossiers, fichiers, contenu indexé (la matière de find_documents / read_document) ──
  const { putBlob } = await import("@/lib/drive-storage");
  const { indexDriveNodeText } = await import("@/lib/assistant/document-discovery");
  const dossierNode = async (name: string, parentId?: string) => {
    const n = await prisma.driveNode.create({ data: { name, type: "FOLDER", ownerId: U.pdg, parentId: parentId ?? null, createdById: U.pdg }, select: { id: true } });
    return note("driveNode", n.id);
  };
  const racine = await dossierNode("Direction");
  const fReg = await dossierNode("Regulatory", racine);
  const fLegal = await dossierNode("Contrats", racine);
  const fComites = await dossierNode("Comités de direction", racine);
  const fMarches = await dossierNode("Marchés publics", racine);
  const fichier = async (name: string, parentId: string, mimeType: string, text: string) => {
    const bytes = Buffer.from(text, "utf8");
    const blob = await putBlob(bytes);
    note("fileBlob", blob.blobId);
    const n = await prisma.driveNode.create({ data: { name, type: "FILE", ownerId: U.pdg, parentId, mimeType, size: bytes.length, createdById: U.pdg }, select: { id: true } });
    note("driveNode", n.id);
    const v = await prisma.fileVersion.create({ data: { nodeId: n.id, blobId: blob.blobId, version: 1, size: bytes.length, mimeType, createdById: U.pdg }, select: { id: true } });
    note("fileVersion", v.id);
    await indexDriveNodeText(n.id, v.id, text, null, name);
    const idx = await prisma.driveTextIndex.findUnique({ where: { nodeId: n.id }, select: { id: true } });
    if (idx) note("driveTextIndex", idx.id);
    return n.id;
  };
  const R2 = VERITES.reserves;
  await fichier("Réserves ANPP Nivolex 2026-08-20.txt", fReg, "text/plain",
`RÉPUBLIQUE ALGÉRIENNE DÉMOCRATIQUE ET POPULAIRE
Agence Nationale des Produits Pharmaceutiques — Direction de l'Enregistrement
Réf. ANPP/DE/2026-1147 — Alger, le 20 août 2026

Objet : Notification de réserves — demande d'enregistrement NIVOLEX (Nivolumab) 10 mg/ml, solution à diluer pour perfusion — Adventum Pharma / Hetero Labs Ltd.

Après évaluation technico-réglementaire du dossier déposé le 10 juin 2026 (recevabilité notifiée le 2 juillet 2026), la commission formule les réserves suivantes :
1. ${R2[0]} ;
2. ${R2[1]} ;
3. ${R2[2]}.

Le laboratoire dispose d'un délai de trente (30) jours à compter de la présente pour déposer ses réponses. À défaut, la demande sera classée sans suite.

Le Directeur de l'Enregistrement`);
  await fichier("PV comité de direction 2026-08-28.txt", fComites, "text/plain",
`ADVENTUM PHARMA — PROCÈS-VERBAL DU COMITÉ DE DIRECTION
Date : jeudi 28 août 2026, 9 h 00 — Présents : Yacine Benali (PDG), Amel Haddad, Khaled Mansouri, Sofiane Kaci, Nesrine Boudiaf, Mehdi Larbi.

1. Regulatory — Nivolex : réserves ANPP reçues le 20/08 (bioéquivalence, étiquetage, CPP). ${VERITES.pv.promesseAmel}. Raihana Cherif coordonne l'imprimerie pour les maquettes.
2. Regulatory — Trastuzex : dossier bloqué, GMP fabricant expiré. Décision : relance officielle de Hetero Labs, escalade au PDG si aucune réponse au 15 septembre.
3. Finances : ${VERITES.pv.promesseKhaled}, sous réserve de l'accord du centre de paiement. Trésorerie : 38,4 MDZD disponibles, échéance BV 75 % Nivolex à prévoir (1,2 MDZD).
4. Marchés publics : ${VERITES.pv.promesseSofiane} ; caution provisoire de 5 MDZD à déposer au Trésor avant l'ouverture des plis.
5. RH : plan de formation 2027 — recueil des besoins par Nesrine Boudiaf avant fin septembre.
6. Supply chain : inventaire chaîne du froid Rouiba planifié semaine 37 (Mehdi Larbi).

Décisions : (D1) réponse ANPP Nivolex avant le 12/09 ; (D2) avenant Hetero à préparer avant l'échéance du contrat le 30/09/2026 ; (D3) budget marketing T4 oncologie à valider par le PDG cette semaine.
Prochain comité : jeudi 4 septembre 2026, 9 h 00.`);
  await fichier("Contrat distribution Hetero Labs 2024.txt", fLegal, "text/plain",
`CONTRAT DE DISTRIBUTION EXCLUSIVE
Entre HETERO LABS LIMITED (Hyderabad, Inde) et ADVENTUM PHARMA SPA (Alger, Algérie)

Article 2 — Produits : Nivolumab 10 mg/ml (Nivolex), Lenvatinib 4 mg et 10 mg (Lenvatix), Trastuzumab 440 mg (Trastuzex).
Article 3 — Territoire : République algérienne démocratique et populaire, à titre exclusif.
Article 5 — Durée : le présent contrat prend effet le 1er octobre 2024 pour une durée de vingt-quatre (24) mois, soit jusqu'au 30 septembre 2026. Il ne se renouvelle pas tacitement : toute prolongation fait l'objet d'un avenant signé au plus tard quatre-vingt-dix (90) jours avant l'échéance.
Article 7 — Redevance : 4 % du chiffre d'affaires net trimestriel, payable à 45 jours.
Article 9 — Obligations réglementaires : Hetero Labs fournit sous 15 jours ouvrés tout document exigé par l'ANPP, y compris les certificats GMP en cours de validité.
Article 12 — Droit applicable : droit algérien ; tribunal de commerce d'Alger.
Montant estimé du contrat : 42 000 000 DZD sur la durée.
Fait à Alger, le 18 septembre 2024.`);
  await fichier("Étude marché oncologie Algérie 2026.txt", fMarches, "text/plain",
`ÉTUDE DE MARCHÉ — ONCOLOGIE ALGÉRIE 2026 (synthèse interne, Direction commerciale)
Marché hospitalier des anticorps monoclonaux et immunothérapies : 14,2 milliards DZD en 2025 (+11 % vs 2024), dont 71 % via la PCH.
Nivolumab : demande PCH estimée 9 800 flacons/an ; deux concurrents enregistrés (Bristol Myers Squibb — princeps ; Zydus — biosimilaire déposé). Prix de référence PCH : 96 500 DZD le flacon.
Pembrolizumab : 6 400 flacons/an ; princeps MSD seul enregistré. Fenêtre favorable si dépôt avant fin 2026.
Trastuzumab : marché mature, 5 biosimilaires enregistrés ; pression prix forte (−18 % en deux ans).
Recommandation : prioriser Nivolex et Pembrolix ; conditionner l'investissement Trastuzex à un prix cible sous 38 000 DZD.`);
  await fichier("Offre PCH AO 2026-14 — brouillon.txt", fMarches, "text/plain",
`OFFRE TECHNIQUE ET FINANCIÈRE — AO PCH 2026/14 (oncologie) — BROUILLON v3 du 3 septembre 2026
Lot 1 — Nivolumab 10 mg/ml : 6 000 flacons, prix unitaire proposé 89 900 DZD (référence PCH 96 500).
Lot 2 — Pembrolizumab 100 mg : 4 000 flacons — PIÈCE MANQUANTE : CPP légalisé (attendu de Julphar).
Lot 3 — Trastuzumab 440 mg : 2 000 flacons — sous réserve du GMP Hetero renouvelé.
Caution provisoire : 5 000 000 DZD (quittance du Trésor à joindre).
Date limite de dépôt : ${inDays(VERITES.pch.echeanceJours).toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" })} à 10 h 00, siège de la PCH, Alger.`);

  // ── Agenda ───────────────────────────────────────────────────────────────────────────
  const ev = async (d: Prisma.CalendarEventUncheckedCreateInput, invites: string[]) => {
    const row = await prisma.calendarEvent.create({ data: { ...d, invitees: { create: invites.map((userId) => ({ userId, status: "ACCEPTED" })) } }, select: { id: true } });
    return note("calendarEvent", row.id);
  };
  await ev({ title: VERITES.comite.titre, kind: "MEETING", startAt: at(1, 9), endAt: at(1, 10), location: "Salle du conseil", organizerId: U.pdg, createdById: U.pdg, description: "Ordre du jour : réponse ANPP Nivolex, avenant Hetero, offre PCH 2026/14, budget T4." }, [U.amel, U.khaled, U.sofiane, U.nesrine, U.mehdi]);
  await ev({ title: "Point ANPP — réserves Nivolex", kind: "APPOINTMENT", startAt: at(3, 11), endAt: at(3, 12), location: "ANPP, Alger", organizerId: U.amel, createdById: U.amel }, [U.pdg, U.raihana]);
  await ev({ title: "Ouverture des plis — AO PCH 2026/14", kind: "DEADLINE", startAt: at(VERITES.pch.echeanceJours, 10), endAt: at(VERITES.pch.echeanceJours, 12), location: "Siège PCH", organizerId: U.sofiane, createdById: U.sofiane }, [U.pdg]);
  await ev({ title: "Entretien annuel — Raihana Cherif", kind: "MEETING", startAt: at(6, 14), endAt: at(6, 15), organizerId: U.amel, createdById: U.amel }, [U.raihana]);

  flush();
  const total = Object.values(ids).reduce((s, l) => s + l.length, 0);
  console.log(`Jeu du banc semé : ${total} lignes (${Object.entries(ids).map(([k, v]) => `${k} ${v.length}`).join(", ")}).`);
  console.log(`PDG : ${VERITES.pdg.email} / ${BENCH_PASSWORD} — déléguée : ${VERITES.delegue.email}`);
}

async function main(): Promise<void> {
  garde();
  const clean = process.argv.includes("--clean");
  const reset = process.argv.includes("--reset");
  if (reset) {
    // Rien à retirer ensuite : la base est vide. Enchaîner les purges ferait tourner vingt
    // requêtes sur des tables qu'on vient de vider.
    await reinitialiser();
    if (!clean) await semer();
    return;
  }
  // DEUX RETRAITS, ET IL EN FAUT DEUX. Le manifeste est PRÉCIS (il connaît les lignes créées
  // sous des sociétés préexistantes, qu'aucune requête d'identité ne retrouverait) ; le retrait
  // par IDENTITÉ est DURABLE (il survit à la perte de `bench-out/`, ce que le manifeste ne fait
  // pas). Garder l'un sans l'autre laisse soit des orphelins, soit un semis injouable.
  const existant = lireManifest();
  if (existant) {
    console.log(`Jeu précédent (${existant.createdAt}) : retrait par identifiants…`);
    await nettoyer(existant);
  }
  await retirerParIdentite();
  if (!clean) await semer();
}

// N'agit que lancé DIRECTEMENT : le banc importe `VERITES` d'ici sans rien semer ni retirer.
const lanceDirectement = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("scripts/bench/seed-adam-bench.ts");
if (lanceDirectement) {
  main()
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
