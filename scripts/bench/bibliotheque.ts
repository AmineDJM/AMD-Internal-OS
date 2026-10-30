/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BANC DE LA BIBLIOTHÈQUE (J1) — 2 000 pièces semées localement, 30 requêtes « par le contenu ».
 *
 * Mesure, sur une base LOCALE (jamais une base distante) :
 *   • la LATENCE de `chercherDocuments` (p50 / p95, cible < 300 ms), plein chemin : droits compris ;
 *   • le RAPPEL : la pièce visée (son titre ne dit rien de son contenu) est-elle dans les 10 premiers ?
 *   • ZÉRO RÉSULTAT HORS DROITS : chaque résultat rendu à une personne restreinte est revérifié par la règle
 *     d'ouverture du Drive (`resolveDriveAccess`), indépendamment de la recherche.
 *
 * Les pièces entrent par la VRAIE porte (`putBlob` + `enregistrerFichierDrive`, qui inscrit), sont lues par la
 * vraie ingestion (lecteur texte réel). L'embedder est le faux déterministe (aucun réseau) — sauf `--vivant` :
 * text-embedding-3-small par le mandataire (`npm run bench:live -- scripts/bench/bibliotheque.ts --vivant`).
 *
 *   npm run bench:bibliotheque                    (base `amd_bench` locale, faux embedder)
 *   npm run bench:bibliotheque -- --sans-vecteur  force le repli plein texte + trigrammes
 *   npm run bench:bibliotheque -- --nettoyer      retire le corpus semé
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { canViewDrive, resolveDriveAccess } from "@/lib/drive";
import {
  capacites, chercherDocuments, embedderDeterministe, embedderParDefaut, oublierCapacites, traiterFile, vectoriserEnRetard,
  type Capacites, type Embedder,
} from "@/modules/bibliotheque/api";

const TAG = "__banc_bibliotheque__";
const N = 2_000;
const args = new Set(process.argv.slice(2));

// ── Un hasard REPRODUCTIBLE (le même corpus à chaque passage) ─────────────────────────────────
let graine = 20261029;
const hasard = () => ((graine = (graine * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const parmi = <T,>(xs: readonly T[]) => xs[Math.floor(hasard() * xs.length)];

const SUJETS = [
  "la tournée des délégués dans les officines de la wilaya", "le budget marketing du trimestre", "la formation des visiteurs médicaux",
  "le suivi des commandes de la pharmacie centrale", "la réunion de coordination commerciale", "le plan de communication du lancement",
  "le dossier d'enregistrement auprès de l'agence", "la gestion des échantillons médicaux", "le calendrier des congrès", "les notes de frais du mois",
];
const VERBES = ["précise", "rappelle", "détaille", "récapitule", "confirme", "propose", "consigne"];
const COMPLEMENTS = [
  "les responsabilités de chacun", "les échéances à tenir", "les montants engagés", "les points restés ouverts", "les décisions prises",
  "les pièces à fournir", "la répartition par région", "les risques identifiés", "les indicateurs suivis",
];

/** Les 30 pièces VISÉES : un fait distinctif, un titre qui n'en dit rien, et la requête qui doit la retrouver. */
const CIBLES: { fait: string; requete: string }[] = [
  ["La chambre froide numéro 7 de l'entrepôt de Blida est réglée entre deux et huit degrés, alarme testée chaque lundi.", "réglage chambre froide Blida"],
  ["Le contrat de transport frigorifique avec la société Tassili Froid couvre Alger, Oran et Constantine jusqu'en 2028.", "contrat transport frigorifique Tassili"],
  ["Le lot ZX-77 de l'amoxicilline fait l'objet d'un rappel volontaire après un défaut d'étiquetage.", "rappel lot ZX-77 amoxicilline"],
  ["La durée de conservation du sirop pédiatrique passe à vingt-quatre mois après la nouvelle étude de stabilité.", "durée de conservation sirop pédiatrique stabilité"],
  ["Le séminaire de pharmacovigilance aura lieu à Tlemcen avec quarante pharmaciens hospitaliers.", "séminaire pharmacovigilance Tlemcen"],
  ["La convention de stage avec l'université de Batna accueille six étudiants en pharmacie industrielle.", "convention de stage université Batna"],
  ["Le fournisseur de cartons Emballages Sahel augmente ses prix de neuf pour cent au premier janvier.", "hausse prix cartons Emballages Sahel"],
  ["L'audit de l'entrepôt d'Annaba relève trois écarts sur la traçabilité des retours.", "audit entrepôt Annaba traçabilité retours"],
  ["La flotte de véhicules des délégués passe à la géolocalisation pour réduire le kilométrage déclaré.", "géolocalisation flotte véhicules délégués"],
  ["Le nouveau protocole d'hygiène impose le nettoyage des paillasses du laboratoire toutes les quatre heures.", "protocole hygiène nettoyage paillasses laboratoire"],
  ["La campagne de vaccination antigrippale du personnel se tiendra au siège la deuxième semaine de novembre.", "campagne vaccination antigrippale personnel"],
  ["Le tableau des astreintes de la pharmacienne responsable couvre les week-ends de décembre.", "astreintes pharmacienne responsable décembre"],
  ["L'appel d'offres de la PCH pour l'insuline glargine fixe la remise des plis au quinze du mois.", "appel d'offres PCH insuline glargine"],
  ["La salle blanche de conditionnement a obtenu sa requalification ISO 8 sans réserve.", "requalification salle blanche ISO 8"],
  ["Le stand du congrès de cardiologie d'Oran mesure dix-huit mètres carrés, angle ouvert.", "stand congrès cardiologie Oran"],
  ["La procédure de destruction des périmés exige un procès-verbal signé par huissier.", "destruction des périmés procès-verbal huissier"],
  ["Le logiciel de paie sera migré pendant le pont de mai, sans interruption des virements.", "migration logiciel de paie mai"],
  ["Le partenariat avec le laboratoire Medilab prévoit la fabrication à façon de comprimés effervescents.", "fabrication à façon comprimés effervescents Medilab"],
  ["La réclamation du centre hospitalier de Sétif porte sur des ampoules fêlées à la livraison.", "réclamation Sétif ampoules fêlées"],
  ["Le plan de continuité prévoit un groupe électrogène de deux cents kilovoltampères pour l'entrepôt.", "groupe électrogène plan de continuité entrepôt"],
  ["La charte graphique interdit le logo sur fond rouge et impose la typographie Montserrat.", "charte graphique logo typographie Montserrat"],
  ["Le séquençage des visites médicales privilégie les pneumologues en période hivernale.", "visites pneumologues période hivernale"],
  ["Le registre des stupéfiants doit être contresigné chaque soir par le pharmacien de garde.", "registre stupéfiants contresigné pharmacien"],
  ["La douane de Skikda retient deux palettes faute de certificat d'origine.", "douane Skikda palettes certificat d'origine"],
  ["La prime de fin d'année des délégués dépend du taux de couverture des médecins cibles.", "prime fin d'année taux de couverture médecins"],
  ["Le contrôle des températures de transport utilise des enregistreurs à usage unique.", "enregistreurs de température usage unique transport"],
  ["Le webinaire sur le diabète de type deux a réuni trois cents médecins généralistes.", "webinaire diabète type deux généralistes"],
  ["La location des bureaux de Hydra est renouvelée pour trois ans avec révision annuelle.", "bail bureaux Hydra renouvellement"],
  ["L'étude de bioéquivalence du générique de la metformine est confiée au centre de Bordj.", "bioéquivalence générique metformine"],
  ["La messagerie interne remplace les groupes WhatsApp pour les échanges sur les dossiers patients.", "messagerie interne remplace WhatsApp"],
].map(([fait, requete]) => ({ fait, requete }));

function texteDeRemplissage(i: number): string {
  const n = 6 + Math.floor(hasard() * 10);
  const phrases = Array.from({ length: n }, () => `Ce document ${parmi(VERBES)} ${parmi(COMPLEMENTS)} pour ${parmi(SUJETS)}.`);
  return `Référence interne ${i}. ${phrases.join(" ")}`;
}

async function compte(nom: string, role: "MEDICAL_DELEGATE" | "VIEWER"): Promise<SessionUser> {
  const email = `${TAG}${nom}@banc.dz`;
  const u = (await prisma.user.findUnique({ where: { email } })) ?? (await prisma.user.create({ data: { name: `${TAG}${nom}`, email, passwordHash: "x", role } }));
  const access = await getAccess(u.id, u.role);
  return { id: u.id, role: u.role, secondaryRole: access.secondaryRole, access };
}

interface Corpus { a: SessionUser; b: SessionUser; c: SessionUser; cibles: { nodeId: string; requete: string }[] }

async function semer(embed: Embedder): Promise<Corpus> {
  const a = await compte("alpha", "MEDICAL_DELEGATE");
  const b = await compte("beta", "MEDICAL_DELEGATE");
  const c = await compte("gamma", "VIEWER");
  const deja = await prisma.driveNode.count({ where: { name: { startsWith: TAG }, type: "FILE" } });
  const t0 = Date.now();
  if (deja < N) {
    console.log(`Semis de ${N - deja} pièces…`);
    for (let i = deja; i < N; i++) {
      // 0..29 : les cibles, chez alpha ; puis 70 % alpha, 25 % beta, 5 % gamma.
      const cible = i < CIBLES.length ? CIBLES[i] : null;
      const proprio = cible ? a : i % 20 === 0 ? c : i % 4 === 0 ? b : a;
      const texte = cible ? `${texteDeRemplissage(i)} ${cible.fait} ${texteDeRemplissage(i + 1)}` : texteDeRemplissage(i);
      const e = await putBlob(Buffer.from(texte, "utf8"));
      const n = await enregistrerFichierDrive(proprio, { parentId: null }, { blobId: e.blobId, size: e.size, mimeType: "text/plain", name: `${TAG}Note ${String(i).padStart(4, "0")}.txt`, sha256: e.sha256 });
      // gamma voit 40 pièces d'alpha (partagées), dont aucune cible : ses résultats doivent rester DANS ce périmètre.
      if (proprio === a && !cible && i % 35 === 0) await prisma.driveShare.createMany({ data: [{ nodeId: n.id, userId: c.id, access: "VIEW" }], skipDuplicates: true });
      if (i % 250 === 0) console.log(`  ${i}/${N}`);
    }
  }
  console.log(`Semis : ${((Date.now() - t0) / 1000).toFixed(1)} s. Lecture…`);
  const t1 = Date.now();
  const mesPieces = (await prisma.bibliothequeFiche.findMany({ where: { titre: { contains: "banc bibliotheque" } }, select: { pieceId: true } })).map((p) => p.pieceId);
  for (;;) {
    const r = await traiterFile({ max: 100, seulement: mesPieces, deps: { embed } });
    if (r.prises === 0) break;
  }
  // Les vecteurs se refont à chaque passage : le faux embedder et le vrai ne se mélangent pas.
  await prisma.$executeRawUnsafe(`UPDATE "BibliothequePassage" SET "vectoriseLe" = NULL${(await capacites()).vecteur ? `, "vecteur" = NULL` : ""} WHERE "pieceId" = ANY($1::text[])`, mesPieces);
  while ((await vectoriserEnRetard({ max: 500, embed, seulement: mesPieces })) > 0) { /* lots de 500 */ }
  console.log(`Lecture et vecteurs : ${((Date.now() - t1) / 1000).toFixed(1)} s pour ${mesPieces.length} pièces.`);
  const nodes = await prisma.driveNode.findMany({
    where: { name: { in: CIBLES.map((_, i) => `${TAG}Note ${String(i).padStart(4, "0")}.txt`) } }, select: { id: true, name: true },
  });
  const parNom = new Map(nodes.map((n) => [n.name, n.id]));
  return { a, b, c, cibles: CIBLES.map((x, i) => ({ nodeId: parNom.get(`${TAG}Note ${String(i).padStart(4, "0")}.txt`)!, requete: x.requete })) };
}

function centile(xs: number[], p: number): number {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function mesurer(k: Corpus, embed: Embedder, cap: Capacites) {
  const latences: number[] = [];
  const froides: number[] = [];
  let avecSens = 0;
  let trouvees = 0;
  const manquees: string[] = [];
  // Chauffe (plans de requête, cache des capacités).
  await chercherDocuments(k.a, "chauffe", {}, { embed, capacites: cap });
  for (let tour = 0; tour < 3; tour++) {
    for (const x of k.cibles) {
      const t = performance.now();
      const r = await chercherDocuments(k.a, x.requete, {}, { embed, capacites: cap, limite: 10 });
      latences.push(performance.now() - t);
      if (tour === 0) {
        froides.push(performance.now() - t);
        if (r.mode.vecteurUtilise) avecSens += 1;
        if (r.resultats.some((y) => y.endroit.cle === `DRIVE_NODE:${x.nodeId}`)) trouvees += 1;
        else manquees.push(x.requete);
      }
    }
  }
  // Zéro hors droits : gamma (lecteur, 100 pièces à lui + 40 partagées) cherche les 30 requêtes.
  let horsDroits = 0;
  let rendus = 0;
  for (const x of k.cibles) {
    const r = await chercherDocuments(k.c, x.requete, {}, { embed, capacites: cap, limite: 20 });
    for (const y of r.resultats) {
      rendus += 1;
      const id = y.endroit.cle.replace(/^DRIVE_NODE:/, "");
      if (!y.endroit.cle.startsWith("DRIVE_NODE:") || !canViewDrive(await resolveDriveAccess(k.c, id))) horsDroits += 1;
    }
  }
  return {
    p50: centile(latences, 50), p95: centile(latences, 95), p95Froid: centile(froides, 95), avecSens,
    rappel: trouvees / k.cibles.length, manquees, horsDroits, rendus,
  };
}

async function nettoyer() {
  const fiches = await prisma.bibliothequeFiche.findMany({ where: { titre: { contains: "banc bibliotheque" } }, select: { pieceId: true } });
  await prisma.bibliothequeFiche.deleteMany({ where: { pieceId: { in: fiches.map((f) => f.pieceId) } } });
  await prisma.piece.deleteMany({ where: { id: { in: fiches.map((f) => f.pieceId) } } });
  await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  console.log(`Corpus retiré (${fiches.length} fiches).`);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error("Banc LOCAL seulement : DATABASE_URL doit viser localhost.");
  if (args.has("--nettoyer")) { await nettoyer(); return; }
  const vivant = args.has("--vivant");
  const embed: Embedder = vivant ? embedderParDefaut : embedderDeterministe();
  oublierCapacites();
  const base = await capacites();
  const cap: Capacites = args.has("--sans-vecteur") ? { ...base, vecteur: false } : base;
  console.log(`Base : vecteur ${base.vecteur ? "oui" : "non"}, trigrammes ${base.trigrammes ? "oui" : "non"} — banc ${cap.vecteur ? "hybride" : "SANS vecteur"}, embedder ${vivant ? "OpenAI (vivant)" : "déterministe"}.`);
  const k = await semer(embed);
  const m = await mesurer(k, embed, cap);
  const total = await prisma.bibliothequeFiche.count({ where: { titre: { contains: "banc bibliotheque" } } });
  console.log("");
  console.log(`Corpus : ${total} pièces lues · 30 requêtes × 3 tours`);
  console.log(`Latence : p50 ${m.p50.toFixed(0)} ms · p95 ${m.p95.toFixed(0)} ms (cible < 300 ms) ${m.p95 < 300 ? "✓" : "✗"} — premier passage de chaque requête : p95 ${m.p95Froid.toFixed(0)} ms, sens utilisé ${m.avecSens}/30`);
  console.log(`Rappel@10 : ${(m.rappel * 100).toFixed(0)} % ${m.manquees.length ? `(manquées : ${m.manquees.join(" ; ")})` : ""}`);
  console.log(`Hors droits : ${m.horsDroits} sur ${m.rendus} résultats rendus à « gamma » ${m.horsDroits === 0 ? "✓" : "✗"}`);
  if (m.horsDroits > 0 || m.p95 >= 300) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
