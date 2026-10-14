import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import {
  createStockRecurrence, updateStockRecurrence, setStockRecurrenceStatus, deleteStockRecurrence,
} from "@/lib/actions/stock-recurrence-actions";
import { declencherRecurrencesStock } from "./recurrence-runner";
import { loadRecurrenceStock, loadRecurrencesStock } from "@/lib/queries/stock-recurrence";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__recstock__";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÉCURRENCES DE DEMANDE D'ÉTAT DE STOCK — par les VRAIS points d'entrée.
 *
 * Ce banc part des server actions de l'écran et du déclenchement du battement, jamais d'un état
 * injecté à la main : un test qui part d'une ligne écrite en base ne répond pas à la question
 * « si quelqu'un utilise le produit normalement, ce mécanisme peut-il produire un effet utile ? »
 * (§118.14). Et il lit la BASE pour juger, jamais le retour de la fonction : un compteur qui
 * s'incrémente sans tâche envoyée est le faux succès exact que ce lot ferme.
 *
 * ── CE QUI N'EST PAS SIMULÉ ──────────────────────────────────────────────────────────────
 *
 * L'horloge. `declencherRecurrencesStock(maintenant)` prend sa date en paramètre — c'est le
 * VRAI point d'entrée, avec son vrai argument. Repousser `nextRunAt` à la main en base aurait
 * testé une échéance que le calcul n'a pas produite.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

async function nettoyer() {
  // L'ORDRE COMPTE : supprimer un compte NULLIFIE ses lignes au lieu de les supprimer
  // (`onDelete: SetNull`), donc la poignée qui les retrouve disparaîtrait avant elles (§118.91).
  await prisma.stockRequestRecurrence.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.task.deleteMany({ where: { module: "STOCKS", createdBy: { email: { endsWith: `${TAG}.test` } } } });
  await prisma.notification.deleteMany({ where: { user: { email: { endsWith: `${TAG}.test` } } } });
  await prisma.auditLog.deleteMany({ where: { actor: { email: { endsWith: `${TAG}.test` } } } });
  await prisma.stockAnnex.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `${TAG}.test` } } });
}

function fd(entries: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
}

suite("RÉCURRENCE DE DEMANDE D'ÉTAT DE STOCK — de l'écran au battement", () => {
  let directeurId = "", kamId = "", hop1 = "", hop2 = "", annexeId = "";

  beforeAll(async () => {
    await nettoyer();
    // Le DIRECTEUR DES OPÉRATIONS : PCH MANAGE, et AUCUNE vue globale — c'est ce qui rend la
    // relecture d'autorité du battement réellement exerçable. Un acteur à vue globale la rendrait
    // vraie quoi qu'il arrive, et la garde serait une décoration (§118.104).
    const dir = await prisma.user.create({
      data: { name: `${TAG}Directeur Ops`, email: `dir.${TAG}.test`, passwordHash: "x", role: "LOGISTICS_MANAGER" },
    });
    const kam = await prisma.user.create({
      data: { name: `${TAG}Amel Haddad`, email: `kam.${TAG}.test`, passwordHash: "x", role: "MEDICAL_DELEGATE" },
    });
    // L'ORDRE DE CRÉATION EST L'INVERSE DE L'ORDRE ALPHABÉTIQUE, exprès.
    //
    // La première version créait « CHU Béjaïa » puis « EPH Akbou » : l'ordre de la base et
    // l'ordre trié coïncidaient, donc un tri PERDU était invisible — le sabotage qui le retirait
    // passait au vert (§118.111). « Zéralda » d'abord, « Akbou » ensuite : les deux ordres
    // divergent, et le tri devient une propriété qu'on peut faire tomber.
    const [h1, h2, an] = await Promise.all([
      prisma.stockAnnex.create({ data: { name: `${TAG}Zéralda`, kind: "HOSPITAL" } }),
      prisma.stockAnnex.create({ data: { name: `${TAG}Akbou`, kind: "HOSPITAL" } }),
      prisma.stockAnnex.create({ data: { name: `${TAG}Annexe Blida`, kind: "ANNEX" } }),
    ]);
    directeurId = dir.id; kamId = kam.id; hop1 = h1.id; hop2 = h2.id; annexeId = an.id;

    // LE CORPUS DOIT ÊTRE LE NÔTRE — et ici ce n'est pas seulement une question de mesure.
    //
    // `declencherRecurrencesStock` traite TOUTES les récurrences dues de la base : une récurrence
    // étrangère encore ACTIVE partirait avec les nôtres, et le banc adresserait une vraie demande
    // à une vraie personne dans la base de travail. On refuse plutôt que de mesurer au milieu du
    // voisinage (§118.102a), et le refus NOMME le geste.
    const etrangeres = await prisma.stockRequestRecurrence.count({
      where: { status: "ACTIVE", name: { not: { startsWith: TAG } } },
    });
    expect(
      etrangeres,
      "des récurrences ACTIVES étrangères à ce banc existent : ce banc les déclencherait "
      + "(vraie tâche, vraie notification, vraie personne). Mettez-les en pause avant de le lancer.",
    ).toBe(0);
  });

  afterAll(nettoyer);

  /**
   * LES DEMANDES QUE CETTE RÉCURRENCE A PRODUITES — jugées par le LIEN CAUSAL.
   *
   * `declencherRecurrencesStock` traite TOUTES les récurrences dues de la base : son bilan est un
   * compte GLOBAL, et l'asserter à « 1 » mesurait le VOISINAGE, pas ce lot — les récurrences que
   * les cas précédents avaient laissées vivantes partaient avec (§118.92). Le produit écrit le
   * nom de la récurrence dans la tâche ; c'est ce lien qu'on lit, jamais une ressemblance
   * d'assigné ou une fenêtre de temps (§118.36).
   */
  const demandesDe = (nom: string) =>
    prisma.task.count({ where: { module: "STOCKS", assignedToId: kamId, description: { contains: `${TAG}${nom}` } } });

  /** Retire la récurrence ET ce qu'elle a produit — sans quoi le cas suivant balaie ses restes. */
  const retirer = async (id: string) => {
    await prisma.stockRequestRecurrence.deleteMany({ where: { id } });
    await prisma.task.deleteMany({ where: { assignedToId: kamId } });
    await prisma.notification.deleteMany({ where: { userId: kamId } });
  };

  const poser = async (nom: string, extra: Record<string, string | string[]> = {}) => {
    ACTEUR = await acteur(directeurId, "LOGISTICS_MANAGER");
    const r = await createStockRecurrence(fd({
      name: `${TAG}${nom}`, assigneeId: kamId, recurrence: "MONTHLY", hourLocal: "8", dayOfMonth: "1",
      hospitalIds: [hop1, hop2], note: "Relevé mensuel des deux hôpitaux", ...extra,
    }));
    expect(r.ok, "error" in r ? String(r.error) : "").toBe(true);
    return (r as { ok: true; id: string }).id;
  };

  it("POSER → l'échéance est calculée, la cadence est lisible, rien n'est encore parti", async () => {
    const id = await poser("Relevé mensuel");
    const dto = await loadRecurrenceStock(id);
    expect(dto).not.toBeNull();
    expect(dto!.assigneeName).toContain("Amel Haddad");
    expect(dto!.hospitalNames).toHaveLength(2);
    expect(dto!.cadence).toMatch(/1er/);
    expect(dto!.status).toBe("ACTIVE");
    // POSER N'ENVOIE RIEN. Une récurrence qui déclencherait à la création surprendrait son
    // destinataire, et le compteur mentirait dès la première ligne.
    expect(dto!.runCount).toBe(0);
    expect(dto!.lastRunAt).toBeNull();
    expect(dto!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    const taches = await prisma.task.count({ where: { assignedToId: kamId } });
    expect(taches).toBe(0);
    await retirer(id);
  });

  it("L'ÉCHÉANCE ATTEINTE → une TÂCHE assignée, une NOTIFICATION, un AUDIT — et le compteur avance", async () => {
    const id = await poser("Relevé déclenché");
    const avant = await loadRecurrenceStock(id);
    const maintenant = new Date(avant!.nextRunAt.getTime() + 60_000);

    await declencherRecurrencesStock(maintenant);

    // ON JUGE LA BASE, pas le retour : « 1 déclenchée » sans tâche en base serait le faux succès.
    const taches = await prisma.task.findMany({
      where: { module: "STOCKS", assignedToId: kamId, description: { contains: `${TAG}Relevé déclenché` } },
    });
    expect(taches).toHaveLength(1);
    expect(taches[0]!.title).toContain("Zéralda");
    expect(taches[0]!.createdById).toBe(directeurId);
    // LA TÂCHE DIT D'OÙ ELLE VIENT — sans quoi le KAM ne sait pas à qui demander de l'arrêter.
    expect(taches[0]!.description ?? "").toContain("récurrence");

    const notifs = await prisma.notification.count({ where: { userId: kamId } });
    expect(notifs, "le KAM doit SAVOIR qu'on lui a demandé quelque chose").toBe(1);
    const audits = await prisma.auditLog.count({ where: { actorId: directeurId, entityType: "TASK" } });
    expect(audits).toBeGreaterThanOrEqual(1);

    const apres = await loadRecurrenceStock(id);
    expect(apres!.runCount).toBe(1);
    expect(apres!.lastRunAt).not.toBeNull();
    expect(apres!.nextRunAt.getTime()).toBeGreaterThan(maintenant.getTime());

    await retirer(id);
  });

  it("DEUX PASSAGES CONCURRENTS → UNE seule demande : le verrou tient", async () => {
    const id = await poser("Relevé concurrent");
    const dto = await loadRecurrenceStock(id);
    const maintenant = new Date(dto!.nextRunAt.getTime() + 60_000);

    // Le pire cas réel : deux battements se chevauchent. Une demande en DOUBLE ferait compter
    // deux fois un stock physique, et personne ne saurait laquelle est la bonne.
    await Promise.all([
      declencherRecurrencesStock(maintenant),
      declencherRecurrencesStock(maintenant),
    ]);

    expect(await demandesDe("Relevé concurrent"), "un relevé physique demandé deux fois est une demande de trop").toBe(1);
    expect((await loadRecurrenceStock(id))!.runCount).toBe(1);
    await retirer(id);
  });

  it("L'AUTEUR PERD L'AUTORITÉ → la récurrence est mise en PAUSE, pas supprimée, et rien ne part", async () => {
    const id = await poser("Relevé orphelin");
    const dto = await loadRecurrenceStock(id);
    const maintenant = new Date(dto!.nextRunAt.getTime() + 60_000);

    // Mutation : le directeur devient délégué médical — plus de PCH, plus de vue globale.
    await prisma.user.update({ where: { id: directeurId }, data: { role: "MEDICAL_DELEGATE" } });
    try {
      await declencherRecurrencesStock(maintenant);
      expect(
        await demandesDe("Relevé orphelin"),
        "une planification ne doit pas survivre à l'autorité de son auteur",
      ).toBe(0);

      const apres = await loadRecurrenceStock(id);
      // PAUSE ET NON SUPPRESSION : le directeur doit voir POURQUOI elle s'est arrêtée.
      expect(apres, "une suppression silencieuse effacerait la demande ET sa raison").not.toBeNull();
      expect(apres!.status).toBe("PAUSED");
      expect(apres!.runCount).toBe(0);
    } finally {
      await prisma.user.update({ where: { id: directeurId }, data: { role: "LOGISTICS_MANAGER" } });
      await retirer(id);
    }
  });

  it("UNE CADENCE ILLISIBLE EN BASE → PAUSE, jamais une boucle à chaque battement", async () => {
    const id = await poser("Relevé illisible");
    // HOURLY existe dans la grammaire partagée et n'est PAS admis pour une réquisition : c'est
    // exactement la valeur qu'une migration ou un import maladroit pourrait poser.
    await prisma.stockRequestRecurrence.update({ where: { id }, data: { recurrence: "HOURLY" } });
    const dto = await loadRecurrenceStock(id);
    expect(dto!.cadence).toContain("illisible");

    await declencherRecurrencesStock(new Date(dto!.nextRunAt.getTime() + 60_000));
    const apres = await loadRecurrenceStock(id);
    expect(apres!.status).toBe("PAUSED");
    expect(apres!.runCount).toBe(0);
    expect(await demandesDe("Relevé illisible")).toBe(0);
    await retirer(id);
  });

  it("SIX MOIS DE RETARD → UNE demande, pas six : ce qui n'a pas eu lieu à sa date n'a plus d'objet", async () => {
    const id = await poser("Relevé rattrapage");
    const dto = await loadRecurrenceStock(id);
    const sixMois = new Date(dto!.nextRunAt.getTime() + 6 * 31 * 24 * 3600_000);

    await declencherRecurrencesStock(sixMois);
    expect(await demandesDe("Relevé rattrapage"), "six occurrences manquées ne font pas six relevés").toBe(1);
    // Un second passage à la même date ne redonne rien : l'échéance est déjà repoussée.
    await declencherRecurrencesStock(sixMois);
    expect(await demandesDe("Relevé rattrapage")).toBe(1);

    const apres = await loadRecurrenceStock(id);
    expect(apres!.runCount).toBe(1);
    expect(apres!.nextRunAt.getTime()).toBeGreaterThan(sixMois.getTime());
    await retirer(id);
  });

  it("MODIFIER la cadence NE PERD PAS les hôpitaux ni le destinataire ; DÉCOCHER un hôpital le RETIRE", async () => {
    const id = await poser("Relevé modifié");
    ACTEUR = await acteur(directeurId, "LOGISTICS_MANAGER");

    // On change la cadence en rejouant l'existant, comme l'écran et Adam le font.
    const r = await updateStockRecurrence(fd({
      id, name: `${TAG}Relevé modifié`, assigneeId: kamId,
      recurrence: "WEEKLY", hourLocal: "7", dayOfWeek: "0", hospitalIds: [hop1, hop2],
      note: "Relevé mensuel des deux hôpitaux",
    }));
    expect(r.ok, "error" in r ? String(r.error) : "").toBe(true);
    const apres = await loadRecurrenceStock(id);
    expect(apres!.hospitalNames).toHaveLength(2);
    expect(apres!.assigneeId).toBe(kamId);
    expect(apres!.cadence).toMatch(/dimanche/i);

    // DÉCOCHER RETIRE : fusionner ferait qu'un hôpital ne sort jamais d'une récurrence.
    const r2 = await updateStockRecurrence(fd({
      id, name: `${TAG}Relevé modifié`, assigneeId: kamId,
      recurrence: "WEEKLY", hourLocal: "7", dayOfWeek: "0", hospitalIds: [hop1],
    }));
    expect(r2.ok).toBe(true);
    const apres2 = await loadRecurrenceStock(id);
    expect(apres2!.hospitalNames).toEqual([`${TAG}Zéralda`]);
    await prisma.stockRequestRecurrence.delete({ where: { id } });
  });

  it("PAUSE puis REPRISE repart de MAINTENANT, et garde l'historique", async () => {
    const id = await poser("Relevé suspendu");
    const dto = await loadRecurrenceStock(id);
    await declencherRecurrencesStock(new Date(dto!.nextRunAt.getTime() + 60_000));
    expect((await loadRecurrenceStock(id))!.runCount).toBe(1);

    ACTEUR = await acteur(directeurId, "LOGISTICS_MANAGER");
    expect((await setStockRecurrenceStatus(fd({ id, status: "PAUSED" }))).ok).toBe(true);
    const enPause = await loadRecurrenceStock(id);
    expect(enPause!.status).toBe("PAUSED");
    // L'HISTORIQUE SURVIT À LA PAUSE : reprendre ne doit pas effacer ce qui a déjà été demandé.
    expect(enPause!.runCount).toBe(1);

    // EN PAUSE, une échéance dépassée ne déclenche RIEN. La date vient de la ligne elle-même :
    // balayer « dans 400 jours » aurait déclenché toute la base, ce qui n'est pas une mesure.
    await declencherRecurrencesStock(new Date(enPause!.nextRunAt.getTime() + 60_000));
    expect(await demandesDe("Relevé suspendu")).toBe(1);
    expect((await loadRecurrenceStock(id))!.runCount).toBe(1);

    expect((await setStockRecurrenceStatus(fd({ id, status: "ACTIVE" }))).ok).toBe(true);
    const reprise = await loadRecurrenceStock(id);
    expect(reprise!.status).toBe("ACTIVE");
    expect(reprise!.runCount).toBe(1);
    expect(reprise!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    await retirer(id);
  });

  it("RETIRER la récurrence LAISSE les demandes déjà parties — elles appartiennent à leur destinataire", async () => {
    const id = await poser("Relevé retiré");
    const dto = await loadRecurrenceStock(id);
    await declencherRecurrencesStock(new Date(dto!.nextRunAt.getTime() + 60_000));
    const tache = await prisma.task.findFirstOrThrow({
      where: { module: "STOCKS", assignedToId: kamId, description: { contains: `${TAG}Relevé retiré` } },
    });
    const echeanceSuivante = (await loadRecurrenceStock(id))!.nextRunAt;

    ACTEUR = await acteur(directeurId, "LOGISTICS_MANAGER");
    expect((await deleteStockRecurrence(fd({ id }))).ok).toBe(true);
    expect(await loadRecurrenceStock(id)).toBeNull();
    // CE QUI EST PARTI N'EST PAS REJOUÉ NI EFFACÉ (§118.48).
    expect(await prisma.task.findUnique({ where: { id: tache.id } })).not.toBeNull();
    // Et l'échéance qui restait ne produit plus rien.
    await declencherRecurrencesStock(new Date(echeanceSuivante.getTime() + 60_000));
    expect(await demandesDe("Relevé retiré")).toBe(1);
    await prisma.task.deleteMany({ where: { assignedToId: kamId } });
    await prisma.notification.deleteMany({ where: { userId: kamId } });
  });

  it("UN KAM ne peut ni poser, ni modifier, ni suspendre, ni retirer — la MÊME porte que le geste ponctuel", async () => {
    const id = await poser("Relevé gardé");
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");

    const refus = await Promise.all([
      createStockRecurrence(fd({ name: `${TAG}Forgé`, assigneeId: kamId, recurrence: "MONTHLY", dayOfMonth: "1" })),
      updateStockRecurrence(fd({ id, name: `${TAG}Forgé`, assigneeId: kamId, recurrence: "MONTHLY", dayOfMonth: "1" })),
      setStockRecurrenceStatus(fd({ id, status: "PAUSED" })),
      deleteStockRecurrence(fd({ id })),
    ]);
    for (const r of refus) {
      expect(r.ok).toBe(false);
      expect("error" in r ? r.error : "").toContain("Réservé");
    }
    // ET RIEN N'A CHANGÉ EN BASE : un refus qui écrit quand même est pire qu'aucun refus.
    const apres = await loadRecurrenceStock(id);
    expect(apres!.name).toBe(`${TAG}Relevé gardé`);
    expect(apres!.status).toBe("ACTIVE");
    expect(await prisma.stockRequestRecurrence.count({ where: { name: `${TAG}Forgé` } })).toBe(0);
    await prisma.stockRequestRecurrence.delete({ where: { id } });
  });

  it("UNE ANNEXE PCH n'est pas un hôpital : la sélection ENTIÈRE est refusée, jamais amputée", async () => {
    ACTEUR = await acteur(directeurId, "LOGISTICS_MANAGER");
    const r = await createStockRecurrence(fd({
      name: `${TAG}Relevé annexe`, assigneeId: kamId, recurrence: "MONTHLY", hourLocal: "8", dayOfMonth: "1",
      hospitalIds: [hop1, annexeId],
    }));
    expect(r.ok).toBe(false);
    // AMPUTER SERAIT PIRE : on relèverait un hôpital sur deux en croyant en avoir deux.
    expect(await prisma.stockRequestRecurrence.count({ where: { name: `${TAG}Relevé annexe` } })).toBe(0);
  });

  it("TOUT CE QUI MANQUE EN UNE FOIS — un refus par champ ferait ressaisir six fois", async () => {
    ACTEUR = await acteur(directeurId, "LOGISTICS_MANAGER");
    const r = await createStockRecurrence(fd({ name: "", assigneeId: "", recurrence: "HOURLY", hourLocal: "99" }));
    expect(r.ok).toBe(false);
    const err = "error" in r ? String(r.error) : "";
    expect(err).toContain("nom");
    expect(err).toContain("KAM");
    expect(err).toContain("QUOTIDIENNE");
    expect(err).toContain("0 et 23");
  });

  it("L'ÉCRAN et la lecture d'UNE ligne rendent la MÊME chose — deux lecteurs divergeraient", async () => {
    const id = await poser("Relevé lu deux fois");
    const [seule, liste] = await Promise.all([loadRecurrenceStock(id), loadRecurrencesStock()]);
    const dansLaListe = liste.find((r) => r.id === id);
    expect(dansLaListe).toBeDefined();
    expect(dansLaListe).toEqual(seule);

    await retirer(id);
  });

  it("L'ORDRE DES HÔPITAUX NE VIENT PAS DE LA BASE — le lecteur trie et APPARIE les deux listes", async () => {
    const id = await poser("Relevé ordonné");

    // POURQUOI CE CAS ÉCRIT DIRECTEMENT LA RELATION, et ce que cela ne prouve pas.
    //
    // Le chemin d'écriture ordonne déjà ses hôpitaux par nom (`hopitauxValides` : orderBy name),
    // donc il ne PEUT PAS présenter au lecteur des lignes en désordre. Trois sabotages — tri
    // retiré, lecteur réécrit à part, listes désappariées — sont passés AU VERT contre le seul
    // chemin normal : l'assertion visait une propriété qu'aucun cas n'exerçait (§118.111).
    //
    // Or l'ordre d'une relation sans `orderBy` n'est GARANTI par rien : Postgres rend ses lignes
    // comme il les trouve, et une mise à jour ou un VACUUM les déplace. Ce que le lecteur promet,
    // c'est un ordre STABLE et une correspondance rang par rang que la base ne donne pas. Le
    // seul moyen de le lui présenter est d'écrire la relation en désordre — donc ce cas juge le
    // LECTEUR, et lui seul : ce que fait l'écran est jugé par les cas qui passent par l'action.
    await prisma.stockRequestRecurrenceHospital.deleteMany({ where: { recurrenceId: id } });
    await prisma.stockRequestRecurrenceHospital.create({ data: { recurrenceId: id, annexId: hop1 } });
    await prisma.stockRequestRecurrenceHospital.create({ data: { recurrenceId: id, annexId: hop2 } });

    const dto = await loadRecurrenceStock(id);
    expect(dto!.hospitalNames, "l'ordre affiché ne doit pas dépendre de l'ordre des lignes en base")
      .toEqual([`${TAG}Akbou`, `${TAG}Zéralda`]);
    // ET LES DEUX LISTES SE CORRESPONDENT RANG PAR RANG : un appelant qui les apparie par index
    // afficherait sinon le nom d'un hôpital à côté de l'identifiant d'un autre (§104.7).
    expect(dto!.hospitalIds).toEqual([hop2, hop1]);

    // L'ÉCRAN et la lecture d'une ligne rendent la même chose, y compris sur cet ordre-là.
    const liste = await loadRecurrencesStock();
    expect(liste.find((r) => r.id === id)).toEqual(dto);
    await retirer(id);
  });
});
