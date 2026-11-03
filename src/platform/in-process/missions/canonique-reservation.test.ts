import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { lancerMission, avancerMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, pour, planScripte } from "@/platform/in-process/missions/fake-reasoner";
import { designerAuteur, type ArtifactSink, type Porteur } from "@/lib/missions/artifacts/build";
import { adaptateurPour } from "@/lib/artifact/adapters/registry";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉSERVATION DES LIVRABLES FRÈRES, SOUS ENTRELACEMENT FORCÉ (#88, §118.65).
 *
 * `canonique.test.ts` prouve qu'un classeur et un deck bâtis sur les MÊMES données ne coûtent
 * qu'UN appel de mise en forme. Il est tombé trois fois en trois semaines sous la charge de la
 * suite complète, et passait seul : il espérait un ordonnancement. Ce banc ne l'espère pas — il
 * le FORCE, par des verrous de ligne que la transaction du banc tient, et il lit les sessions
 * bloquées par leur `pg_blocking_pids` (jamais par un texte de requête, que la suite partage).
 *
 * ── CE QUI ÉTAIT FAUX, MESURÉ ───────────────────────────────────────────────────────────
 *
 * Réserver (un `upsert`) puis désigner l'auteur (« la ligne la plus ancienne ») étaient deux
 * instructions séparées, et la plus ancienne se lisait sur `createdAt`. Or `createdAt` est posé
 * par le CLIENT Prisma quand il construit la requête (mesuré : c'est un paramètre de l'INSERT,
 * pas le `DEFAULT` de la base) — ni au commit, ni à la réservation. Trois conséquences :
 *
 *   (A1) une ligne QUI EXISTAIT DÉJÀ (un livrable d'une version précédente, dont la clé est
 *        reprise) est « la plus ancienne » quel que soit l'ordre des réservations : le second
 *        réservataire se désigne auteur alors que le premier compose déjà — deux appels ;
 *   (A2) une désignation lue AVANT que la réservation d'un frère soit visible le croit absent :
 *        les deux se désignent — deux appels ;
 *   (B)  un suiveur reprenait la spec de la ligne de l'auteur dès qu'elle était NON VIDE — y
 *        compris celle de la version précédente, encore là tant que l'auteur n'a pas publié la
 *        nouvelle : un deck aux chiffres d'avant à côté d'un classeur à ceux d'aujourd'hui.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__canres${Date.now()}`;
const PERIMEE = "empreinte-version-precedente";
let pdg: CurrentUser;
let companyId = "";

class DepotMemoire implements ArtifactSink {
  readonly fichiers: { fileName: string; data: Buffer; mime: string }[] = [];
  async deposer(input: { fileName: string; mime: string; data: Buffer }) {
    this.fichiers.push({ fileName: input.fileName, data: input.data, mime: input.mime });
    return { nodeId: `mem-${this.fichiers.length}` };
  }
}

const specArtefact = (montant: number) => ({
  key: "recap", title: "Consolidation", fileName: null, format: "XLSX",
  summary: [{ heading: "Ce que disent les chiffres", paragraphs: [`Le total s'établit à ${montant}.`], bullets: [] }],
  sheets: [{
    name: "Consolidation",
    columns: [
      { header: "Produit", key: "produit", type: "text" },
      { header: "Montant", key: "montant", type: "money" },
    ],
    rows: [{ values: ["Nivolex", String(montant)] }, { values: ["Trastuzex", String(montant * 2)] }],
    computed: [], totals: [{ column: "montant", agregat: "SUM" }], note: null,
  }],
  charts: [], sources: ["ERP Adventum"],
});

const etapeArtefact = (key: string, title: string, format: string, condition: string) => ({
  key, title, workstream: "conso",
  nodeType: "ARTIFACT", capability: null,
  inputs: [{ key: "format", kind: "TEXT", value: format }],
  dependsOn: ["liste"], forEachFrom: null, forEachPath: null, forEachAs: null,
  waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
  outputFields: [], completionCondition: condition,
  reasoningRequirement: "LIGHT", approvalRequirement: "NONE", maxAttempts: null,
});

const plan = () => planScripte({
  goal: "Consolider les montants et produire le classeur ET le deck.",
  reasoningComplexity: "B",
  executionScale: "S",
  acceptanceCriteria: ["Le classeur et le deck existent et portent les mêmes chiffres."],
  workstreams: [{ id: "conso", title: "Consolidation", outcome: "Les livrables existent." }],
  steps: [
    {
      key: "liste", title: "Lister les salariés", workstream: "conso",
      nodeType: "CAPABILITY", capability: "directory_list",
      inputs: [{ key: "department", kind: "TEXT", value: TAG }, { key: "limit", kind: "NUMBER", value: "5" }],
      dependsOn: [], forEachFrom: null, forEachPath: null, forEachAs: null,
      waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
      outputFields: [], completionCondition: "La liste est chargée.",
      reasoningRequirement: "NONE", approvalRequirement: "NONE", maxAttempts: null,
    },
    etapeArtefact("classeur", "Classeur de consolidation", "XLSX", "Le classeur existe et s'ouvre."),
    etapeArtefact("deck", "Deck de consolidation", "PPTX", "Le deck existe et s'ouvre."),
  ],
  expectedArtifacts: [
    { key: "classeur", format: "XLSX", title: "Classeur de consolidation", fromStep: "classeur" },
    { key: "deck", format: "PPTX", title: "Deck de consolidation", fromStep: "deck" },
  ],
  approvalStrategy: "BUNDLE",
  completionCriteria: "Le classeur et le deck existent, s'ouvrent, et portent les mêmes chiffres.",
  gaps: [],
  rationale: "Lire la liste une fois, puis en tirer les deux livrables.",
});

const verdictSatisfait = (req: { prompt: string }) => {
  const clesVues = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
  return {
    satisfied: true, confidence: 0.9,
    criteria: [{ criterion: "Le classeur et le deck existent et portent les mêmes chiffres.", status: "SATISFAIT", evidenceRefs: clesVues.slice(0, 3) }],
    missing: [], contradictions: [], suggestedRecovery: null,
  };
};

/** Le cerveau du banc. `premier` décide de la réponse au PREMIER appel de mise en forme. */
const cerveauPour = (premier: "100" | "PANNE") => new RaisonneurScripte([
  pour("mission.plan", () => ({ ok: true, data: plan() })),
  pour("mission.artifact", (_r, n) => {
    if (n === 1 && premier === "PANNE") return { ok: false, error: "fournisseur indisponible (banc)" };
    // Au-delà du premier, le modèle « change d'avis » : un second appel se lit dans les fichiers.
    return { ok: true, data: specArtefact(premier === "PANNE" ? 100 : n === 1 ? 100 : 999) };
  }),
  pour("mission.goal", (req) => ({ ok: true, data: verdictSatisfait(req as { prompt: string }) })),
]);

async function lancer(cerveau: RaisonneurScripte, depot: DepotMemoire): Promise<{ missionId: string; etapes: Map<string, string> }> {
  const r = await lancerMission(pdg, "Consolide et produis le classeur et le deck.", { reasoner: cerveau, sink: depot, demarrer: false });
  if (!r.ok) throw new Error(`mission non lancée : ${r.error}`);
  const steps = await prisma.missionStep.findMany({ where: { missionId: r.missionId }, select: { id: true, key: true } });
  return { missionId: r.missionId, etapes: new Map(steps.map((s) => [s.key, s.id])) };
}

/** Le livrable d'une VERSION PRÉCÉDENTE, bâti sur d'autres données — sa clé sera reprise. */
async function livrablePrecedent(missionId: string, key: string, format: "XLSX" | "PPTX", ageMs: number): Promise<string> {
  const l = await prisma.missionArtifact.create({
    data: {
      missionId, key, title: `${key} (version précédente)`, format, fileName: `${key}_v1.${format.toLowerCase()}`,
      status: "VERIFIED", byteSize: 2048, inputsHash: PERIMEE,
      spec: { ...specArtefact(555), key, format, inputsHash: PERIMEE } as never,
      createdAt: new Date(Date.now() - ageMs),
    },
    select: { id: true },
  });
  return l.id;
}

/** Tient un verrou de ligne dans une transaction du banc, jusqu'à `relacher()`. */
function tenirVerrou(table: "MissionStep" | "MissionArtifact", id: string) {
  let liberer!: () => void;
  const libere = new Promise<void>((r) => { liberer = r; });
  let signaler!: (pid: number) => void;
  const acquis = new Promise<number>((r) => { signaler = r; });
  const fini = prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT 1 FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
    const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    signaler(pid);
    await libere;
  }, { timeout: 180_000, maxWait: 30_000 });
  return { acquis, relacher: async () => { liberer(); await fini; } };
}

/** Les sessions que `pid` bloque — la seule lecture qui ne dépend pas de la charge de la suite. */
async function bloquesPar(pid: number): Promise<number[]> {
  const r = await prisma.$queryRaw<{ pid: number }[]>`
    SELECT pid FROM pg_stat_activity WHERE ${pid}::int4 = ANY(pg_blocking_pids(pid))`;
  return r.map((x) => x.pid);
}

async function diagnostic(): Promise<string> {
  const r = await prisma.$queryRaw<{ pid: number; ev: string | null; q: string }[]>`
    SELECT pid, wait_event_type || ':' || wait_event AS ev, left(query, 90) AS q FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return r.map((x) => `${x.pid} ${x.ev} ${x.q}`).join(" | ") || "aucune session en attente de verrou";
}

async function jusqua(cond: () => Promise<boolean> | boolean, quoi: string, ms = 90_000): Promise<void> {
  const debut = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - debut > ms) throw new Error(`barrière non atteinte : ${quoi} — ${await diagnostic()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function avancer(missionId: string, cerveau: RaisonneurScripte, depot: DepotMemoire, tours = 6): Promise<void> {
  for (let i = 0; i < tours; i++) await avancerMission(pdg, missionId, { reasoner: cerveau, sink: depot });
}

/** Les chiffres du jeu d'essai VRAIMENT présents dans chaque fichier rouvert. */
async function chiffresLus(depot: DepotMemoire): Promise<Map<string, string>> {
  const lus = new Map<string, string>();
  for (const f of depot.fichiers) {
    const format = f.fileName.endsWith(".xlsx") ? "XLSX" as const : "PPTX" as const;
    const m = (await adaptateurPour(format).ouvrir(f.data)).modele();
    const texte = m.kind === "XLSX"
      ? m.sheets.flatMap((s) => s.cells.map((c) => c.value)).join(" ")
      : m.kind === "PPTX" ? m.slides.flatMap((d) => [d.title, ...d.shapes.map((s) => s.text)]).join(" ") : "";
    lus.set(f.fileName, ["100", "200", "555", "999", "1110", "1998"].filter((n) => new RegExp(`\\b${n}\\b`).test(texte)).join(","));
  }
  return lus;
}

/** Ce que tout scénario doit rendre : un contenu, deux formats, aucune donnée d'avant. */
async function exigerUneSeuleBase(missionId: string, depot: DepotMemoire): Promise<void> {
  const lignes = await prisma.missionArtifact.findMany({
    where: { missionId }, select: { key: true, format: true, status: true, inputsHash: true },
  });
  expect(lignes.map((l) => l.format).sort(), "les deux livrables n'ont pas été produits").toEqual(["PPTX", "XLSX"]);
  expect(lignes.every((l) => l.status === "VERIFIED"), JSON.stringify(lignes)).toBe(true);
  expect(new Set(lignes.map((l) => l.inputsHash)).size, "deux empreintes pour les mêmes données amont").toBe(1);
  expect(lignes[0].inputsHash, "l'empreinte de la version précédente est restée").not.toBe(PERIMEE);

  const lus = await chiffresLus(depot);
  const derniers = [...lus].slice(-2);
  for (const [nom, vus] of derniers) {
    expect(vus, `${nom} porte les chiffres de la VERSION PRÉCÉDENTE`).not.toMatch(/\b(555|1110)\b/);
    expect(vus, `${nom} ne porte aucun chiffre du jeu d'essai`).not.toBe("");
  }
  expect(new Set(derniers.map(([, v]) => v)).size,
    `les deux livrables annoncent des chiffres DIFFÉRENTS : ${derniers.map(([n, v]) => `${n} → ${v}`).join(" | ")}`).toBe(1);
}

describe("La règle de désignation, pure — ce que les trois scénarios ne parcourent pas", () => {
  const E = "empreinte-du-jour";
  const t = (s: number) => new Date(Date.UTC(2026, 9, 1, 8, 0, s));
  const porteur = (key: string, format: string, cree: number, reserve: number, base = false): Porteur => ({
    key, format, createdAt: t(cree), updatedAt: t(reserve), spec: base ? { inputsHash: E, title: "x" } : { inputsHash: "avant" },
  });

  it("personne n'a réservé ces données : c'est à moi de composer", () => {
    expect(designerAuteur([], "deck", "PPTX", E)).toBeNull();
  });

  it("un livrable de MON format est un autre découpage : il ne me désigne jamais", () => {
    expect(designerAuteur([porteur("classeur-a", "xlsx", 1, 1, true)], "classeur-b", "XLSX", E)).toBeNull();
  });

  it("une base publiée pour ces données fait foi, même pour une reprise, même plus récente", () => {
    const porteurs = [porteur("deck", "PPTX", 0, 0), porteur("pdf", "PDF", 5, 9, true), porteur("classeur", "XLSX", 1, 1)];
    expect(designerAuteur(porteurs, "classeur", "XLSX", E)).toBe("pdf");
  });

  it("sans base, le PREMIER RÉSERVATAIRE compose — pas la ligne la plus ancienne", () => {
    // `vieux` existait avant (version précédente, clé reprise) mais n'a réservé qu'en second.
    const porteurs = [porteur("vieux", "PPTX", 0, 7), porteur("neuf", "PDF", 6, 6)];
    expect(designerAuteur(porteurs, "classeur", "XLSX", E)).toBe("neuf");
  });

  it("une spec d'AUTRES données n'est pas une base", () => {
    const porteurs = [porteur("deck", "PPTX", 0, 3), porteur("pdf", "PDF", 1, 1)];
    expect(designerAuteur(porteurs, "classeur", "XLSX", E)).toBe("pdf");
  });
});

suite("#88 — la réservation des livrables frères, sous entrelacement forcé", () => {
  beforeAll(async () => {
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) }, select: { id: true } });
    companyId = c.id;
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true, name: true, email: true, role: true },
    });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    const compte = await prisma.user.create({
      data: { name: `${TAG} Delegue`, email: `${TAG}0@amd.dz`, passwordHash: "x", role: "SALES_USER" }, select: { id: true },
    });
    await prisma.employee.create({
      data: { fullName: `${TAG} Delegue`, email: `${TAG}0@amd.dz`, position: "Délégué", department: TAG, isActive: true, companyId, userId: compte.id },
    });
  }, 120_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  it("A1 — la ligne d'une version précédente, « plus ancienne », ne fait pas un second auteur", async () => {
    const depot = new DepotMemoire();
    const cerveau = cerveauPour("100");
    const { missionId, etapes } = await lancer(cerveau, depot);
    await livrablePrecedent(missionId, "deck", "PPTX", 3_600_000);

    // LE DECK ATTEND À SA RÉCLAMATION : le classeur réserve, se désigne et compose SEUL. On ne
    // relâche qu'une fois l'appel de mise en forme parti — l'ordre est un fait, pas un espoir.
    const verrou = tenirVerrou("MissionStep", etapes.get("deck")!);
    const pid = await verrou.acquis;
    const avance = avancer(missionId, cerveau, depot);
    await jusqua(() => cerveau.appelsPour("mission.artifact") >= 1, "le classeur n'a pas appelé le modèle");
    await jusqua(async () => (await bloquesPar(pid)).length > 0, "le deck n'attend pas à sa réclamation");
    await verrou.relacher();
    await avance;

    // PRÉMISSE : la ligne du deck EST la plus ancienne — c'est elle que l'ancienne règle aurait
    // désignée. Sans elle, ce cas passerait sans plus rien discriminer.
    const [deck, classeur] = await Promise.all(["deck", "classeur"].map((key) =>
      prisma.missionArtifact.findUniqueOrThrow({ where: { missionId_key: { missionId, key } }, select: { createdAt: true } })));
    expect(deck.createdAt.getTime()).toBeLessThan(classeur.createdAt.getTime());

    expect(cerveau.appelsPour("mission.artifact"), "le deck a rappelé le modèle : deux auteurs pour une base").toBe(1);
    await exigerUneSeuleBase(missionId, depot);
    expect(await prisma.missionEvent.count({ where: { missionId, kind: "ARTIFACT_CANONIQUE" } })).toBe(1);
  }, 240_000);

  it("A2 — une réservation qui n'est pas encore visible ne laisse pas un frère se croire seul", async () => {
    const depot = new DepotMemoire();
    const cerveau = cerveauPour("100");
    const { missionId, etapes } = await lancer(cerveau, depot);
    const ligneDeck = await livrablePrecedent(missionId, "deck", "PPTX", 3_600_000);

    // LE DECK EST ARRÊTÉ AU MILIEU DE SA RÉSERVATION (sa ligne est tenue), le classeur à sa
    // réclamation. Puis le classeur repart, pendant que le deck n'a toujours rien écrit.
    const ligne = tenirVerrou("MissionArtifact", ligneDeck);
    const etape = tenirVerrou("MissionStep", etapes.get("classeur")!);
    const [pidLigne, pidEtape] = await Promise.all([ligne.acquis, etape.acquis]);
    const avance = avancer(missionId, cerveau, depot);
    await jusqua(async () => (await bloquesPar(pidLigne)).length > 0 && (await bloquesPar(pidEtape)).length > 0,
      "le deck n'est pas arrêté dans sa réservation, ou le classeur pas à sa réclamation");
    const [pidDeck] = await bloquesPar(pidLigne);
    await etape.relacher();
    // Le classeur repart. Soit il attend la réservation du deck (elle tient le verrou de la
    // désignation), soit — sans ce verrou — il se désigne seul et appelle le modèle.
    await jusqua(async () => cerveau.appelsPour("mission.artifact") >= 1 || (await bloquesPar(pidDeck)).length > 0,
      "le classeur n'a ni attendu la désignation du deck, ni appelé le modèle");
    await ligne.relacher();
    await avance;

    expect(cerveau.appelsPour("mission.artifact"), "deux réservataires se sont crus seuls : deux appels").toBe(1);
    await exigerUneSeuleBase(missionId, depot);
  }, 240_000);

  it("B — un suiveur ne reprend JAMAIS la base des données d'avant, même quand l'auteur n'a rien publié", async () => {
    const depot = new DepotMemoire();
    // L'AUTEUR RÉSERVE PUIS ÉCHOUE : sa ligne porte la NOUVELLE empreinte et l'ANCIENNE spec.
    const cerveau = cerveauPour("PANNE");
    const { missionId } = await lancer(cerveau, depot);
    await livrablePrecedent(missionId, "classeur", "XLSX", 7_200_000);
    await livrablePrecedent(missionId, "deck", "PPTX", 3_600_000);

    await avancer(missionId, cerveau, depot, 8);

    // Un appel en panne, un appel qui compose — et la reprise de l'auteur suit la base publiée.
    expect(cerveau.appelsPour("mission.artifact")).toBe(2);
    await exigerUneSeuleBase(missionId, depot);
    // PRÉMISSE : le premier appel a bien échoué — sinon l'auteur aurait publié et le suiveur
    // n'aurait jamais lu la spec d'avant, et ce cas ne discriminerait plus rien.
    expect(cerveau.demandes.filter((d) => d.purpose === "mission.artifact")).toHaveLength(2);
    expect(await prisma.missionEvent.count({ where: { missionId, kind: "ARTIFACT_CANONIQUE" } })).toBe(1);
  }, 240_000);
});
