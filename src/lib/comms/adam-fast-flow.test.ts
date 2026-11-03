import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MailSendPolicy, OutboundMailStatus, DirectoryChannel, EndpointConfidence } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import { buildProposal, resolveSpokenMailApproval } from "@/lib/assistant";
import { solePendingMailIntent, approveAndExecuteIntent } from "./approve-execute";
// Le transport RÉEL, volontairement : ce test prouve qu'un échec côté Google ne fabrique pas un
// envoi. Un faux transport qui réussit toujours ne prouverait rien de ce qui est en jeu ici.
import { gmailTransport } from "@/lib/google/gmail/transport";
import { findPeople } from "@/lib/directory/resolve";
import { setMailSendPolicy } from "./policy";

/**
 * LE TRANSCRIPT GOLDEN DE LA MISSION — quatre tours, pas huit.
 *
 *   PDG   « Envoie un mail à l'e-mail de Amine. »
 *   ADAM  « Amine : Pharmagene ou Gmail ? »          ← UNE question, parce que deux adresses
 *                                                       vérifiées coexistent et que se tromper
 *                                                       coûte plus cher que six mots.
 *   PDG   « Pharmagene, demande-lui s'il va bien. »
 *   ADAM  → carte prête : DE l'adresse d'Adam, À l'adresse Pharmagene, objet et corps ÉCRITS.
 *   PDG   « Oui vas-y envoie. »
 *   ADAM  « Envoyé. »
 *
 * CE QUE CES CAS VÉRIFIENT VRAIMENT : l'ÉTAT SERVEUR à chaque tour — quelle carte est produite,
 * combien de questions ont été nécessaires, combien d'intentions existent, qui a approuvé. Une
 * conversation qui « a l'air » fluide par-dessus un état faux resterait le même défaut.
 *
 * LIMITE ASSUMÉE : l'appel HTTP à Google n'est pas joué (pas de jeton en intégration continue).
 * On observe donc l'APPROBATION et la TENTATIVE d'envoi — c'est là que se trouvait le bogue
 * (« la parole ne déclenchait rien »), pas dans le transport.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__fast__${Date.now()}`;
const ADAM = `${TAG}.adam@gmail.com`;
const PRO = `${TAG}.amine.djouamai@pharmagenedz.example`;
const PERSO = `${TAG}.amine.djouamaii@gmail.example`;

let user: CurrentUser;
let userId = "";
let connectionId = "";
let employeeId = "";
let entryId = "";

suite("flux rapide — une question au plus, une carte, un envoi", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}.pdg@adventum.example`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    userId = u.id;
    user = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", access: {} as CurrentUser["access"], mustChangePassword: false };

    const c = await prisma.googleConnection.create({
      data: { userId: u.id, address: ADAM, displayName: "Adam", accessTokenEnc: "x", grantedScopes: "", status: "connected" },
    });
    connectionId = c.id;

    // LA PERSONNE CHERCHÉE : un salarié réel, et DEUX adresses vérifiées — la situation exacte
    // qui justifie une question, et une seule.
    const emp = await prisma.employee.create({
      data: { fullName: `${TAG} Amine Djouamaii`, position: "Directeur", isActive: true },
    });
    employeeId = emp.id;
    const entry = await prisma.directoryEntry.create({
      data: {
        employeeId: emp.id, displayName: `${TAG} Amine Djouamaii`,
        aliases: [`${TAG.toLowerCase()} amine`],
        endpoints: {
          create: [
            { channel: DirectoryChannel.EMAIL, value: PRO, label: "Pharmagene", confidence: EndpointConfidence.VERIFIED_INTERNAL },
            { channel: DirectoryChannel.EMAIL, value: PERSO, label: "Gmail", confidence: EndpointConfidence.VERIFIED_INTERNAL },
          ],
        },
      },
    });
    entryId = entry.id;
    await setMailSendPolicy(MailSendPolicy.REQUIRE_APPROVAL, userId);
  }, 30_000);

  afterEach(async () => {
    await prisma.googleConnection.update({
      where: { id: connectionId },
      data: { status: "connected", paused: false, lastError: null },
    });
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
  });

  afterAll(async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } }).catch(() => {});
    await prisma.directoryEndpoint.deleteMany({ where: { entryId } }).catch(() => {});
    await prisma.directoryEntry.deleteMany({ where: { id: entryId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: employeeId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: userId } }).catch(() => {});
    await prisma.googleConnection.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.communicationPolicy.deleteMany({ where: { updatedById: userId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { contains: TAG } } }).catch(() => {});
  }, 30_000);

  // ═══════════ TOUR 1 — « Envoie un mail à l'e-mail de Amine » ═══════════

  it("l'annuaire retrouve la personne par son NOM, avec ses deux adresses", async () => {
    const people = await findPeople(`${TAG} Amine`, 5);
    expect(people.length).toBeGreaterThanOrEqual(1);
    const amine = people.find((p) => p.name.includes("Amine"));
    expect(amine, "Amine doit être trouvée par son nom").toBeTruthy();
    const adresses = amine!.endpoints.filter((e) => e.channel === DirectoryChannel.EMAIL).map((e) => e.value);
    expect(adresses).toContain(PRO);
    expect(adresses).toContain(PERSO);
  });

  it("deux adresses vérifiées → UNE question courte, pas une carte au hasard", async () => {
    const r = await buildProposal("send_email", { to: `${TAG} Amine`, body: "Bonjour." }, user);
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    // La question nomme les deux options et rien d'autre.
    expect(r.error).toMatch(/Pharmagene/);
    expect(r.error).toMatch(/Gmail/);
    expect(r.error.length).toBeLessThan(120);
    // Et surtout : AUCUNE intention n'a été créée pour une question.
    expect(await prisma.outboundMailIntent.count({ where: { connectionId } })).toBe(0);
  });

  // ═══════════ TOUR 2 — « Pharmagene, demande-lui s'il va bien » ═══════════

  it("avec l'indice, Adam PRÉPARE directement — objet et corps écrits sans les demander", async () => {
    const carte = await buildProposal("send_email", {
      to: `${TAG} Amine`,
      addressHint: "Pharmagene",
      // Ni objet ni corps : c'est tout le point. Les demander ferait perdre un tour.
    }, user);
    expect("error" in carte, "error" in carte ? (carte as { error: string }).error : "").toBe(false);
    if ("error" in carte) return;

    expect(carte.kind).toBe("send_prepared_mail");
    expect(carte.fields.find((f) => f.label === "De")?.value).toContain(ADAM);
    expect(carte.fields.find((f) => f.label === "À")?.value).toBe(PRO);
    // Un objet SENSÉ, pas « (sans objet) ».
    expect(carte.fields.find((f) => f.label === "Objet")?.value).toBe("Prise de nouvelles");
    // Un corps rédigé, qui tutoie par le prénom.
    expect(carte.fields.find((f) => f.label === "Message")?.value).toMatch(/j'espère que tu vas bien/i);

    const intent = await prisma.outboundMailIntent.findFirstOrThrow({ where: { connectionId } });
    expect(intent.status).toBe(OutboundMailStatus.AWAITING_APPROVAL);
    expect(intent.sentAt).toBeNull();
  });

  it("un objet DICTÉ par le PDG l'emporte toujours sur le défaut", async () => {
    const carte = await buildProposal("send_email", {
      to: PRO, subject: "Point budget", body: "Peux-tu m'envoyer le tableau ?",
    }, user);
    if ("error" in carte) throw new Error(carte.error);
    expect(carte.fields.find((f) => f.label === "Objet")?.value).toBe("Point budget");
  });

  it("l'objet se DÉDUIT du contenu quand il est parlant", async () => {
    const carte = await buildProposal("send_email", {
      to: PRO, body: "Je me permets une relance : ce dossier est sans réponse depuis deux semaines.",
    }, user);
    if ("error" in carte) throw new Error(carte.error);
    expect(carte.fields.find((f) => f.label === "Objet")?.value).toBe("Relance");
  });

  // ═══════════ TOUR 3 — « Oui vas-y envoie » ═══════════

  it("« Oui vas-y envoie » EXÉCUTE — sans seconde carte, sans clic", async () => {
    const carte = await buildProposal("send_email", { to: PRO, addressHint: "Pharmagene" }, user);
    if ("error" in carte) throw new Error(carte.error);
    const intentId = (carte.payload as { intentId: string }).intentId;

    const done = await resolveSpokenMailApproval(user, "Oui vas-y envoie");
    expect(done, "la parole doit déclencher l'exécution").not.toBeNull();
    // Ce qui revient est un RÉSULTAT D'EXÉCUTION, jamais une carte : il n'y a rien à cliquer.
    expect(done).not.toHaveProperty("fields");
    expect(done).not.toHaveProperty("payload");

    const apres = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(apres.approvedById).toBe(userId);        // l'humain est nommé
    expect(apres.approvedHash).toBe(apres.contentHash); // sur le contenu EXACT
    expect(apres.attempts).toBe(1);                 // une tentative, une seule
    expect(await prisma.outboundMailIntent.count({ where: { connectionId } })).toBe(1);
  });

  it.each(["oui", "envoie", "envoie-le", "je confirme", "c'est bon", "go", "vas-y envoie"])(
    "« %s » vaut approbation et déclenche l'exécution",
    async (phrase) => {
      await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
      const carte = await buildProposal("send_email", { to: PRO, body: `Corps pour ${phrase}` }, user);
      if ("error" in carte) throw new Error(carte.error);
      const done = await resolveSpokenMailApproval(user, phrase);
      expect(done, phrase).not.toBeNull();
      const intent = await prisma.outboundMailIntent.findFirstOrThrow({ where: { connectionId } });
      expect(intent.approvedById, phrase).toBe(userId);
    },
  );

  it("« oui mais change l'objet » n'envoie RIEN — la réserve gagne", async () => {
    const carte = await buildProposal("send_email", { to: PRO, body: "Corps de la réserve" }, user);
    if ("error" in carte) throw new Error(carte.error);
    const intentId = (carte.payload as { intentId: string }).intentId;

    expect(await resolveSpokenMailApproval(user, "oui mais change l'objet")).toBeNull();
    const intact = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intact.approvedById).toBeNull();
    expect(intact.attempts).toBe(0);
  });

  // ═══════════ LE CLIC ET LA PAROLE : LA MÊME AUTORITÉ ═══════════

  it("clic puis parole — l'un ou l'autre, jamais deux envois", async () => {
    const carte = await buildProposal("send_email", { to: PRO, body: "Corps unique" }, user);
    if ("error" in carte) throw new Error(carte.error);
    const intentId = (carte.payload as { intentId: string }).intentId;

    // Le clic sur « Envoyer » — la première interface.
    await approveAndExecuteIntent(user, intentId, gmailTransport);
    const apresClic = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intentId } });
    const tentativesApresClic = apresClic.attempts;

    // Puis la parole, sur le même message — la seconde interface, même autorité.
    await resolveSpokenMailApproval(user, "envoie-le").catch(() => null);

    const final = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intentId } });
    // Le point : le compteur de tentatives n'a pas doublé derrière le dos du PDG.
    expect(final.attempts).toBe(tentativesApresClic);
    expect(await prisma.outboundMailIntent.count({ where: { connectionId } })).toBe(1);
  });

  it("sans adresse connue, Adam le dit court — il ne propose pas de chercher", async () => {
    const r = await buildProposal("send_email", { to: `${TAG} Inconnu Total`, body: "Bonjour." }, user);
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toMatch(/Aucune trace/i);
    expect(r.error.length).toBeLessThan(140);
  });

  it("l'intention en attente est retrouvée sans ambiguïté quand il n'y en a qu'une", async () => {
    const carte = await buildProposal("send_email", { to: PRO, body: "Corps solitaire" }, user);
    if ("error" in carte) throw new Error(carte.error);
    const sole = await solePendingMailIntent(userId);
    expect(sole?.id).toBe((carte.payload as { intentId: string }).intentId);
  });
});
