/**
 * L'INVENTAIRE DES DOUBLONS DE PERSONNES ET D'ORGANISATIONS — en LECTURE SEULE (refonte des données, palier P2,
 * `docs/architecture/refonte-donnees-et-monolithe-modulaire.md` §3 R1-R2).
 *
 * Combien de personnes et d'organisations RÉELLES derrière les lignes de onze tables ? Le script lit les fiches,
 * les passe au moteur pur `src/lib/referentiels/doublons.ts` et imprime, par famille :
 *   • le nombre de lignes, puis l'estimation des choses réelles — BASSE en suivant CERTAIN + PROBABLE, LARGE
 *     en suivant aussi POSSIBLE (union des paires : une estimation, jamais une fusion) ;
 *   • les propositions par niveau, par couple de tables, et les meilleurs exemples avec leurs raisons.
 *
 * Il ne fusionne rien et n'écrit rien. LA LECTURE SEULE EST TENUE PAR LA BASE : une seule connexion, mise en
 * `default_transaction_read_only` avant la première requête (même garde que `recenser-doublons-factures.ts`).
 *
 *   npx tsx scripts/refonte/inventaire-doublons.ts            — le rapport lisible
 *   npx tsx scripts/refonte/inventaire-doublons.ts --json     — le même, en JSON
 *   … -- --exemples 20                                        — combien d'exemples par niveau (défaut 8)
 */

import type { FicheOrganisation, FichePersonne, NiveauDoublon, PropositionDoublon, ResultatLot } from "@/lib/referentiels/doublons";

function urlUneConnexion(brute: string | undefined): string {
  if (!brute) throw new Error("DATABASE_URL absente.");
  const u = new URL(brute);
  u.searchParams.set("connection_limit", "1");
  return u.toString();
}

const tableDe = (ref: string) => ref.split(":")[0];
const NIVEAUX: NiveauDoublon[] = ["CERTAIN", "PROBABLE", "POSSIBLE"];

interface Bilan {
  famille: string;
  lignes: number;
  parTable: Record<string, number>;
  estimationBasse: number;
  estimationLarge: number;
  comparaisons: number;
  parNiveau: Record<NiveauDoublon, number>;
  parCouple: Record<string, Record<NiveauDoublon, number>>;
  blocsIgnores: { cle: string; taille: number }[];
  plusGrosGroupes: { taille: number; fiches: string[] }[];
  exemples: Record<NiveauDoublon, { a: string; b: string; score: number; raisons: string[]; reserves: string[] }[]>;
}

async function main() {
  process.env.DATABASE_URL = urlUneConnexion(process.env.DATABASE_URL);
  const { prisma } = await import("@/lib/prisma");
  await prisma.$executeRawUnsafe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  const lectureSeule = await prisma.$queryRawUnsafe<{ transaction_read_only: string }[]>("SHOW transaction_read_only");
  if (lectureSeule[0]?.transaction_read_only !== "on") throw new Error("La session n'est pas en lecture seule : arrêt.");

  const { proposerDoublonsOrganisations, proposerDoublonsPersonnes, regrouper } = await import("@/lib/referentiels/doublons");
  const { nomComplet } = await import("@/lib/referentiels/normalisation");
  const iExemples = process.argv.indexOf("--exemples");
  const nExemples = iExemples > 0 ? Number(process.argv[iExemples + 1]) || 8 : 8;

  // ── LES PERSONNES ───────────────────────────────────────────────────────────────────────────
  const [docteurs, beneficiaires, voyageurs, hebergements, employes, users, annuaire, contacts, fournisseurs] = await Promise.all([
    prisma.medicalDoctor.findMany({ select: { id: true, name: true, firstName: true, lastName: true, phone: true, email: true, wilaya: true, city: true, institution: true, institutionId: true } }),
    prisma.careBeneficiary.findMany({ select: { id: true, firstName: true, lastName: true, institution: true, doctorId: true } }),
    prisma.adProVoyageur.findMany({ select: { id: true, nom: true, prenom: true } }),
    prisma.adProHebergement.findMany({ select: { id: true, nom: true, prenom: true } }),
    prisma.employee.findMany({ select: { id: true, fullName: true, email: true, phone: true, birthDate: true, nationalId: true, userId: true } }),
    prisma.user.findMany({ select: { id: true, name: true, email: true, phone: true } }),
    prisma.directoryEntry.findMany({ select: { id: true, displayName: true, userId: true, employeeId: true, contactId: true, endpoints: { select: { channel: true, value: true } } } }),
    prisma.companyContact.findMany({ select: { id: true, name: true, contactName: true, phone: true, phoneAlt: true, email: true, wilaya: true, city: true, nif: true, rc: true } }),
    prisma.supplier.findMany({ select: { id: true, name: true, contactName: true, contactEmail: true, phone: true, city: true } }),
  ]);

  const personnes: FichePersonne[] = [
    ...docteurs.map((d) => ({
      ref: `MedicalDoctor:${d.id}`, nom: nomComplet({ complet: d.name, nom: d.lastName, prenom: d.firstName }),
      emails: [d.email], telephones: [d.phone], wilaya: d.wilaya ?? d.city, etablissement: d.institution, etablissementId: d.institutionId,
    })),
    // Un bénéficiaire tiré de l'annuaire EST le médecin : l'ERP les relie déjà.
    ...beneficiaires.map((b) => ({
      ref: `CareBeneficiary:${b.id}`, nom: nomComplet({ nom: b.lastName, prenom: b.firstName }), etablissement: b.institution,
      liens: b.doctorId ? [`MedicalDoctor:${b.doctorId}`] : [],
    })),
    ...voyageurs.map((v) => ({ ref: `AdProVoyageur:${v.id}`, nom: nomComplet({ nom: v.nom, prenom: v.prenom }) })),
    ...hebergements.map((h) => ({ ref: `AdProHebergement:${h.id}`, nom: nomComplet({ nom: h.nom, prenom: h.prenom }) })),
    ...employes.map((e) => ({
      ref: `Employee:${e.id}`, nom: e.fullName, emails: [e.email], telephones: [e.phone], naissance: e.birthDate, nin: e.nationalId,
      liens: e.userId ? [`User:${e.userId}`] : [],
    })),
    ...users.map((u) => ({ ref: `User:${u.id}`, nom: u.name, emails: [u.email], telephones: [u.phone] })),
    ...annuaire.map((d) => ({
      ref: `DirectoryEntry:${d.id}`, nom: d.displayName,
      emails: d.endpoints.filter((x) => x.channel === "EMAIL").map((x) => x.value),
      telephones: d.endpoints.filter((x) => x.channel !== "EMAIL").map((x) => x.value),
      liens: [d.userId && `User:${d.userId}`, d.employeeId && `Employee:${d.employeeId}`].filter((x): x is string => !!x),
    })),
    // La personne de contact d'un tiers : son e-mail est souvent le sien, son téléphone souvent celui du tiers.
    ...contacts.filter((c) => c.contactName?.trim()).map((c) => ({
      ref: `CompanyContact.contactName:${c.id}`, nom: c.contactName!, emails: [c.email], telephones: [c.phone, c.phoneAlt], wilaya: c.wilaya ?? c.city,
    })),
    ...fournisseurs.filter((s) => s.contactName?.trim()).map((s) => ({
      ref: `Supplier.contactName:${s.id}`, nom: s.contactName!, emails: [s.contactEmail], telephones: [s.phone], wilaya: s.city,
    })),
  ];

  // ── LES ORGANISATIONS ───────────────────────────────────────────────────────────────────────
  const [institutions, societes] = await Promise.all([
    prisma.medicalInstitution.findMany({ select: { id: true, name: true, wilaya: true, city: true, phone: true, email: true } }),
    prisma.company.findMany({ select: { id: true, name: true, legalIdentity: { select: { legalName: true, rcNumber: true, nif: true, nis: true, taxArticle: true, phone: true, email: true } } } }),
  ]);
  const organisations: FicheOrganisation[] = [
    ...societes.map((c) => ({
      ref: `Company:${c.id}`, nom: c.legalIdentity?.legalName || c.name, nif: c.legalIdentity?.nif, rc: c.legalIdentity?.rcNumber,
      nis: c.legalIdentity?.nis, ai: c.legalIdentity?.taxArticle, emails: [c.legalIdentity?.email], telephones: [c.legalIdentity?.phone],
      estDuGroupe: true,
    })),
    ...contacts.map((c) => ({ ref: `CompanyContact:${c.id}`, nom: c.name, nif: c.nif, rc: c.rc, wilaya: c.wilaya ?? c.city, emails: [c.email], telephones: [c.phone, c.phoneAlt] })),
    ...fournisseurs.map((s) => ({ ref: `Supplier:${s.id}`, nom: s.name, wilaya: s.city, emails: [s.contactEmail], telephones: [s.phone] })),
    ...institutions.map((i) => ({ ref: `MedicalInstitution:${i.id}`, nom: i.name, wilaya: i.wilaya ?? i.city, emails: [i.email], telephones: [i.phone] })),
  ];
  const identifiantsGroupe = {
    nifs: societes.map((c) => c.legalIdentity?.nif),
    rcs: societes.map((c) => c.legalIdentity?.rcNumber),
    nis: societes.map((c) => c.legalIdentity?.nis),
  };

  const bilan = (famille: string, refs: string[], r: ResultatLot): Bilan => {
    const parTable: Record<string, number> = {};
    for (const x of refs) parTable[tableDe(x)] = (parTable[tableDe(x)] ?? 0) + 1;
    const parNiveau = { CERTAIN: 0, PROBABLE: 0, POSSIBLE: 0 };
    const parCouple: Bilan["parCouple"] = {};
    for (const p of r.propositions) {
      parNiveau[p.niveau]++;
      const k = [tableDe(p.a), tableDe(p.b)].sort().join(" ↔ ");
      parCouple[k] ??= { CERTAIN: 0, PROBABLE: 0, POSSIBLE: 0 };
      parCouple[k][p.niveau]++;
    }
    const basse = regrouper(refs, r.propositions, "PROBABLE");
    const large = regrouper(refs, r.propositions, "POSSIBLE");
    // Les exemples : les meilleurs scores, en variant les couples de tables (pas huit fois la même paire de tables).
    const exemples = Object.fromEntries(NIVEAUX.map((n) => {
      const duNiveau = r.propositions.filter((p) => p.niveau === n);
      const choisis: PropositionDoublon[] = [];
      const couples = new Map<string, number>();
      for (const p of duNiveau) {
        const k = [tableDe(p.a), tableDe(p.b)].sort().join("|");
        if ((couples.get(k) ?? 0) >= Math.max(2, Math.ceil(nExemples / 3))) continue;
        couples.set(k, (couples.get(k) ?? 0) + 1);
        choisis.push(p);
        if (choisis.length >= nExemples) break;
      }
      return [n, choisis.map(({ a, b, score, raisons, reserves }) => ({ a, b, score, raisons, reserves }))];
    })) as Bilan["exemples"];
    return {
      famille, lignes: refs.length, parTable, estimationBasse: basse.length, estimationLarge: large.length,
      comparaisons: r.comparaisons, parNiveau, parCouple, blocsIgnores: r.blocsIgnores.slice(0, 10),
      plusGrosGroupes: basse.filter((g) => g.length > 1).slice(0, 5).map((g) => ({ taille: g.length, fiches: g.slice(0, 8) })),
      exemples,
    };
  };

  const rp = proposerDoublonsPersonnes(personnes);
  const ro = proposerDoublonsOrganisations(organisations, identifiantsGroupe);
  const bilans = [bilan("Personnes", personnes.map((f) => f.ref), rp), bilan("Organisations", organisations.map((f) => f.ref), ro)];

  // Les libellés des exemples, pour un rapport lisible (le nom tel qu'il est saisi).
  const noms = new Map<string, string>([...personnes.map((f) => [f.ref, f.nom] as const), ...organisations.map((f) => [f.ref, f.nom] as const)]);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ bilans, noms: Object.fromEntries([...noms].filter(([r]) => bilans.some((b) => NIVEAUX.some((n) => b.exemples[n].some((e) => e.a === r || e.b === r))))) }, null, 2));
  } else {
    for (const b of bilans) {
      console.log(`\n══ ${b.famille.toUpperCase()} ══`);
      console.log(`Lignes : ${b.lignes}  (${Object.entries(b.parTable).map(([t, n]) => `${t} ${n}`).join(", ")})`);
      console.log(`Réelles estimées : ${b.estimationBasse} en suivant CERTAIN + PROBABLE · ${b.estimationLarge} en suivant aussi POSSIBLE`);
      console.log(`Propositions : CERTAIN ${b.parNiveau.CERTAIN} · PROBABLE ${b.parNiveau.PROBABLE} · POSSIBLE ${b.parNiveau.POSSIBLE}  (${b.comparaisons} paires comparées)`);
      for (const [k, v] of Object.entries(b.parCouple).sort((x, y) => (y[1].CERTAIN + y[1].PROBABLE + y[1].POSSIBLE) - (x[1].CERTAIN + x[1].PROBABLE + x[1].POSSIBLE))) {
        console.log(`   ${k.padEnd(52)} C ${v.CERTAIN}  P ${v.PROBABLE}  p ${v.POSSIBLE}`);
      }
      if (b.blocsIgnores.length) console.log(`Blocs trop peuplés, non comparés : ${b.blocsIgnores.map((x) => `${x.cle} (${x.taille})`).join(", ")}`);
      for (const g of b.plusGrosGroupes) console.log(`Groupe de ${g.taille} : ${g.fiches.map((r) => `${noms.get(r)} [${tableDe(r)}]`).join(" · ")}`);
      for (const n of NIVEAUX) {
        if (!b.exemples[n].length) continue;
        console.log(`\n  — ${n} —`);
        for (const e of b.exemples[n]) {
          console.log(`  ${e.score}  « ${noms.get(e.a)} » [${tableDe(e.a)}]  ↔  « ${noms.get(e.b)} » [${tableDe(e.b)}]`);
          console.log(`        ${e.raisons.join(" ; ")}${e.reserves.length ? `  ⚠ ${e.reserves.join(" ; ")}` : ""}`);
        }
      }
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
