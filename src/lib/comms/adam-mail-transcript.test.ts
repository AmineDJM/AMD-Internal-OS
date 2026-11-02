import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MailSendPolicy, OutboundMailStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import {
  buildProposal,
  performAction,
  resolveSpokenMailApproval,
  assistantIdentityContext,
} from "@/lib/assistant";
import { createOutboundIntent } from "./outbound";
import { recentActionIntentsContext } from "@/platform/ia/intentions/action-intents";
import { setMailSendPolicy } from "./policy";

/**
 * LES DEUX TRANSCRIPTS RÉELS, REJOUÉS.
 *
 * Ce fichier n'invente aucun scénario : il rejoue, phrase par phrase, deux conversations que le
 * PDG a réellement eues avec Adam et qui ont chacune révélé un défaut de fond.
 *
 *   TRANSCRIPT 1 — l'envoi.
 *     « Envoie un mail à amine.djouamai@pharmagenedz.com »
 *     → carte « De : amine.djouamai@pharmagenedz.com / À : amine.djouamai@pharmagenedz.com »
 *     Adam s'écrivait au PDG DEPUIS la boîte du PDG. Puis : « Tu confirmes l'envoi ? » — le PDG
 *     confirme — « Je prépare le mail maintenant » — SECONDE carte à confirmer.
 *
 *   TRANSCRIPT 2 — l'identité.
 *     « Mais tu t'appelles comment ? » → « Je m'appelle Assistant IA ».
 *     « C'est quoi ton mail ? » → « Je n'ai pas d'adresse e-mail propre. Quand j'envoie un mail,
 *      c'est depuis ta boîte : amine.djouamai@pharmagenedz.com. »
 *     Trois affirmations fausses sur le sujet où il devait être le plus sûr : lui-même.
 *
 * Ce qui est vérifié ici est donc l'ÉTAT SERVEUR, pas une formulation : quelle carte est produite,
 * quel expéditeur elle porte, combien d'intentions existent, ce que le contexte affirme. Une
 * réponse bien tournée par-dessus un état faux resterait le même bogue.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__transcript__${Date.now()}`;
const ADAM = `${TAG}.adam.executive.ai@gmail.com`;
const PDG_MAIL = `${TAG}.amine.djouamai@pharmagenedz.example`;

let user: CurrentUser;
let userId = "";
let connectionId = "";

suite("transcript réel — l'envoi, l'expéditeur et la confirmation unique", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} Amine`, email: PDG_MAIL, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    userId = u.id;
    const c = await prisma.googleConnection.create({
      data: { userId: u.id, address: ADAM, displayName: "Adam", accessTokenEnc: "x", grantedScopes: "", status: "connected" },
    });
    connectionId = c.id;
    user = {
      id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN",
      access: {} as CurrentUser["access"], mustChangePassword: false,
    };
    await setMailSendPolicy(MailSendPolicy.REQUIRE_APPROVAL, userId);
  }, 30_000);

  afterEach(async () => {
    // Depuis que la parole EXÉCUTE, ces cas passent par le vrai transport Gmail : sans jeton
    // valable, la connexion bascule légitimement en « à reconnecter » — la production fait son
    // travail. On la relève entre les cas, sinon l'état de l'un déciderait du suivant.
    await prisma.googleConnection.update({
      where: { id: connectionId },
      data: { status: "connected", paused: false, lastError: null },
    });
  });

  afterAll(async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.googleConnection.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.communicationPolicy.deleteMany({ where: { updatedById: userId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: userId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { contains: TAG } } }).catch(() => {});
  }, 30_000);

  // ═════════════ TRANSCRIPT 1 — « Envoie un mail à … » ═════════════

  it("« Envoie un mail à … » produit UNE carte canonique, expédiée depuis l'adresse d'ADAM", async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });

    const card = await buildProposal("send_email", {
      to: PDG_MAIL,
      subject: "Test d'envoi de mail",
      body: "Bonjour, je réussis dorénavant à envoyer des mails.",
    }, user);

    expect("error" in card, "error" in card ? (card as { error: string }).error : "").toBe(false);
    if ("error" in card) return;

    // 1. La carte est celle de l'AUTORITÉ CANONIQUE, pas l'ancienne carte SMTP.
    expect(card.kind).toBe("send_prepared_mail");

    // 2. L'EXPÉDITEUR est Adam. C'est LA ligne du bogue.
    const de = card.fields.find((f) => f.label === "De");
    expect(de?.value).toContain(ADAM);
    expect(de?.value).not.toContain("pharmagenedz");

    // 3. Le destinataire est bien celui demandé — et il diffère de l'expéditeur.
    const a = card.fields.find((f) => f.label === "À");
    expect(a?.value).toBe(PDG_MAIL.toLowerCase());
    expect(a?.value).not.toBe(de?.value);

    // 4. UNE seule intention existe, et elle attend l'accord : rien n'est parti.
    const intents = await prisma.outboundMailIntent.findMany({ where: { connectionId } });
    expect(intents).toHaveLength(1);
    expect(intents[0].status).toBe(OutboundMailStatus.AWAITING_APPROVAL);
    expect(intents[0].sentAt).toBeNull();
  });

  it("« Je confirme. » EXÉCUTE l'intention en attente — pas une carte de plus à cliquer", async () => {
    // LE CONTRAT A CHANGÉ, ET C'EST LE CORRECTIF. Une première version faisait rendre à la
    // confirmation la CARTE de l'intention : mieux que d'en préparer une seconde, mais le PDG
    // devait encore cliquer ce qu'il venait d'approuver à voix haute. Désormais l'accord
    // déclenche l'envoi par la MÊME fonction que le bouton.
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
    const prepare = await createOutboundIntent({
      connectionId, userId,
      recipients: [PDG_MAIL],
      subject: "Test d'envoi de mail",
      bodyText: "Je réussis dorénavant à envoyer des mails.",
    });

    const done = await resolveSpokenMailApproval(user, "Je confirme.");
    expect(done, "la confirmation doit être prise en charge").not.toBeNull();

    // L'APPROBATION HUMAINE est enregistrée sur l'intention EXACTE — c'est elle qui compte, et
    // elle est portée par le compte réellement authentifié.
    const apres = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: prepare.id } });
    expect(apres.approvedById).toBe(userId);
    expect(apres.approvedHash).toBe(apres.contentHash);
    // Une tentative d'envoi a bien eu lieu (le transport réel échoue faute de jeton en CI —
    // ce qui compte ici est qu'on ait EXÉCUTÉ, pas rendu une carte).
    expect(apres.attempts).toBe(1);

    // Et aucune seconde intention n'a été fabriquée au passage.
    expect(await prisma.outboundMailIntent.count({ where: { connectionId } })).toBe(1);
  });

  it("répéter « oui », « envoie », « vas-y » ne crée jamais d'intention supplémentaire", async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
    await createOutboundIntent({
      connectionId, userId,
      recipients: [PDG_MAIL],
      subject: "Test d'envoi de mail",
      bodyText: "Je réussis dorénavant à envoyer des mails.",
    });

    for (const mot of ["Je confirme.", "oui", "envoie", "vas-y", "envoie-le"]) {
      await resolveSpokenMailApproval(user, mot);
    }
    // Le point du test : répéter son accord ne fabrique pas de messages. Une seule intention,
    // et donc au plus un courriel.
    expect(await prisma.outboundMailIntent.count({ where: { connectionId } })).toBe(1);
  });

  it("une RÉSERVE n'est pas un accord : rien ne part, la conversation repart au modèle", async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
    const prepare = await createOutboundIntent({
      connectionId, userId, recipients: [PDG_MAIL], subject: "Objet", bodyText: "Corps",
    });
    expect(await resolveSpokenMailApproval(user, "oui mais change l'objet")).toBeNull();
    expect(await resolveSpokenMailApproval(user, "non, annule")).toBeNull();
    // …et la question du transcript 2, qui ne doit surtout pas être prise pour un accord.
    expect(await resolveSpokenMailApproval(user, "Tu as reçu des e-mails ou pas ?")).toBeNull();

    // LA PREUVE : l'intention n'a même pas été approuvée.
    const intact = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: prepare.id } });
    expect(intact.approvedById).toBeNull();
    expect(intact.attempts).toBe(0);
  });

  it("DEUX messages en attente rendent « oui » ambigu — on ne devine pas", async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
    await createOutboundIntent({ connectionId, userId, recipients: ["a@x.example"], subject: "A", bodyText: "Un" });
    await createOutboundIntent({ connectionId, userId, recipients: ["b@x.example"], subject: "B", bodyText: "Deux" });
    // Choisir au hasard entre deux messages à expédier serait la pire réponse possible.
    expect(await resolveSpokenMailApproval(user, "Je confirme.")).toBeNull();
    // Et rien n'a été approuvé au passage.
    expect(await prisma.outboundMailIntent.count({ where: { connectionId, approvedById: { not: null } } })).toBe(0);
  });

  it("sans rien en attente, « oui » ne déclenche aucun envoi", async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
    expect(await resolveSpokenMailApproval(user, "oui")).toBeNull();
  });

  // ═════════════ LA PORTE DÉROBÉE ═════════════

  it("l'ANCIENNE carte SMTP n'expédie plus rien — une seule autorité d'envoi", async () => {
    // Une carte restée ouverte dans un onglet, produite avant le correctif. Elle contournait
    // l'intention canonique : ni empreinte approuvée, ni approbateur, ni politique relue.
    const r = await performAction(user, {
      kind: "send_email", to: "quelquun@ailleurs.example", subject: "Objet", body: "Corps",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/n'expédie plus rien/i);
  });

  // ═════════════ TRANSCRIPT 2 — « Tu t'appelles comment ? » ═════════════

  it("Adam sait son nom et son adresse — et ne s'attribue pas la boîte du PDG", async () => {
    const ctx = await assistantIdentityContext(user);
    expect(ctx).toContain("ADAM");
    expect(ctx).toContain(ADAM);
    // La phrase exacte du transcript — « j'envoie depuis ta boîte » — est explicitement démentie.
    expect(ctx).toMatch(/depuis la tienne, en son nom/);
    expect(ctx).toMatch(/DEUX adresses différentes/);
    // L'adresse du PDG apparaît, mais comme celle de la personne servie : jamais comme expéditeur.
    const avantAdresse = ctx.slice(0, ctx.indexOf(PDG_MAIL));
    expect(avantAdresse).toContain("CELLE de la personne que tu sers");
  });

  it("sans connexion, Adam le DIT — il n'emprunte pas une autre boîte", async () => {
    await prisma.googleConnection.update({ where: { id: connectionId }, data: { paused: true } });
    const ctx = await assistantIdentityContext(user);
    expect(ctx).toMatch(/AUCUNE adresse d'expédition/);
    // L'adresse du PDG reste nommée — comme celle de la personne SERVIE, jamais comme celle
    // d'expédition. C'est cette distinction, et pas son absence, qui ferme le bogue : la ligne
    // « TON ADRESSE D'EXPÉDITION est … » ne doit jamais porter son adresse à lui.
    expect(ctx).not.toMatch(new RegExp(`TON ADRESSE D'EXPÉDITION est[^\\n]*${PDG_MAIL}`));
    expect(ctx).toContain("au lieu de proposer une autre boîte");
    await prisma.googleConnection.update({ where: { id: connectionId }, data: { paused: false } });
  });

  // ═════════════ L'INTENT PÉRIMÉ QUI CONTAMINAIT ═════════════

  it("une proposition Finances VIEILLE ne s'invite plus dans le contexte", async () => {
    await prisma.assistantActionIntent.deleteMany({ where: { userId } });
    // La scène : une carte Finances proposée en matinée, jamais confirmée, qui figurait encore
    // dans le contexte de l'après-midi — et que le modèle a reprise pour répondre à une question
    // portant sur la boîte mail.
    const vieux = new Date(Date.now() - 12 * 3_600_000);
    await prisma.assistantActionIntent.create({
      data: {
        userId, kind: "decide_payment", module: "FINANCE", title: "Décider un règlement",
        summary: "Régler la facture FA-2026-118 (Finances)",
        status: "PROPOSED", origin: "text", proposedAt: vieux, payload: {},
      },
    });
    const ctx = await recentActionIntentsContext(userId);
    expect(ctx).toBeNull();
  });

  it("une proposition RÉCENTE reste visible — mais annoncée comme un rappel, pas un ordre du jour", async () => {
    await prisma.assistantActionIntent.deleteMany({ where: { userId } });
    await prisma.assistantActionIntent.create({
      data: {
        userId, kind: "decide_payment", module: "FINANCE", title: "Décider un règlement",
        summary: "Régler la facture FA-2026-118 (Finances)",
        status: "PROPOSED", origin: "text", payload: {},
      },
    });
    const ctx = await recentActionIntentsContext(userId);
    expect(ctx).toContain("FA-2026-118");
    // La consigne qui empêche la contamination est portée par le bloc lui-même.
    expect(ctx).toMatch(/RAPPEL, PAS UN ORDRE DU JOUR/);
    expect(ctx).toMatch(/ne fournit JAMAIS le sujet/);
    expect(ctx).toMatch(/un autre domaine/);
    await prisma.assistantActionIntent.deleteMany({ where: { userId } });
  });

  it("une action EXÉCUTÉE ne se périme jamais — « c'est fait » reste vrai", async () => {
    await prisma.assistantActionIntent.deleteMany({ where: { userId } });
    const vieux = new Date(Date.now() - 30 * 86_400_000);
    await prisma.assistantActionIntent.create({
      data: {
        userId, kind: "send_prepared_mail", module: "WORKSPACE", title: "Envoyer un message",
        summary: "Courriel envoyé à Deepak", status: "EXECUTED", origin: "text",
        proposedAt: vieux, executedAt: vieux, payload: {},
      },
    });
    const ctx = await recentActionIntentsContext(userId);
    expect(ctx).toContain("Deepak");
    await prisma.assistantActionIntent.deleteMany({ where: { userId } });
  });
});
