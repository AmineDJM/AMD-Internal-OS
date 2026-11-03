import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { avancer, BAIL_MS, StepHandlers } from "./engine";
import { chargerEtat, materialiser } from "./store";
import { compile } from "@/lib/missions/compiler/compile";
import type { MissionPlan, PlannedStep } from "@/lib/missions/planner/contract";
import type {
  CapabilityCall, CapabilityCatalog, CapabilityOutcome, MissionActor, RegistreRecours,
} from "@/lib/missions/ports";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MOTEUR, SUR UNE VRAIE BASE — parce que c'est la base qui porte les garanties.
 *
 * Un test de moteur avec un dépôt en mémoire vérifierait ma logique et rien d'autre. Or les
 * propriétés qui comptent ici sont TENUES PAR POSTGRES : l'unicité de la clé d'idempotence, la
 * réservation conditionnelle d'une étape, la survie d'un plan à un redémarrage. Les simuler
 * reviendrait à tester la simulation.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__mr__${Date.now()}`;
let ownerId = "";
let actor: MissionActor;

/** Un exécutant qui NOTE tout : c'est sur ses notes que portent les assertions les plus dures. */
function traceur(options: {
  echouer?: (call: CapabilityCall) => { kind: string; message: string; retryable: boolean } | null;
  sortie?: (call: CapabilityCall) => unknown;
} = {}) {
  const appels: CapabilityCall[] = [];
  return {
    appels,
    runner: {
      async run(call: CapabilityCall): Promise<CapabilityOutcome> {
        appels.push(call);
        const echec = options.echouer?.(call) ?? null;
        if (echec) return { ok: false, output: null, error: echec };
        return { ok: true, output: options.sortie?.(call) ?? { ok: true, step: call.stepKey } };
      },
    },
  };
}

const CONNUES = [
  "directory_list", "employee_360", "read_hr_overview", "inspect_record",
  "gmail_prepare_mail", "send_email", "send_message", "create_admin_request",
  "search_courriers", "search_drive",
];

/**
 * UN REGISTRE DE RECOURS DE TEST — même contrat que la production, sans catalogue ni droits.
 *
 * Il traduit un grenier en CAPACITÉ, ce que le vrai registre fait à partir du catalogue réel.
 * Sa présence ou son absence est ce qui décide si `AUTRE_SOURCE` est exécutable : c'est la
 * différence entre un recours et une étiquette écrite dans une entrée que personne ne lit.
 */
const REGISTRE_TEST: RegistreRecours = {
  autreSource: ({ source, capaciteActuelle, entree }) => {
    const cap = ({ LEGAL: "search_courriers", DRIVE: "search_drive", HR: "employee_360" } as Record<string, string>)[source];
    if (!cap || cap === capaciteActuelle) return null;
    const texte = entree.reference ?? entree.query;
    if (typeof texte !== "string") return null;
    return { capability: cap, input: { query: texte }, ceQuiChange: `${capaciteActuelle} → ${cap}` };
  },
};

const catalogue: CapabilityCatalog = {
  has: (n) => CONNUES.includes(n),
  allowed: () => true,
  meta: (n) => capabilityMeta(n),
  brief: () => [],
};

async function creerMission(steps: PlannedStep[], titre: string, extra: Partial<MissionPlan> = {}) {
  const plan: MissionPlan = {
    objective: titre,
    acceptance: ["le travail décrit est fait"],
    complexity: "B",
    scale: "M",
    steps,
    ...extra,
  };
  const r = compile(plan, catalogue, actor);
  if (!r.ok) throw new Error(`plan refusé : ${r.issues.map((i) => `${i.code} ${i.message}`).join(" | ")}`);
  return materialiser(r.mission, { ownerId, title: titre, goalRaw: titre });
}

suite("Mission Runtime — le moteur d'exécution durable", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    ownerId = u.id;
    actor = { userId: u.id, label: "le PDG", isAgent: false };
  });

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("exécute une mission linéaire de trois étapes, dans l'ordre", async () => {
    const t = traceur();
    const id = await creerMission([
      { key: "a", title: "Lister", capability: "directory_list" },
      { key: "b", title: "Fiches", capability: "employee_360", dependsOn: ["a"] },
      { key: "c", title: "Inspecter", capability: "inspect_record", dependsOn: ["b"] },
    ], "trois étapes");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.executees).toBe(3);
    expect(r.echouees).toBe(0);
    expect(t.appels.map((a) => a.stepKey)).toEqual(["a", "b", "c"]);

    const etat = await chargerEtat(id);
    expect(etat!.steps.every((s) => s.status === "DONE")).toBe(true);
  }, /**
   * SON PROPRE PLAFOND, ET C'EST UNE BORNE DE BLOCAGE — pas une mesure de vitesse.
   *
   * MESURÉ : ~1 s en isolation (3 fois sur 3), et un dépassement des 20 000 s globales dans la
   * suite complète — 732 fichiers sur QUATRE cœurs. Ce cas-ci fait tourner le VRAI moteur sur
   * la VRAIE base (trois étapes, leurs reçus, leurs événements) : il paie la contention de la
   * base en plus de celle du processeur. C'est le défaut nommé juste sous `testTimeout` dans
   * `vitest.config.ts` — « le test le plus lent fait environ 2 s » n'était plus vrai.
   *
   * On ne relève PAS le plafond global : il garderait 8 495 tests moins sévèrement pour en
   * réparer un (§118.16). Rien n'est masqué — un moteur qui ne rend jamais la main échoue
   * toujours, un peu plus tard.
   */ 60_000);
  it("parallélise ce qui est parallélisable, et sérialise ce qui ne l'est pas", async () => {
    const t = traceur();
    const steps: PlannedStep[] = [
      { key: "racine", title: "R", capability: "directory_list" },
      ...Array.from({ length: 12 }, (_, i) => ({
        key: `f${i}`, title: `F${i}`, capability: "employee_360", dependsOn: ["racine"],
      })),
      { key: "fin", title: "Fin", nodeType: "JOIN" as const, dependsOn: Array.from({ length: 12 }, (_, i) => `f${i}`) },
    ];
    const id = await creerMission(steps, "éventail statique");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.executees).toBe(14);
    // La racine part seule, les douze branches suivent, la jonction ferme. La jonction
    // n'appelle aucune capacité : elle n'existe que pour tenir le graphe.
    expect(t.appels[0].stepKey).toBe("racine");
    expect(t.appels).toHaveLength(13);
    const etat = await chargerEtat(id);
    expect(etat!.steps.find((s) => s.key === "fin")!.status).toBe("DONE");
    /**
     * QUATORZE ÉTAPES EN BASE — la borne est celle du TRAVAIL, pas une assertion déguisée.
     *
     * Ce cas tournait sur la borne par défaut (20 s). Mesuré : il PASSE seul, et il expire dans
     * la suite complète, où sept cents fichiers se disputent la file de connexions — quatorze
     * écritures et une jonction n'y tiennent pas. Une borne de temps qui dépend de
     * l'ordonnanceur ne mesure pas la propriété qu'elle annonce, elle mesure l'humeur du
     * processeur (§118.83) : une vraie régression s'y perd dans le bruit, un faux échec s'y
     * invente. Ses voisins, qui font autant de travail, portent déjà 60 s.
     *
     * Ce qui reste mesuré, et ne bouge pas : quatorze étapes exécutées, treize appels de
     * capacité (la jonction n'en appelle aucune), la racine EN PREMIER, la jonction terminée.
     * Un moteur qui sérialiserait l'éventail, ou qui appellerait la jonction, tombe toujours.
     */
  }, 60_000);

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * §28 — LA MISSION MASSIVE. Trente-trois personnes, trente-trois messages, zéro copie.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  it("déploie un éventail de 33 : un message par personne, aucun destinataire partagé, aucun doublon", async () => {
    const employes = Array.from({ length: 33 }, (_, i) => ({
      id: `emp-${i}`, email: `e${i}@adventum.dz`, prenom: `P${i}`,
    }));
    const t = traceur({ sortie: (c) => (c.stepKey === "liste" ? { employes } : { ok: true }) });

    const id = await creerMission([
      { key: "liste", title: "Lister l'effectif", capability: "directory_list" },
      {
        key: "voeux", title: "Vœux", capability: "send_message",
        forEach: { from: "liste", path: "employes", as: "e" },
        input: { to: "{{e.id}}", corps: "Bonne année {{e.prenom}}" },
      },
    ], "vœux à 33 salariés");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.deployees).toBe(33);

    const envois = t.appels.filter((a) => a.capability === "send_message");
    expect(envois).toHaveLength(33);

    // 1. CHACUN A REÇU LE SIEN, ET UN SEUL.
    const cibles = envois.map((a) => a.input.to);
    expect(new Set(cibles).size).toBe(33);
    expect([...cibles].sort()).toEqual(employes.map((e) => e.id).sort());

    // 2. AUCUN ENVOI NE PORTE PLUSIEURS DESTINATAIRES — la garde du compilateur tient jusqu'ici.
    expect(envois.every((a) => typeof a.input.to === "string")).toBe(true);

    // 3. LE CORPS EST PERSONNALISÉ, pas un gabarit non résolu parti tel quel.
    const corps = envois.map((a) => String(a.input.corps));
    expect(corps.some((c) => c.includes("{{"))).toBe(false);
    expect(new Set(corps).size).toBe(33);

    // 4. CHAQUE ENVOI PORTE SA PROPRE CLÉ D'IDEMPOTENCE — sinon un retry en dédupliquerait 32.
    const cles = envois.map((a) => a.idempotencyKey);
    expect(cles.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
    expect(new Set(cles).size).toBe(33);

    const etat = await chargerEtat(id);
    expect(etat!.steps.filter((s) => s.key.startsWith("voeux#") && s.status === "DONE")).toHaveLength(33);
    expect(etat!.steps.find((s) => s.key === "voeux")!.status).toBe("DONE");
  }, 60_000);

  it("une collection vide n'est pas un échec, ni une étape ignorée : elle est FAITE, à zéro", async () => {
    const t = traceur({ sortie: (c) => (c.stepKey === "liste" ? { employes: [] } : { ok: true }) });
    const id = await creerMission([
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "msg", title: "Msg", capability: "send_message",
        forEach: { from: "liste", path: "employes", as: "e" }, input: { to: "{{e.id}}" },
      },
    ], "éventail vide");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.echouees).toBe(0);
    const etat = await chargerEtat(id);
    const msg = etat!.steps.find((s) => s.key === "msg")!;
    expect(msg.status).toBe("DONE");
    // Le zéro est ÉCRIT : le contrôle qualité comptera zéro attendu, et non zéro manquant.
    expect((msg.result as { expanded: number }).expanded).toBe(0);
  });

  it("un éventail dont la source ne rend pas une liste échoue en le DISANT, sans réessayer", async () => {
    const t = traceur({ sortie: () => ({ employes: "pas une liste" }) });
    const id = await creerMission([
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "msg", title: "Msg", capability: "send_message",
        forEach: { from: "liste", path: "employes", as: "e" }, input: { to: "{{e.id}}" },
      },
    ], "éventail incompatible");

    await avancer(id, actor, { runner: t.runner });
    const etat = await chargerEtat(id);
    const msg = etat!.steps.find((s) => s.key === "msg")!;
    expect(msg.status).toBe("FAILED");
    expect(msg.errorKind).toBe("INCOMPATIBLE_RESULT");
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * LE SCÉNARIO EXACT D'UN RUN RÉEL — quatre planifications, 191 s, aucun jugement.
   *
   * ── LA CHAÎNE, MAILLON PAR MAILLON ────────────────────────────────────────────────────
   *
   * `search_drive` ne trouve rien et le dit en français ; l'exécutant l'enveloppe en
   * `{ texte: … }` ; l'étape est DONE ; l'éventail demande le chemin exact que la capacité
   * documente et n'obtient rien ; le moteur écrit « il a trouvé undefined » ; l'échelle de
   * recours parcourt six greniers sur une étape qui ne lit pas son entrée ; la mission bloque ;
   * le plan suivant, qui n'a reçu que « undefined », refait la même recherche. Deux fois.
   *
   * Chaque maillon était correct isolément. Les trois tests ci-dessous tiennent les trois
   * endroits où la chaîne se coupe désormais.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  const recoursDe = async (missionId: string) =>
    prisma.missionEvent.findMany({
      where: { missionId, kind: "STEP_RECOVERY" },
      select: { summary: true },
    });

  it("un amont qui a répondu EN TEXTE : le motif est exploitable, et AUCUN recours n'est tenté", async () => {
    // La forme exacte que produit `structurer()` quand une capacité répond en prose.
    const t = traceur({
      sortie: (c) => (c.stepKey === "chercher"
        ? { texte: "Aucun fichier ni dossier ne contient « contrat » dans le Drive visible." }
        : { ok: true }),
    });
    const id = await creerMission([
      { key: "chercher", title: "Chercher les contrats", capability: "inspect_record" },
      {
        key: "lire", title: "Lire les fichiers trouvés", capability: "send_message",
        forEach: { from: "chercher", path: "resultats", as: "f" }, input: { to: "{{f.id}}" },
      },
    ], "éventail sur un texte");

    await avancer(id, actor, { runner: t.runner });
    const etat = await chargerEtat(id);
    const lire = etat!.steps.find((s) => s.key === "lire")!;

    expect(lire.status).toBe("FAILED");
    expect(lire.errorKind).toBe("INCOMPATIBLE_RESULT");

    // 1. LE MOTIF PORTE CE QUE LA CAPACITÉ A DIT. C'est cette phrase que `refusPrecedent`
    //    transmet au planificateur ; « undefined » ne lui apprenait rien, et il replanifiait
    //    la même recherche.
    expect(lire.error).toContain("Aucun fichier ni dossier ne contient");
    expect(lire.error).not.toContain("undefined");

    // 2. AUCUN RECOURS N'A ÉTÉ TENTÉ. `AUTRE_SOURCE` écrit `source` dans l'entrée de l'étape ;
    //    un éventail se déploie avant tout appel de capacité et ne lit jamais son entrée. Le
    //    run réel en a journalisé vingt-quatre pour zéro effet.
    expect(await recoursDe(id)).toEqual([]);

    // 3. ET AUCUNE ITÉRATION N'A ÉTÉ CRÉÉE sur un résultat qu'on ne sait pas parcourir.
    expect(etat!.steps.filter((s) => s.key.startsWith("lire#"))).toHaveLength(0);
  });

  it("LE CONTRE-EXEMPLE — une étape ORDINAIRE, elle, garde tous ses recours", async () => {
    // Sans ce test, la correction précédente pourrait avoir désactivé le recours en général au
    // lieu de retirer deux barreaux inertes sur un seul type de nœud. C'est la différence entre
    // « on ne ment plus » et « on n'essaie plus ».
    const t = traceur({
      echouer: (c) => (c.capability === "inspect_record"
        ? { kind: "NOT_FOUND", message: "le document n'est pas dans le Drive", retryable: false }
        : null),
    });
    const id = await creerMission([
      { key: "doc", title: "Retrouver le contrat", capability: "inspect_record", input: { reference: "contrat consultante" } },
    ], "recours sur étape ordinaire");

    await avancer(id, actor, { runner: t.runner, registre: REGISTRE_TEST });
    const recours = await recoursDe(id);
    expect(recours.length).toBeGreaterThan(0);
    // Et le recours tenté est bien celui qui a du sens ici : chercher AILLEURS — en APPELANT
    // UNE AUTRE CAPACITÉ, ce que le journal dit désormais explicitement.
    expect(recours.some((e) => e.summary.includes("AUTRE_SOURCE"))).toBe(true);
    // LA PREUVE QUI COMPTE : une AUTRE capacité a réellement été appelée. L'ordre des greniers
    // pour un DOCUMENT commence par le Drive, d'où `search_drive` — ce qui importe est que
    // l'appel ait changé, pas lequel.
    const appelees = t.appels.map((a) => a.capability);
    expect(appelees[0]).toBe("inspect_record");
    expect(appelees.slice(1).some((c) => c !== "inspect_record")).toBe(true);
  });

  it("SANS registre, aucun faux recours n'est journalisé — le barreau se saute au lieu de mentir", async () => {
    // L'état d'avant ce lot, rendu honnête. Le moteur écrivait `source: "LEGAL"` dans l'entrée
    // et rejouait la même capacité : six lignes `STEP_RECOVERY` pour six appels identiques.
    // Sans capacité de remplacement, il n'y a rien à tenter, et le journal le dit en se taisant.
    const t = traceur({
      echouer: () => ({ kind: "NOT_FOUND", message: "rien ici", retryable: false }),
    });
    const id = await creerMission([
      { key: "doc", title: "Retrouver le contrat", capability: "inspect_record", input: { reference: "x" } },
    ], "recours sans registre");

    await avancer(id, actor, { runner: t.runner });
    expect(await recoursDe(id)).toEqual([]);
    // Un seul appel : pas de rejeu déguisé en persévérance.
    expect(t.appels).toHaveLength(1);
  });

  it("UNE seule liste dans le résultat : l'éventail se déploie, et la correction est JOURNALISÉE", async () => {
    // Le planificateur a écrit « resultats », la capacité produit « documents ». Il n'y a rien à
    // arbitrer, et replanifier coûterait une cinquantaine de secondes de modèle pour obtenir le
    // même plan à un mot près. On corrige — et on l'écrit au journal, jamais en silence.
    const t = traceur({
      sortie: (c) => (c.stepKey === "chercher"
        ? { documents: [{ id: "d1" }, { id: "d2" }, { id: "d3" }], tronque: false }
        : { ok: true }),
    });
    const id = await creerMission([
      { key: "chercher", title: "Chercher", capability: "inspect_record" },
      {
        key: "lire", title: "Lire", capability: "send_message",
        forEach: { from: "chercher", path: "resultats", as: "f" }, input: { to: "{{f.id}}" },
      },
    ], "correction de chemin");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.deployees).toBe(3);

    const etat = await chargerEtat(id);
    expect(etat!.steps.find((s) => s.key === "lire")!.status).toBe("DONE");
    expect(etat!.steps.filter((s) => s.key.startsWith("lire#") && s.status === "DONE")).toHaveLength(3);

    const corrections = await prisma.missionEvent.findMany({
      where: { missionId: id, kind: "FANOUT_PATH_CORRIGE" },
      select: { summary: true },
    });
    expect(corrections).toHaveLength(1);
    expect(corrections[0].summary).toContain("resultats");
    expect(corrections[0].summary).toContain("documents");
  });

  it("DEUX listes : on ne tranche pas, et le motif NOMME les candidates", async () => {
    // La borne de la correction précédente. Un éventail décide combien d'étapes filles naissent
    // et avec quelles données ; se tromper de liste enverrait N actions sur les mauvaises.
    const t = traceur({
      sortie: (c) => (c.stepKey === "chercher"
        ? { fichiers: [{ id: "f1" }], dossiers: [{ id: "d1" }, { id: "d2" }] }
        : { ok: true }),
    });
    const id = await creerMission([
      { key: "chercher", title: "Chercher", capability: "inspect_record" },
      {
        key: "lire", title: "Lire", capability: "send_message",
        forEach: { from: "chercher", path: "resultats", as: "f" }, input: { to: "{{f.id}}" },
      },
    ], "éventail ambigu");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.deployees).toBe(0);

    const etat = await chargerEtat(id);
    const lire = etat!.steps.find((s) => s.key === "lire")!;
    expect(lire.status).toBe("FAILED");
    expect(lire.error).toContain("fichiers");
    expect(lire.error).toContain("dossiers");
    expect(etat!.steps.filter((s) => s.key.startsWith("lire#"))).toHaveLength(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * §14, §15 — LE CRASH. Le test dont dépend toute la crédibilité du moteur.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  it("un processus tué à 40 % ne rejoue AUCUNE des étapes déjà faites", async () => {
    const t = traceur();
    const steps: PlannedStep[] = Array.from({ length: 10 }, (_, i) => ({
      key: `s${i}`, title: `S${i}`, capability: "send_message",
      input: { to: `p${i}` },
      dependsOn: i === 0 ? [] : [`s${i - 1}`],
    }));
    const id = await creerMission(steps, "processus tué à 40 %");

    // LA COUPURE. Sur une chaîne, chaque tour exécute exactement une étape : borner les tours
    // reproduit fidèlement un processus qui s'arrête au milieu — sans rien simuler d'autre.
    await avancer(id, actor, { runner: t.runner, maxTours: 4 });
    const apresCrash = await chargerEtat(id);
    expect(apresCrash!.steps.filter((s) => s.status === "DONE").map((s) => s.key))
      .toEqual(["s0", "s1", "s2", "s3"]);
    expect(t.appels).toHaveLength(4);

    // ── LE REDÉMARRAGE, avec un moteur neuf qui ne sait rien du précédent ──────────────
    const t2 = traceur();
    const r2 = await avancer(id, actor, { runner: t2.runner });

    // AUCUNE DES QUATRE PREMIÈRES N'EST RAPPELÉE : pas de second message à p0..p3.
    const rejouees = t2.appels.map((a) => a.stepKey).filter((k) => ["s0", "s1", "s2", "s3"].includes(k));
    expect(rejouees).toEqual([]);
    expect(t2.appels.map((a) => a.stepKey)).toEqual(["s4", "s5", "s6", "s7", "s8", "s9"]);
    expect(r2.executees).toBe(6);

    // Sur les deux vies du processus, chaque destinataire a été servi UNE fois exactement.
    const tous = [...t.appels, ...t2.appels];
    expect(new Set(tous.map((a) => a.input.to)).size).toBe(10);
    expect(tous).toHaveLength(10);

    const fin = await chargerEtat(id);
    expect(fin!.steps.filter((s) => s.status === "DONE")).toHaveLength(10);
  }, 60_000);

  it("une étape TUÉE EN PLEIN VOL est reprise avec la MÊME clé d'idempotence", async () => {
    const t = traceur();
    const id = await creerMission([
      { key: "envoi", title: "Envoi", capability: "send_message", input: { to: "alla" } },
    ], "clé conservée à la reprise");

    // Le processus meurt pendant l'appel : l'étape reste « en cours », la clé est déjà posée.
    await avancer(id, actor, { runner: t.runner, maxTours: 0 });
    await prisma.missionStep.updateMany({
      where: { missionId: id, key: "envoi" },
      data: { status: "RUNNING", idempotencyKey: `${id}|envoi|send_message|alla`, startedAt: new Date(Date.now() - BAIL_MS - 1000) },
    });

    const t2 = traceur();
    await avancer(id, actor, { runner: t2.runner });
    expect(t2.appels).toHaveLength(1);
    // LA MÊME CLÉ REPART. C'est elle qui permet au chemin canonique de reconnaître un envoi
    // déjà parti et de rendre son reçu au lieu d'en produire un second.
    expect(t2.appels[0].idempotencyKey).toBe(`${id}|envoi|send_message|alla`);
  });

  it("reprend une étape laissée EN COURS par un processus mort", async () => {
    const t = traceur();
    const id = await creerMission([
      { key: "a", title: "A", capability: "directory_list" },
    ], "étape orpheline");

    // On force l'étape dans l'état qu'un processus tué laisserait derrière lui.
    await prisma.missionStep.updateMany({
      where: { missionId: id, key: "a" },
      data: { status: "RUNNING", startedAt: new Date(Date.now() - BAIL_MS - 60_000) },
    });

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.executees).toBe(1);
    expect((await chargerEtat(id))!.steps[0].status).toBe("DONE");
  });

  it("ne touche PAS une étape en cours depuis peu : elle appartient à un processus vivant", async () => {
    const t = traceur();
    const id = await creerMission([{ key: "a", title: "A", capability: "directory_list" }], "étape vivante");
    await prisma.missionStep.updateMany({
      where: { missionId: id, key: "a" }, data: { status: "RUNNING", startedAt: new Date() },
    });

    const r = await avancer(id, actor, { runner: t.runner });
    expect(t.appels).toHaveLength(0);
    expect(r.enPause).toBe(true);
  });

  it("réessaie une étape échouée tant qu'il lui reste des tentatives, puis s'arrête", async () => {
    let essais = 0;
    const t = traceur({
      echouer: () => { essais += 1; return { kind: "PROVIDER_FAILURE", message: "503", retryable: true }; },
    });
    const id = await creerMission([
      { key: "a", title: "A", capability: "directory_list", maxAttempts: 3 },
    ], "retry borné");

    await avancer(id, actor, { runner: t.runner });
    expect(essais).toBe(3);
    const etat = await chargerEtat(id);
    expect(etat!.steps[0].status).toBe("FAILED");
    expect(etat!.steps[0].attempt).toBe(3);
  });

  it("un échec NON rejouable épuise ses tentatives d'un coup : réessayer un droit manquant ne l'obtient pas", async () => {
    let essais = 0;
    const t = traceur({
      echouer: () => { essais += 1; return { kind: "MISSING_PERMISSION", message: "interdit", retryable: false }; },
    });
    const id = await creerMission([
      { key: "a", title: "A", capability: "directory_list", maxAttempts: 5 },
    ], "échec définitif");

    await avancer(id, actor, { runner: t.runner });
    expect(essais).toBe(1);
    expect((await chargerEtat(id))!.steps[0].errorKind).toBe("MISSING_PERMISSION");
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * §37 — LA BRANCHE BLOQUÉE NE BLOQUE PAS LA MISSION.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  it("une branche en attente d'approbation n'empêche pas l'autre branche d'avancer", async () => {
    const t = traceur();
    const id = await creerMission([
      { key: "porte", title: "Approbation", nodeType: "APPROVAL" },
      { key: "envoi", title: "Envoi", capability: "send_message", input: { to: "x" }, dependsOn: ["porte"] },
      { key: "b1", title: "B1", capability: "directory_list" },
      { key: "b2", title: "B2", capability: "employee_360", dependsOn: ["b1"] },
    ], "deux branches");

    const r = await avancer(id, actor, { runner: t.runner });
    const etat = await chargerEtat(id);
    const parCle = new Map(etat!.steps.map((s) => [s.key, s]));

    // La branche libre est allée AU BOUT pendant que l'autre attendait.
    expect(parCle.get("b1")!.status).toBe("DONE");
    expect(parCle.get("b2")!.status).toBe("DONE");
    expect(parCle.get("porte")!.status).toBe("WAITING");
    expect(parCle.get("envoi")!.status).toBe("PENDING");
    // Et la mission se dit en attente d'accord, ce qui est la vérité une fois l'autre branche finie.
    expect(r.status).toBe("AWAITING_APPROVAL");
  });

  it("une porte d'approbation sans gestionnaire ATTEND — elle ne s'ouvre jamais toute seule", async () => {
    const t = traceur();
    const id = await creerMission([
      { key: "porte", title: "Approbation", nodeType: "APPROVAL" },
      { key: "envoi", title: "Envoi", capability: "send_email", input: { to: "a@x.dz" }, dependsOn: ["porte"] },
    ], "porte fermée par défaut");

    await avancer(id, actor, { runner: t.runner });
    expect(t.appels.filter((a) => a.capability === "send_email")).toHaveLength(0);
  });

  it("une porte accordée laisse passer la suite", async () => {
    const t = traceur();
    const handlers: StepHandlers = {
      APPROVAL: async () => ({ status: "DONE", result: { accorde: true } }),
    };
    const id = await creerMission([
      { key: "porte", title: "Approbation", nodeType: "APPROVAL" },
      { key: "envoi", title: "Envoi", capability: "send_email", input: { to: "a@x.dz" }, dependsOn: ["porte"] },
    ], "porte accordée");

    await avancer(id, actor, { runner: t.runner, handlers });
    expect(t.appels.filter((a) => a.capability === "send_email")).toHaveLength(1);
  });

  it("§16 — une attente d'événement met la mission en sommeil sans consommer d'appel", async () => {
    const t = traceur();
    const id = await creerMission([
      { key: "a", title: "A", capability: "directory_list" },
      {
        key: "attente", title: "Réponse de Redouane", nodeType: "WAIT_EVENT", dependsOn: ["a"],
        waitFor: { event: "EMAIL_RECEIVED", from: "redouane", withinDays: 5 },
      },
      { key: "suite", title: "Suite", capability: "inspect_record", dependsOn: ["attente"] },
    ], "attente d'événement");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.status).toBe("WAITING_EVENT");
    expect(r.enPause).toBe(true);
    expect(t.appels.map((a) => a.stepKey)).toEqual(["a"]);
  });

  it("§79 — une attente humaine se distingue d'une attente d'événement", async () => {
    const t = traceur();
    const id = await creerMission([
      { key: "w", title: "Le contrat de Redouane", nodeType: "WAIT_INPUT", waitFor: { ask: "le contrat signé" } },
    ], "attente humaine");
    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.status).toBe("WAITING_INPUT");
  });

  it("un échec définitif au milieu laisse une mission PARTIELLE, jamais réussie", async () => {
    const t = traceur({
      echouer: (c) => (c.stepKey === "b" ? { kind: "CAPABILITY_FAILURE", message: "cassé", retryable: false } : null),
    });
    const id = await creerMission([
      { key: "a", title: "A", capability: "directory_list" },
      { key: "b", title: "B", capability: "employee_360" },
      { key: "c", title: "C", capability: "inspect_record" },
    ], "échec partiel");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.status).toBe("PARTIAL");
    expect(r.echouees).toBe(1);
    expect(r.executees).toBe(2);
  });

  it("un éventail dont une itération échoue rend le modèle PARTIEL, pas réussi (§22)", async () => {
    const gens = Array.from({ length: 5 }, (_, i) => ({ id: `g-${i}` }));
    const t = traceur({
      sortie: (c) => (c.stepKey === "liste" ? { gens } : { ok: true }),
      echouer: (c) => (c.input.to === "g-3"
        ? { kind: "CAPABILITY_FAILURE", message: "adresse invalide", retryable: false } : null),
    });
    const id = await creerMission([
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "msg", title: "Msg", capability: "send_message",
        forEach: { from: "liste", path: "gens", as: "g" }, input: { to: "{{g.id}}" },
      },
    ], "éventail partiel");

    await avancer(id, actor, { runner: t.runner });
    const etat = await chargerEtat(id);
    const modele = etat!.steps.find((s) => s.key === "msg")!;
    expect(modele.status).toBe("FAILED");
    expect(modele.errorKind).toBe("PARTIAL_FANOUT");
    expect((modele.result as { done: number }).done).toBe(4);
    // Les quatre autres sont bel et bien parties : un échec n'annule pas ce qui a réussi.
    expect(etat!.steps.filter((s) => s.key.startsWith("msg#") && s.status === "DONE")).toHaveLength(4);
  }, 30_000);

  it("un éventail de LECTURE partiellement échoué CONCLUT, ses manques NOMMÉS — une absence dite est une réponse (§28)", async () => {
    const docs = Array.from({ length: 3 }, (_, i) => ({ id: `d-${i}` }));
    const t = traceur({
      sortie: (c) => (c.stepKey === "liste" ? { docs } : { contenu: "…" }),
      echouer: (c) => (c.input.reference === "d-1"
        ? { kind: "MISSING_DOCUMENT", message: "l'objet n'existe pas (404)", retryable: false } : null),
    });
    const id = await creerMission([
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "lire", title: "Lire", capability: "inspect_record",
        forEach: { from: "liste", path: "docs", as: "d" }, input: { reference: "{{d.id}}" },
      },
    ], "éventail de lecture partiel");

    await avancer(id, actor, { runner: t.runner });
    const etat = await chargerEtat(id);
    const modele = etat!.steps.find((s) => s.key === "lire")!;
    // La lecture manquée n'est PAS une dette : le modèle conclut, et son résultat DIT le manque.
    expect(modele.status).toBe("DONE");
    const r = modele.result as { done: number; failed: number; echecs: { key: string; error: string }[] };
    expect(r.done).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.echecs).toHaveLength(1);
    expect(r.echecs[0].key).toBe("lire#d-1");
    expect(r.echecs[0].error).toContain("404");
  }, 30_000);

  it("un WORKER sans exécutant échoue franchement, il n'est pas silencieusement ignoré", async () => {
    const t = traceur();
    // L'étape de lecture n'est pas décorative : le compilateur refuse un plan fait UNIQUEMENT de
    // travaux de modèle (il ne pourrait répondre que de mémoire). Elle ne change rien à ce qui est
    // testé ici — le WORKER reste sans exécutant, et c'est lui qu'on regarde.
    const id = await creerMission([
      { key: "src", title: "Lire l'annuaire", capability: "directory_list" },
      { key: "w", title: "Rédiger", nodeType: "WORKER", dependsOn: ["src"] },
    ], "worker absent");
    await avancer(id, actor, { runner: t.runner });
    const etat = await chargerEtat(id);
    const w = etat!.steps.find((s) => s.key === "w")!;
    expect(w.status).toBe("FAILED");
    expect(w.errorKind).toBe("MISSING_WORKER");
  });

  it("un WORKER branché rend un résultat structuré que la suite peut lire", async () => {
    const t = traceur();
    const handlers: StepHandlers = {
      WORKER: async (ctx) => ({ status: "DONE", result: { texte: `rédigé pour ${ctx.step.key}` } }),
    };
    const id = await creerMission([
      { key: "w", title: "Rédiger", nodeType: "WORKER", modelRole: "cheap" },
      { key: "s", title: "Suite", capability: "inspect_record", dependsOn: ["w"] },
    ], "worker branché");

    await avancer(id, actor, { runner: t.runner, handlers });
    const etat = await chargerEtat(id);
    expect((etat!.steps.find((s) => s.key === "w")!.result as { texte: string }).texte).toContain("rédigé");
    expect(etat!.steps.find((s) => s.key === "s")!.status).toBe("DONE");
  });

  it("le journal raconte la mission — et c'est MissionEvent, pas un second registre (§17)", async () => {
    const t = traceur();
    const id = await creerMission([
      { key: "a", title: "A", capability: "directory_list" },
    ], "journal");
    await avancer(id, actor, { runner: t.runner });

    const events = await prisma.missionEvent.findMany({ where: { missionId: id }, orderBy: { at: "asc" } });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("PLAN_COMPILED");
    expect(kinds).toContain("STEP_DONE");
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * §20 — LA CONCLUSION. « Plus rien à faire » n'est pas « objectif atteint ».
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  it("tout vert SANS JUGE : la mission ne se déclare PAS terminée", async () => {
    const t = traceur();
    const id = await creerMission([
      { key: "a", title: "A", capability: "directory_list" },
      { key: "b", title: "B", capability: "inspect_record", dependsOn: ["a"] },
    ], "sans juge");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.executees).toBe(2);
    expect(r.status).not.toBe("COMPLETED");

    const m = await prisma.mission.findUnique({
      where: { id }, select: { qaPassed: true, goalSatisfied: true, goalVerdict: true },
    });
    // Le contrôle arithmétique PASSE — on ne le cache pas. C'est la VÉRIFICATION qui manque.
    expect(m!.qaPassed).toBe(true);
    expect(m!.goalSatisfied).toBe(false);
    expect(m!.goalVerdict).toMatch(/aucun juge/);
  });

  it("tout vert ET un juge convaincu : la mission conclut, et seulement alors", async () => {
    const t = traceur();
    const id = await creerMission([
      { key: "a", title: "A", capability: "directory_list" },
    ], "avec juge");

    const r = await avancer(id, actor, {
      runner: t.runner,
      juge: { juger: async () => ({ satisfait: true, raison: "la liste demandée a été produite" }) },
    });
    expect(r.status).toBe("COMPLETED");
    const m = await prisma.mission.findUnique({
      where: { id }, select: { status: true, goalSatisfied: true, closedAt: true },
    });
    expect(m!.status).toBe("COMPLETED");
    expect(m!.goalSatisfied).toBe(true);
    expect(m!.closedAt).not.toBeNull();
  });

  it("§76 — un juge qui dit NON empêche de conclure, même tout vert", async () => {
    const t = traceur();
    const id = await creerMission([
      { key: "a", title: "A", capability: "directory_list" },
    ], "juge défavorable");

    const r = await avancer(id, actor, {
      runner: t.runner,
      juge: { juger: async () => ({ satisfait: false, raison: "la liste ne couvre pas l'entité demandée" }) },
    });
    expect(r.status).not.toBe("COMPLETED");
    const m = await prisma.mission.findUnique({ where: { id }, select: { goalVerdict: true } });
    expect(m!.goalVerdict).toMatch(/ne couvre pas l'entité/);
  });

  it("un manque IDENTIFIÉ rend la mission PARTIELLE — et le journal dit quoi réparer", async () => {
    const t = traceur({
      echouer: (c) => (c.stepKey === "b" ? { kind: "CAPABILITY_FAILURE", message: "cassé", retryable: false } : null),
    });
    const id = await creerMission([
      { key: "a", title: "A", capability: "directory_list" },
      { key: "b", title: "B", capability: "employee_360" },
    ], "manque identifié");

    const r = await avancer(id, actor, {
      runner: t.runner,
      juge: { juger: async () => ({ satisfait: true, raison: "tout va bien" }) },
    });
    // LE JUGE A BEAU DIRE OUI : l'arithmétique dit non, et elle a le dernier mot.
    expect(r.status).toBe("PARTIAL");

    const evt = await prisma.missionEvent.findFirst({
      where: { missionId: id, kind: "GOAL_UNSATISFIED" },
    });
    expect(evt).not.toBeNull();
    expect((evt!.detail as { aReparer: string[] }).aReparer).toEqual(["b"]);
  });

  it("relancer le moteur sur une mission terminée ne fait rien", async () => {
    const t = traceur();
    const id = await creerMission([{ key: "a", title: "A", capability: "directory_list" }], "déjà finie");
    await avancer(id, actor, { runner: t.runner });
    await prisma.mission.update({ where: { id }, data: { status: "COMPLETED" } });

    const t2 = traceur();
    const r = await avancer(id, actor, { runner: t2.runner });
    expect(t2.appels).toHaveLength(0);
    expect(r.status).toBe("COMPLETED");
    /**
     * PLAFOND LOCAL, MESURÉ (§118.124b, §118.135) : ce cas fait tourner le VRAI moteur sur la VRAIE
     * base — 70 ms seul (le fichier entier en 6,0 s) — et il a dépassé les 20 000 ms globales sous la
     * suite complète (754 fichiers, quatre cœurs, le fichier en 61,1 s). Le plafond répond à
     * « est-il bloqué ? », jamais à « est-il lent ? » : un moteur qui ne rend pas la main échoue
     * toujours, un peu plus tard.
     */
  }, 60_000);

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════
   * LE PLAN MORT-NÉ — mesuré live (chaîne regulatory, mission cmtsdqc17…).
   *
   * Un envoi échoue, ses tentatives sont épuisées. Le plan v2 le REPREND et accroche tout le
   * reste dessus. Avant correction, l'upsert laissait la ligne en FAILED : une étape FAILED ne
   * se termine jamais, ses dépendantes ne deviennent jamais READY, et un plan de dix-huit
   * étapes n'avait PAS UNE racine exécutable. La mission tournait BLOCKED sans un seul appel.
   * ═════════════════════════════════════════════════════════════════════════════════════════
   */
  it("une étape en ÉCHEC que le nouveau plan REPREND est réarmée — sinon tout ce qui en dépend est mort", async () => {
    const steps: PlannedStep[] = [
      { key: "envoi", title: "Envoi", capability: "send_message", input: { to: "x" } },
      { key: "suite", title: "Suite", capability: "inspect_record", dependsOn: ["envoi"] },
    ];
    const id = await creerMission(steps, "plan mort-né");

    // L'envoi échoue DÉFINITIVEMENT : plus aucune tentative.
    const t = traceur({ echouer: (c) => (c.stepKey === "envoi" ? { kind: "VALIDATION", message: "destinataire illisible", retryable: false } : null) });
    await avancer(id, actor, { runner: t.runner });
    const apres = await chargerEtat(id);
    expect(apres!.steps.find((x) => x.key === "envoi")!.status).toBe("FAILED");
    expect(apres!.steps.find((x) => x.key === "suite")!.status).toBe("PENDING");

    // LE PLAN v2 REPREND l'envoi et y accroche une nouvelle étape.
    const v2: PlannedStep[] = [
      { key: "envoi", title: "Envoi (corrigé)", capability: "send_message", input: { to: "y" } },
      { key: "suite", title: "Suite", capability: "inspect_record", dependsOn: ["envoi"] },
    ];
    const plan: MissionPlan = { objective: "plan mort-né", acceptance: ["fait"], complexity: "B", scale: "M", steps: v2 };
    const r = compile(plan, catalogue, actor);
    if (!r.ok) throw new Error("plan refusé");
    await materialiser(r.mission, { ownerId, title: "plan mort-né", goalRaw: "plan mort-né", missionId: id });

    const rearme = await chargerEtat(id);
    const envoi = rearme!.steps.find((x) => x.key === "envoi")!;
    expect(envoi.status).toBe("PENDING");
    expect(envoi.attempt).toBe(0);
    expect(envoi.title).toBe("Envoi (corrigé)");

    // ET LE PLAN v2 TOURNE VRAIMENT : les deux étapes sont APPELÉES et ABOUTISSENT. C'est ce
    // qui distingue un plan vivant d'un plan mort-né — pas le statut final de la mission, qui
    // dépend du juge d'objectif (absent de ce banc, §118.10).
    const t2 = traceur();
    await avancer(id, actor, { runner: t2.runner });
    expect(t2.appels.map((c) => c.stepKey).sort()).toEqual(["envoi", "suite"]);
    const fini = await chargerEtat(id);
    expect(fini!.steps.filter((x) => x.status === "DONE").map((x) => x.key).sort()).toEqual(["envoi", "suite"]);
    /**
     * PLAFOND LOCAL, MESURÉ (§118.124b, §118.135) : ce cas fait tourner le VRAI moteur sur la VRAIE
     * base — 190 ms seul (le fichier entier en 6,0 s) — et il a dépassé les 20 000 ms globales sous la
     * suite complète (754 fichiers, quatre cœurs, le fichier en 61,1 s). Le plafond répond à
     * « est-il bloqué ? », jamais à « est-il lent ? » : un moteur qui ne rend pas la main échoue
     * toujours, un peu plus tard.
     */
  }, 60_000);

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════
   * LE MÊME TROU, SUR L'AUTRE STATUT TERMINAL-MAIS-VIDE (§118.67).
   *
   * SKIPPED figurait parmi les ACQUIS, avec la justification de DONE — « pas de second
   * envoi ». Elle est fausse : une étape ignorée n'a JAMAIS envoyé. Le moteur écarte AVANT
   * d'exécuter, dans les quatre cas qui produisent ce statut.
   *
   * MESURÉ, mission `cmttakgtd…` : les deux étapes ARTIFACT sont ignorées parce que la
   * complétude des données amont vaut `false`. Gelées, elles ne peuvent plus revenir — le
   * plan suivant, celui que le compilateur vient d'obliger à retirer la condition, les
   * retrouve terminales et le livrable est mort pour toujours. Sans étape en échec, donc
   * sans que rien ne le dise.
   * ═════════════════════════════════════════════════════════════════════════════════════════
   */
  it("une étape IGNORÉE que le nouveau plan REPREND est réarmée — il ne s'était rien passé", async () => {
    const conditionnel: PlannedStep[] = [
      { key: "lire", title: "Lire les retours", capability: "directory_list" },
      {
        key: "produire", title: "Produire le registre", capability: "inspect_record", dependsOn: ["lire"],
        when: { step: "lire", path: "donneesCompletes", op: "eq", value: "true" },
      } as unknown as PlannedStep,
    ];
    const id = await creerMission(conditionnel, "livrable conditionnel");

    // La personne n'a pas tout donné : la condition est FAUSSE, l'étape est ignorée.
    const t = traceur({ sortie: (c) => (c.stepKey === "lire" ? { donneesCompletes: false } : { ok: true }) });
    await avancer(id, actor, { runner: t.runner });
    const apres = await chargerEtat(id);
    expect(apres!.steps.find((x) => x.key === "produire")!.status).toBe("SKIPPED");
    expect(t.appels.map((c) => c.stepKey)).toEqual(["lire"]);

    // LE PLAN v2 — celui que le compilateur oblige à écrire — REPREND le livrable SANS condition.
    const v2: PlannedStep[] = [
      { key: "lire", title: "Lire les retours", capability: "directory_list" },
      { key: "produire", title: "Produire le registre (ce qu'on a)", capability: "inspect_record", dependsOn: ["lire"] },
    ];
    const plan: MissionPlan = { objective: "livrable conditionnel", acceptance: ["fait"], complexity: "B", scale: "M", steps: v2 };
    const r = compile(plan, catalogue, actor);
    if (!r.ok) throw new Error("plan refusé");
    await materialiser(r.mission, { ownerId, title: "livrable conditionnel", goalRaw: "livrable conditionnel", missionId: id });

    const rearme = await chargerEtat(id);
    const produire = rearme!.steps.find((x) => x.key === "produire")!;
    expect(produire.status).toBe("PENDING");
    expect(produire.title).toBe("Produire le registre (ce qu'on a)");
    // LA CONDITION A DISPARU AVEC LE RAFRAÎCHISSEMENT : une étape réarmée reprend la spec du
    // plan courant, sinon elle serait ignorée de nouveau sur la condition d'un plan périmé.
    expect((produire.spec as { when?: unknown } | null)?.when).toBeUndefined();
    // L'ACQUIS RESTE ACQUIS : `lire` a abouti, elle n'est pas rejouée.
    expect(rearme!.steps.find((x) => x.key === "lire")!.status).toBe("DONE");

    // ET LE LIVRABLE EST RÉELLEMENT PRODUIT : c'est la seule chose qui compte pour le dirigeant.
    const t2 = traceur();
    await avancer(id, actor, { runner: t2.runner });
    expect(t2.appels.map((c) => c.stepKey)).toEqual(["produire"]);
    const fini = await chargerEtat(id);
    expect(fini!.steps.find((x) => x.key === "produire")!.status).toBe("DONE");
  });

  /**
   * ET LE RÉARMEMENT NE RELANCE PAS UNE BRANCHE À TORT. La condition est RÉÉVALUÉE sur l'état
   * amont COURANT : une relance ignorée parce que la personne avait répondu est ignorée de
   * nouveau — pour un test pur, sans appel de modèle et sans message parti.
   */
  it("une étape réarmée dont la condition est toujours fausse est ignorée de nouveau, sans effet", async () => {
    const steps: PlannedStep[] = [
      { key: "lire", title: "Lire", capability: "directory_list" },
      {
        key: "relancer", title: "Relancer", capability: "send_message", input: { to: "x" }, dependsOn: ["lire"],
        when: { step: "lire", path: "sansReponse", op: "eq", value: "true" },
      } as unknown as PlannedStep,
    ];
    const id = await creerMission(steps, "relance conditionnelle");
    const t = traceur({ sortie: (c) => (c.stepKey === "lire" ? { sansReponse: false } : { ok: true }) });
    await avancer(id, actor, { runner: t.runner });
    expect((await chargerEtat(id))!.steps.find((x) => x.key === "relancer")!.status).toBe("SKIPPED");

    const plan: MissionPlan = { objective: "relance conditionnelle", acceptance: ["fait"], complexity: "B", scale: "M", steps };
    const r = compile(plan, catalogue, actor);
    if (!r.ok) throw new Error("plan refusé");
    await materialiser(r.mission, { ownerId, title: "relance conditionnelle", goalRaw: "relance", missionId: id });

    const t2 = traceur();
    await avancer(id, actor, { runner: t2.runner });
    // AUCUN ENVOI. La branche est ré-évaluée et ré-écartée : c'est un test pur, pas un effet.
    expect(t2.appels.map((c) => c.stepKey)).toEqual([]);
    expect((await chargerEtat(id))!.steps.find((x) => x.key === "relancer")!.status).toBe("SKIPPED");
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════
   * UNE FILLE APPARTIENT AU JALON DE SA MÈRE (§118.68) — sinon le travail réel est invisible.
   *
   * MESURÉ LIVE, mission `cmttsao1f…`. Le jalon 1 s'appelle « les pièces réglementaires sont
   * officiellement SOLLICITÉES ». L'envoi est déployé en éventail, les deux filles partent et
   * aboutissent (« Message envoyé à Amel Haddad »). Le juge du jalon ne charge que les étapes
   * portant son `milestoneId` — la MÈRE, jamais les filles — et `attestationEffets` a conclu,
   * honnêtement, « AUCUNE écriture et AUCUN envoi ». Le jalon a été refusé DEUX FOIS pour
   * avoir fait exactement ce qu'on lui demandait.
   * ═════════════════════════════════════════════════════════════════════════════════════════
   */
  it("les filles d'un ÉVENTAIL portent le jalon de leur mère — c'est là que vit le travail réel", async () => {
    const steps: PlannedStep[] = [
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "msg", title: "Msg", capability: "send_message",
        forEach: { from: "liste", path: "employes", as: "e" }, input: { to: "{{e.id}}" },
        dependsOn: ["liste"],
      } as unknown as PlannedStep,
    ];
    const id = await creerMission(steps, "éventail et jalon");

    // La mère porte un jalon — comme après une compilation paresseuse (`opts.milestoneId`).
    const jalon = await prisma.missionMilestone.create({
      data: { missionId: id, ordre: 1, titre: "Sollicitations parties", resultat: "les demandes sont envoyées" },
    });
    await prisma.missionStep.updateMany({ where: { missionId: id, key: "msg" }, data: { milestoneId: jalon.id } });

    const t = traceur({ sortie: (c) => (c.stepKey === "liste" ? { employes: [{ id: "e1" }, { id: "e2" }] } : { ok: true }) });
    await avancer(id, actor, { runner: t.runner });

    const filles = await prisma.missionStep.findMany({
      where: { missionId: id, key: { startsWith: "msg#" } },
      select: { key: true, milestoneId: true, status: true },
    });
    expect(filles).toHaveLength(2);
    // CE QUI FERAIT TOMBER CE TEST : recréer une fille sans `milestoneId`. Le juge du jalon
    // relirait alors un registre d'effets VIDE et refuserait un jalon qui a réussi.
    for (const f of filles) expect(f.milestoneId, f.key).toBe(jalon.id);
    expect(filles.every((f) => f.status === "DONE")).toBe(true);
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════
   * UNE LISTE DE NOMS EST UNE LISTE DE PERSONNES (§118.71) — mesuré, mission `cmttukkqf…`.
   *
   * L'amont rend `["Amel Haddad", "Raihana Cherif"]` ; le plan écrit
   * `recipientName: "{{p.recipient}}"`. `JSON.stringify` effaçait la clé non résolue, la
   * capacité recevait une entrée AMPUTÉE, et refusait « Destinataire « (rien) » introuvable »
   * sur une itération nommée `#Amel Haddad`.
   * ═════════════════════════════════════════════════════════════════════════════════════════
   */
  it("un éventail sur une liste de NOMS transmet le nom — la clé ne disparaît pas", async () => {
    const steps: PlannedStep[] = [
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "msg", title: "Msg", capability: "send_message",
        forEach: { from: "liste", path: "destinataires", as: "p" },
        input: { to: "{{p.recipient}}", body: "Bonjour" }, dependsOn: ["liste"],
      } as unknown as PlannedStep,
    ];
    const id = await creerMission(steps, "éventail sur des noms");
    const t = traceur({
      sortie: (c) => (c.stepKey === "liste"
        ? { destinataires: ["Amel Haddad", "Raihana Cherif"] }
        : { ok: true }),
    });
    await avancer(id, actor, { runner: t.runner });

    const filles = await prisma.missionStep.findMany({
      where: { missionId: id, key: { startsWith: "msg#" } },
      select: { key: true, status: true, input: true },
      orderBy: { key: "asc" },
    });
    expect(filles.map((f) => f.key)).toEqual(["msg#Amel Haddad", "msg#Raihana Cherif"]);
    // CE QUI FERAIT TOMBER CE TEST : redescendre dans un scalaire pour rendre `undefined`.
    // La clé repartirait au néant et la capacité accuserait de nouveau l'annuaire.
    for (const f of filles) {
      const entree = f.input as { to?: unknown; body?: unknown };
      expect(entree.to, f.key).toBe(f.key.slice("msg#".length));
      expect(f.status, f.key).toBe("DONE");
    }
    // ET L'ENVOI A RÉELLEMENT ÉTÉ APPELÉ, avec le bon destinataire — c'est la seule chose qui
    // compte pour les deux personnes qui, en live, n'ont jamais reçu leur demande.
    expect(t.appels.filter((c) => c.stepKey.startsWith("msg#")).map((c) => (c.input as { to?: string }).to).sort())
      .toEqual(["Amel Haddad", "Raihana Cherif"]);
  });

  /**
   * ET SUR UN OBJET, ON NE DEVINE PAS — on échoue AVANT de payer l'appel, en nommant les
   * champs que l'élément porte vraiment (règle 20 du planificateur, enfin tenue).
   */
  it("un chemin absent d'un élément OBJET fait échouer l'itération avant l'appel, en le disant", async () => {
    const steps: PlannedStep[] = [
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "msg", title: "Msg", capability: "send_message",
        forEach: { from: "liste", path: "gens", as: "p" },
        input: { to: "{{p.recipient}}", body: "Bonjour" }, dependsOn: ["liste"],
      } as unknown as PlannedStep,
    ];
    const id = await creerMission(steps, "éventail chemin faux");
    const t = traceur({
      sortie: (c) => (c.stepKey === "liste"
        ? { gens: [{ nom: "Amel Haddad", email: "amel@x.dz" }] }
        : { ok: true }),
    });
    await avancer(id, actor, { runner: t.runner });

    const fille = await prisma.missionStep.findFirst({
      where: { missionId: id, key: { startsWith: "msg#" } },
      select: { key: true, status: true, error: true, attempt: true, maxAttempts: true },
    });
    expect(fille?.status).toBe("FAILED");
    expect(fille?.error).toContain("{{p.recipient}}");
    expect(fille?.error).toContain("nom, email");
    expect(fille?.error).toContain("{{p}}");
    // DÉFINITIF : réessayer ne fera pas apparaître un champ que l'élément n'a pas.
    expect(fille!.attempt).toBeGreaterThanOrEqual(fille!.maxAttempts);
    // ET AUCUN APPEL DE CAPACITÉ N'A ÉTÉ PAYÉ pour une itération qui ne pouvait qu'échouer.
    expect(t.appels.filter((c) => c.stepKey.startsWith("msg#"))).toHaveLength(0);
  });

  /**
   * ET LE CONTOURNEMENT NE LES EMPORTE PAS. Leur `milestoneId` les fait entrer dans le
   * périmètre de `materialiser` (§118.43) ; un plan ne LISTE jamais une fille, donc sans garde
   * chaque replan la marquerait contournée, elle disparaîtrait du comptage de sa mère, et
   * l'éventail recompterait « 0/2 » sur deux envois réellement partis.
   */
  it("un replan ne contourne PAS les filles d'un éventail que la mère reprend", async () => {
    const steps: PlannedStep[] = [
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "msg", title: "Msg", capability: "send_message",
        forEach: { from: "liste", path: "employes", as: "e" }, input: { to: "{{e.id}}" },
        dependsOn: ["liste"],
      } as unknown as PlannedStep,
    ];
    const id = await creerMission(steps, "éventail et contournement");
    const jalon = await prisma.missionMilestone.create({
      data: { missionId: id, ordre: 1, titre: "Envois", resultat: "les demandes sont envoyées" },
    });
    await prisma.missionStep.updateMany({ where: { missionId: id, key: "msg" }, data: { milestoneId: jalon.id } });

    const t = traceur({ sortie: (c) => (c.stepKey === "liste" ? { employes: [{ id: "e1" }, { id: "e2" }] } : { ok: true }) });
    await avancer(id, actor, { runner: t.runner });

    const plan: MissionPlan = { objective: "éventail et contournement", acceptance: ["fait"], complexity: "B", scale: "M", steps };
    const r = compile(plan, catalogue, actor);
    if (!r.ok) throw new Error("plan refusé");
    await materialiser(r.mission, {
      ownerId, title: "éventail et contournement", goalRaw: "éventail", missionId: id, milestoneId: jalon.id,
    });

    const filles = await prisma.missionStep.findMany({
      where: { missionId: id, key: { startsWith: "msg#" } },
      select: { key: true, supersededAt: true },
    });
    expect(filles).toHaveLength(2);
    for (const f of filles) expect(f.supersededAt, f.key).toBeNull();
    /**
     * PLAFOND LOCAL, MESURÉ (§118.124b) : ce cas fait tourner le VRAI moteur sur la VRAIE base
     * — un éventail, un jalon, une rematérialisation — en ~1 s seul (le fichier entier en 8,4 s),
     * et il a dépassé les 20 000 ms globales sous la suite complète (744 fichiers, quatre cœurs,
     * le fichier en 44,9 s). Le plafond répond à « est-il bloqué ? », jamais à « est-il lent ? » :
     * un moteur qui ne rend pas la main échoue toujours, un peu plus tard.
     */
  }, 60_000);

  /**
   * LE MÊME TROU, UN CRAN PLUS BAS. La mère réarmée redéploie et retrouve ses FILLES en échec,
   * figées au plan précédent : elles ne se termineraient jamais, la mère les attendrait, et le
   * regroupement recompterait 0/1 — la mission remourrait exactement comme avant.
   */
  it("un ÉVENTAIL réarmé reprend ses filles en échec, et garde ses filles abouties", async () => {
    const steps: PlannedStep[] = [
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "msg", title: "Msg", capability: "send_message",
        forEach: { from: "liste", path: "employes", as: "e" }, input: { to: "{{e.id}}" },
      },
    ];
    const gens = { employes: [{ id: "u1" }, { id: "u2" }] };
    // u1 aboutit, u2 échoue définitivement.
    const t = traceur({
      sortie: (c) => (c.stepKey === "liste" ? gens : { ok: true }),
      echouer: (c) => (c.stepKey.endsWith("#u2") ? { kind: "VALIDATION", message: "destinataire illisible", retryable: false } : null),
    });
    const id = await creerMission(steps, "éventail mort-né");
    await avancer(id, actor, { runner: t.runner });
    const apres = await chargerEtat(id);
    expect(apres!.steps.find((x) => x.key === "msg#u1")!.status).toBe("DONE");
    expect(apres!.steps.find((x) => x.key === "msg#u2")!.status).toBe("FAILED");

    // PLAN v2 : il reprend l'éventail.
    const plan: MissionPlan = { objective: "éventail mort-né", acceptance: ["fait"], complexity: "B", scale: "M", steps };
    const r = compile(plan, catalogue, actor);
    if (!r.ok) throw new Error("plan refusé");
    await materialiser(r.mission, { ownerId, title: "éventail mort-né", goalRaw: "éventail mort-né", missionId: id });

    const t2 = traceur({ sortie: (c) => (c.stepKey === "liste" ? gens : { ok: true }) });
    await avancer(id, actor, { runner: t2.runner });
    const fin = await chargerEtat(id);
    expect(fin!.steps.find((x) => x.key === "msg#u2")!.status).toBe("DONE");
    // L'ACQUIS N'EST PAS REJOUÉ : u1 n'a pas reçu de second message.
    expect(t2.appels.filter((c) => c.stepKey === "msg#u1")).toHaveLength(0);
    expect(t2.appels.filter((c) => c.stepKey === "msg#u2")).toHaveLength(1);
  });

  it("une étape ABOUTIE que le nouveau plan reprend n'est JAMAIS rejouée (pas de second envoi)", async () => {
    const steps: PlannedStep[] = [{ key: "envoi", title: "Envoi", capability: "send_message", input: { to: "x" } }];
    const id = await creerMission(steps, "acquis préservé");
    const t = traceur();
    await avancer(id, actor, { runner: t.runner });
    expect(t.appels).toHaveLength(1);

    const plan: MissionPlan = { objective: "acquis préservé", acceptance: ["fait"], complexity: "B", scale: "M", steps };
    const r = compile(plan, catalogue, actor);
    if (!r.ok) throw new Error("plan refusé");
    await materialiser(r.mission, { ownerId, title: "acquis préservé", goalRaw: "acquis préservé", missionId: id });

    const etat = await chargerEtat(id);
    expect(etat!.steps.find((x) => x.key === "envoi")!.status).toBe("DONE");
    const t2 = traceur();
    await avancer(id, actor, { runner: t2.runner });
    expect(t2.appels).toHaveLength(0);
  });

  it("une recompilation du MÊME plan ne duplique aucune étape et n'en rejoue aucune", async () => {
    const t = traceur();
    const steps: PlannedStep[] = [
      { key: "a", title: "A", capability: "send_message", input: { to: "x" } },
      { key: "b", title: "B", capability: "inspect_record", dependsOn: ["a"] },
    ];
    const id = await creerMission(steps, "replan");
    await avancer(id, actor, { runner: t.runner });
    expect(t.appels).toHaveLength(2);

    // LE REPLAN : même plan, même mission.
    const plan: MissionPlan = {
      objective: "replan", acceptance: ["fait"], complexity: "B", scale: "M", steps,
    };
    const r = compile(plan, catalogue, actor);
    if (!r.ok) throw new Error("plan refusé");
    await materialiser(r.mission, { ownerId, title: "replan", goalRaw: "replan", missionId: id });

    const t2 = traceur();
    await avancer(id, actor, { runner: t2.runner });
    expect(t2.appels).toHaveLength(0);

    const etat = await chargerEtat(id);
    expect(etat!.steps).toHaveLength(2);
    expect(etat!.planVersion).toBe(2);
    // Plafond LOCAL, comme ses voisins de ce fichier (§118.124b, §118.132) : ce cas fait tourner
    // le VRAI moteur sur la VRAIE base, donc il paie la contention de la base EN PLUS de celle du
    // processeur. MESURÉ : 503 ms seul, au-delà des 20 s globales sous 766 fichiers / 4 cœurs. Un
    // plafond répond à « est-il bloqué ? », jamais à « est-il lent ? » — et l'on ne relève pas le
    // global, qui garderait 8 800 tests moins sévèrement pour en réparer un.
  }, 60_000);
});
