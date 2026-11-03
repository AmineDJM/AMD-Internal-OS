import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess } from "@/lib/rbac";
import { POWER_TOOLS } from "./power-tools";
import { parseSince } from "./what-changed";

/**
 * WHAT CHANGED — « qu'est-ce qui a changé depuis lundi ? » : seuls les changements TRACÉS
 * depuis la date remontent (pas ceux d'avant), avec QUI a agi et l'état actuel en face ;
 * « aucun changement tracé » est une réponse honnête et complète.
 */

const exec = (id: string): CurrentUser => ({
  id, name: "PDG", email: `${id}@t.dz`, role: "DIRECTION",
  access: { modules: new Map(), rowGrants: new Map() } as unknown as EffectiveAccess,
  mustChangePassword: false,
});

/**
 * UN ACTEUR SANS VUE GLOBALE — sans lui, la garde par enregistrement n'est jamais EXERCÉE.
 *
 * Mesuré en jouant le sabotage : retirer l'appel à `canAccessEntity` ne faisait tomber AUCUN
 * test, parce que l'unique acteur du banc était la DIRECTION, dont l'accès est global — la garde
 * rendait « vrai » quoi qu'il arrive. Une assertion dont on ne sait pas nommer le cas qui la
 * ferait tomber n'est pas une assertion (§118.17).
 *
 * L'outil est aujourd'hui réservé à la direction ; on appelle donc `run` directement, et c'est
 * VOULU : la garde ne doit pas dépendre du filtre de son appelant, sinon un futur appelant la
 * contournera sans le savoir (§118.71, §118.78).
 */
const simple = (id: string): CurrentUser => ({
  id, name: "Délégué", email: `${id}@t.dz`, role: "MEDICAL_DELEGATE",
  access: { modules: new Map(), rowGrants: new Map() } as unknown as EffectiveAccess,
  mustChangePassword: false,
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__wc__${Date.now()}`;
const REF = `${TAG}-PAY`;
let ceoId = "";
let delegueId = "";
let payId = "";

const tool = POWER_TOOLS.find((t) => t.def.name === "what_changed")!;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

suite("what_changed — le diff tracé depuis une date, l'état actuel en face", () => {
  beforeAll(async () => {
    const ceo = await prisma.user.create({ data: { name: `${TAG} Nadia`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "DIRECTION" } });
    ceoId = ceo.id;
    const del = await prisma.user.create({ data: { name: `${TAG} Walid`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } });
    delegueId = del.id;
    const pay = await prisma.paymentRequest.create({
      data: { reference: REF, title: `${TAG} achat imprimerie`, amount: 300_000, payee: "Imprimerie", requesterId: ceoId, status: "SUBMITTED", createdAt: ago(30) },
    });
    payId = pay.id;
    await prisma.auditLog.createMany({
      data: [
        // AVANT la date de référence — ne doit PAS remonter.
        { entityType: "PAYMENT_REQUEST", entityId: payId, action: "UPDATE", module: "Finances", field: "status", oldValue: "DRAFT", newValue: "SUBMITTED", summary: "Demande soumise", actorId: ceoId, createdAt: ago(20) },
        // DEPUIS la date — doivent remonter.
        { entityType: "PAYMENT_REQUEST", entityId: payId, action: "UPDATE", module: "Finances", field: "amount", oldValue: "300000", newValue: "320000", summary: "Montant corrigé", actorId: ceoId, createdAt: ago(3) },
        { entityType: "PAYMENT_REQUEST", entityId: payId, action: "VALIDATE", module: "Finances", summary: "Première validation rendue", actorId: ceoId, createdAt: ago(2) },
      ],
    });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityId: payId } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { reference: REF } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("est réservé au siège exécutif, comme time_travel", () => {
    expect(tool.allowed(exec(ceoId))).toBe(true);
    expect(tool.allowed({ ...exec(ceoId), role: "DELEGATE" as CurrentUser["role"] })).toBe(false);
  });

  it("parseSince : AAAA-MM-JJ (début de journée Alger) ou N jours en arrière ; illisible → null", () => {
    expect(parseSince("2026-06-01")?.toISOString()).toBe("2026-05-31T23:00:00.000Z");
    const seven = parseSince("7", new Date("2026-08-25T12:00:00Z"));
    expect(seven?.toISOString()).toBe("2026-08-18T12:00:00.000Z");
    expect(parseSince("n'importe quoi")).toBeNull();
  });

  it("« depuis 7 jours » : SEULS les changements de la fenêtre remontent, avec qui a agi et l'état actuel", async () => {
    const out = JSON.parse(await tool.run({ reference: REF, since: "7" }, exec(ceoId)));
    const events = JSON.stringify(out.changements);
    expect(events).toContain("Montant corrigé");
    expect(events).toContain("Première validation rendue");
    expect(events).not.toContain("Demande soumise"); // antérieur à la fenêtre
    expect(out.changements).toHaveLength(2);
    expect(out.quiAAgi[0]).toMatchObject({ nom: `${TAG} Nadia`, actions: 2 });
    expect(out.etatActuel.statut).toBe("SUBMITTED");
    expect(out.lien).toBe(`/validations/paiements/${payId}`);
    expect(out.borne, "le journal n'a pas buté sur sa borne").toBeNull();
  });

  it("aucun changement dans la fenêtre → réponse honnête, jamais un diff inventé", async () => {
    const out = JSON.parse(await tool.run({ reference: REF, since: "1" }, exec(ceoId)));
    expect(out.changements).toEqual([]);
    expect(out.precision).toMatch(/Aucun changement SIGNIFICATIF tracé/);
    expect(out.precision).toMatch(/journal ne capture/);
    expect(out.etatActuel).toBeTruthy();
  });

  it("référence inconnue → un refus, oui, mais dans la MÊME forme", async () => {
    const out = JSON.parse(await tool.run({ reference: `${TAG}-fantome`, since: "7" }, exec(ceoId)));
    expect(out.precision).toMatch(/Aucun dossier/);
    expect(out.precision, "l'absence de sujet ne doit pas se lire « rien n'a changé »").toMatch(/SUJET est introuvable/);
    expect(out.changements).toEqual([]);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * LE CONTRAT : LES MÊMES CLÉS, TOUJOURS (§118.20).
   *
   * CE QUI FERAIT TOMBER CE TEST : rendre une phrase au lieu d'un objet sur un refus, omettre
   * `etapesFranchies` quand la liste est vide, ou remplacer `changements` par un compteur. Ce
   * sont les trois formes que cet outil rendait vraiment, et le planificateur — qui écrit ses
   * références AVANT de savoir ce que la lecture rendra — ne pouvait pas les deviner : une
   * référence sur `faits` mourait le jour où le flux était vide, une sur
   * `changements.significatifs` le jour où il ne l'était pas.
   *
   * On compare les JEUX DE CLÉS de cinq situations qui n'ont rien en commun — le flux, un
   * dossier plein, un dossier vide, une date illisible, un sujet inconnu — et on exige qu'ils
   * soient IDENTIQUES.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  it("cinq situations, un seul jeu de clés — la forme ne dépend jamais de la donnée", async () => {
    const situations: [string, Record<string, unknown>][] = [
      ["flux", {}],
      ["dossier plein", { reference: REF, since: "7" }],
      ["dossier vide", { reference: REF, since: "1" }],
      ["date illisible", { reference: REF, since: "avant-hier peut-être" }],
      ["sujet inconnu", { reference: `${TAG}-fantome`, since: "7" }],
    ];
    const vues: [string, string[]][] = [];
    for (const [nom, args] of situations) {
      const brut = await tool.run(args, exec(ceoId));
      let objet: Record<string, unknown>;
      try { objet = JSON.parse(brut) as Record<string, unknown>; } catch {
        throw new Error(`« ${nom} » ne rend pas de JSON : ${brut.slice(0, 120)}`);
      }
      vues.push([nom, Object.keys(objet).sort()]);
    }
    const [, reference] = vues[0]!;
    for (const [nom, cles] of vues) {
      expect(cles, `« ${nom} » ne rend pas les mêmes clés que « ${vues[0]![0]} »`).toEqual(reference);
    }
    // Et la forme est bien celle qu'on a annoncée, pas un jeu de clés vide qui coïnciderait.
    expect(reference).toContain("changements");
    expect(reference).toContain("precision");
    expect(reference).toContain("etapesFranchies");
  });
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * « QUOI DE NEUF ? » APRÈS UN REDÉMARRAGE — le registre canonique répond.
   *
   * LE DÉFAUT MESURÉ : cette réponse n'avait qu'UNE source, la projection en MÉMOIRE du
   * processus. Elle éteinte, l'outil disait « je ne peux pas dire ce qui a bougé à l'instant » ;
   * elle vide, « aucun changement depuis le démarrage de ce serveur ». Render redémarre à CHAQUE
   * déploiement — donc, en production, un « rien n'a bougé » pendant que `BusinessEvent` portait
   * toute la journée. Un « je ne peux pas » écrit dans le CODE (§118.63, §118.93).
   *
   * CE TEST EST EXACTEMENT CE CAS : le fait est écrit en base et le flux en mémoire ne l'a
   * JAMAIS vu (il n'a pas été publié sur le bus). Le seul chemin qui peut le retrouver est le
   * registre durable.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  it("un fait que le flux en mémoire n'a jamais vu remonte quand même — et il DIT qu'il fait foi", async () => {
    await prisma.businessEvent.create({
      data: {
        // MAINTENANT, et c'est le juge qui l'exige : la base de travail porte 26 332 faits sur
        // sept jours ; un fait daté d'hier tomberait hors des soixante plus récents et ce test
        // mesurerait le voisinage au lieu de la réparation (§118.91, §118.92).
        type: `${TAG}_PAYMENT_APPROVED`, sourceDomain: "FINANCES", occurredAt: new Date(),
        entityType: "PAYMENT_REQUEST", entityId: payId, actorId: ceoId,
      },
    });

    const objet = JSON.parse(await tool.run({}, exec(ceoId))) as {
      changements: { quoi: string; sujet: string; source: string }[];
      precision: string;
      depuis: string | null;
    };
    const mien = objet.changements.find((c) => c.quoi === `${TAG}_PAYMENT_APPROVED`);
    expect(mien, "le fait du registre durable doit remonter — c'est tout l'objet de la réparation").toBeTruthy();
    // L'AUTORITÉ VOYAGE AVEC LE FAIT : un indice partiel présenté comme une vérité est pire
    // qu'une absence de réponse.
    expect(mien!.source).toBe("registre");
    expect(mien!.sujet).toContain(payId);
    expect(objet.depuis, "la borne de lecture est dite, jamais implicite").toBeTruthy();
    // Et la phrase ne prétend plus que rien n'a bougé.
    expect(objet.precision).not.toContain("je ne peux pas dire ce qui a bougé");
    expect(objet.precision).toContain("registre canonique");
  });

  it("la coupe se DIT : une liste bornée qui se présente comme complète est un mensonge tranquille", async () => {
    // Ce qui le ferait tomber : rendre « les soixante plus récents » sans le total. Sur cette
    // base (26 332 faits sur sept jours), on lirait les dernières minutes comme le bilan de la
    // semaine — une coupe silencieuse se lit comme une exhaustivité (§118.60).
    const objet = JSON.parse(await tool.run({}, exec(ceoId))) as {
      changements: unknown[]; borne: string | null; precision: string;
    };
    expect(objet.precision, "le TOTAL de la fenêtre est dit, pas seulement l'échantillon").toMatch(/\d+ fait\(s\) au registre canonique/);
    const total = Number(/(\d+) fait\(s\) au registre/.exec(objet.precision)?.[1] ?? "0");
    // L'ÉCART ENTRE LE TOTAL ET CE QUI EST RENDU A DEUX CAUSES, et ce juge n'en acceptait qu'UNE.
    // Il exigeait la phrase de TRONCATURE (« les N plus récents ») ; l'autre cause est
    // l'ÉCARTEMENT par cloisonnement, qui porte sa propre phrase. Mesuré : sept faits écartés,
    // zéro rendu, aucune troncature — le juge accusait le produit pour un écart parfaitement
    // expliqué (§118.92 : qu'est-ce que le juge a réellement mesuré ?). La propriété juste est
    // que l'écart soit EXPLIQUÉ, peu importe laquelle des deux causes l'a produit.
    if (total > objet.changements.length) {
      expect(objet.borne, "un écart entre le total et ce qui est rendu doit être EXPLIQUÉ").not.toBeNull();
      const tronque = objet.borne!.includes("plus récents seulement");
      const ecarte = objet.borne!.includes("écarté");
      expect(tronque || ecarte, `l'écart (${total} au registre, ${objet.changements.length} rendus) n'est expliqué ni par une troncature ni par un écartement : « ${objet.borne} »`).toBe(true);
      if (tronque) expect(objet.borne, "une troncature doit nommer le geste qui la lève").toContain("since");
    }
  });

  it("le cloisonnement est par ENREGISTREMENT, et ce qui est écarté est COMPTÉ", async () => {
    // Un fait SANS entité lisible ne peut pas être cloisonné par `canAccessEntity` : on ne le
    // montre pas, et on le DIT (§118.52). Le taire ferait lire « 3 faits » pour douze.
    await prisma.businessEvent.create({
      data: { type: `${TAG}_SANS_ENTITE`, sourceDomain: "LEGAL", occurredAt: new Date() },
    });
    const objet = JSON.parse(await tool.run({}, exec(ceoId))) as {
      changements: { quoi: string }[]; borne: string | null;
    };
    expect(objet.changements.some((c) => c.quoi === `${TAG}_SANS_ENTITE`), "un fait sans entité n'est pas montré").toBe(false);
    expect(objet.borne, "ce qui est retiré doit laisser une trace").toContain("écarté");
  });

  it("un acteur SANS vue globale ne voit pas le fait d'un enregistrement hors de son périmètre", async () => {
    // Le fait porte une demande de paiement du module Finances. Un délégué médical n'y a pas
    // accès : `canAccessEntity` répond faux par ENREGISTREMENT, et le fait n'apparaît pas.
    // CE QUI LE FERAIT TOMBER : retirer la garde — c'est-à-dire montrer à quelqu'un une ligne
    // qu'il n'a pas le droit de voir, par un geste de simple curiosité.
    const brut = await tool.run({}, simple(delegueId));
    const objet = JSON.parse(brut) as { changements: { quoi: string }[]; borne: string | null };
    expect(objet.changements.some((c) => c.quoi === `${TAG}_PAYMENT_APPROVED`), "hors périmètre : le fait ne doit pas remonter").toBe(false);
    expect(objet.borne, "et son écartement est compté, pas tu").toContain("écarté");
  });
});
