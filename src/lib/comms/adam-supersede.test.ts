import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { OutboundMailStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import { createOutboundIntent } from "./outbound";
import { solePendingMailIntent } from "./approve-execute";
import { resolveSpokenMailApproval } from "@/lib/assistant";
import { setMailSendPolicy } from "./policy";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BLOCAGE DU 26 AOÛT — « Oui envoie » cinq fois, et rien ne part.
 *
 * LE TRANSCRIPT, RÉDUIT À SON MÉCANISME :
 *
 *   PDG   « Envoie le fichier à Amine. »          → Adam prépare       — 1 message en attente
 *   PDG   « Envoie le et mets en message hello »  → Adam RE-prépare    — 2 messages en attente
 *   PDG   « Oui »                                 → …rien
 *   PDG   « Oui envoie »                          → …rien
 *   PDG   « Oui envoie »                          → « confirme sur la carte »
 *
 * POURQUOI. `solePendingMailIntent` rend `null` dès qu'il y a DEUX intentions en attente : « oui »
 * y devient ambigu, et choisir au hasard serait la pire réponse. La règle est juste. Son
 * application ici ne l'était pas.
 *
 * Car ces deux intentions ne sont pas deux CHOIX : c'est le MÊME message, au même destinataire,
 * que le PDG vient d'affiner (« mets en message hello »). Un affinage REMPLACE un brouillon, il
 * ne se met pas en concurrence avec lui. Le garde-fou anti-ambiguïté déclarait donc ambigu ce qui
 * ne l'était pas.
 *
 * ET C'EST AUTO-AGGRAVANT — le point qui rend le défaut sérieux. Chaque « oui » non résolu
 * repart au modèle, qui prépare ENCORE. Trois intentions, puis quatre. Loin de se rattraper,
 * la conversation s'enfonce : le blocage est **définitif** et le PDG n'a aucun moyen d'en sortir
 * en parlant. Ce n'est pas un tour raté, c'est une capacité perdue en cours de route.
 *
 * ⚠ CE QUI NE DOIT PAS ÊTRE « CORRIGÉ » AU PASSAGE : deux messages à des DESTINATAIRES
 * DIFFÉRENTS restent ambigus, et « oui » doit continuer à ne rien faire. Le dernier cas de ce
 * fichier le verrouille — sans lui, le correctif échangerait un blocage contre un envoi au
 * mauvais destinataire, ce qui est infiniment pire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__sup__${Date.now()}`;
const ADAM = `${TAG}.adam@gmail.example`;
const AMINE = `${TAG}.amine.djouamai@pharmagenedz.example`;
const AUTRE = `${TAG}.khaled@adventum.example`;

let user: CurrentUser;
let userId = "";
let connectionId = "";

const prepare = (recipients: string[], bodyText: string) =>
  createOutboundIntent({
    connectionId, userId, recipients, cc: [],
    subject: "Suivi Regulatory — Export du 26/08/2026",
    bodyText, threadId: null, inReplyTo: null, referencesHeader: null,
    attachments: [], missionId: null, reason: "Demandé par le PDG", generatedBy: "chief",
  });

suite("un affinage REMPLACE le brouillon — il ne le concurrence pas", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}.pdg@adventum.example`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    userId = u.id;
    // Le défaut du produit, posé explicitement : c'est la politique sous laquelle le blocage
    // s'est produit, et la seule où « en attente d'approbation » existe.
    await setMailSendPolicy("REQUIRE_APPROVAL", u.id);
    user = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", access: {} as CurrentUser["access"], mustChangePassword: false };
    const c = await prisma.googleConnection.create({
      data: { userId: u.id, address: ADAM, displayName: "Adam", accessTokenEnc: "x", grantedScopes: "", status: "connected" },
    });
    connectionId = c.id;
  });

  afterEach(async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
    // LE CAS « Oui envoie » VA JUSQU'À LA TENTATIVE D'ENVOI RÉELLE, qui échoue faute de jeton
    // Google en intégration continue — et marque la connexion à reconnecter. C'est le bon
    // comportement du code ; sans cette remise en état, il empoisonnerait les cas suivants et
    // on lirait des échecs de fixture comme des échecs de produit.
    await prisma.googleConnection.update({
      where: { id: connectionId },
      data: { status: "connected" },
    }).catch(() => undefined);
  });

  afterAll(async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } });
    await prisma.googleConnection.deleteMany({ where: { id: connectionId } });
    await retirerComptesEtSemis({ where: { id: userId } });
  });

  it("le blocage exact du transcript : deux préparations au MÊME destinataire, « oui » doit conclure", async () => {
    const premier = await prepare([AMINE], "Bonjour, voici le suivi Regulatory en pièce jointe.");
    const affine = await prepare([AMINE], "Hello, voici le suivi.");

    // Ce sont bien deux CONTENUS différents — le second n'est pas un doublon exact, donc le
    // dédoublonnage par empreinte de `createOutboundIntent` ne s'applique pas.
    expect(affine.id).not.toBe(premier.id);

    // LE POINT : une seule intention reste VIVANTE, la dernière.
    const vivantes = await prisma.outboundMailIntent.findMany({
      where: { connectionId, status: OutboundMailStatus.AWAITING_APPROVAL },
      select: { id: true },
    });
    expect(vivantes.map((v) => v.id)).toEqual([affine.id]);

    // …et la parole conclut, au lieu de tourner en rond.
    const sole = await solePendingMailIntent(userId);
    expect(sole?.id, "« oui » doit trouver le message affiné").toBe(affine.id);
  });

  it("le brouillon remplacé est SUPERSÉDÉ, pas supprimé — la trace reste", async () => {
    const premier = await prepare([AMINE], "Première version.");
    await prepare([AMINE], "Deuxième version.");

    const ancien = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: premier.id } });
    expect(ancien.status).toBe(OutboundMailStatus.CANCELLED);
    // Il n'est pas effacé : on doit pouvoir expliquer plus tard pourquoi il n'est jamais parti.
    expect(JSON.stringify(ancien.events)).toMatch(/remplac|supersed/i);
  });

  it("trois affinages de suite ne laissent qu'UNE intention vivante", async () => {
    await prepare([AMINE], "v1");
    await prepare([AMINE], "v2");
    const dernier = await prepare([AMINE], "v3");

    const vivantes = await prisma.outboundMailIntent.count({
      where: { connectionId, status: OutboundMailStatus.AWAITING_APPROVAL },
    });
    expect(vivantes).toBe(1);
    expect((await solePendingMailIntent(userId))?.id).toBe(dernier.id);
  });

  it("« Oui envoie » sort du blocage — la boucle du transcript est fermée", async () => {
    await prepare([AMINE], "Bonjour, voici le suivi.");
    await prepare([AMINE], "Hello, voici le suivi.");

    // Avant le correctif, ceci rendait `null` — indéfiniment, et de pire en pire.
    const r = await resolveSpokenMailApproval(user, "Oui envoie");
    expect(r, "la parole doit conclure, pas renvoyer à une carte").not.toBeNull();
  });

  it("⚠ DEUX DESTINATAIRES DIFFÉRENTS RESTENT AMBIGUS — « oui » ne doit RIEN envoyer", async () => {
    // Le garde-fou d'origine protégeait de ceci, et il doit continuer. Un correctif qui
    // prendrait « le plus récent » sans regarder le destinataire échangerait un blocage
    // contre un envoi à la mauvaise personne : le sens même de l'asymétrie de sécurité.
    await prepare([AMINE], "Message pour Amine.");
    await prepare([AUTRE], "Message pour Khaled.");

    const vivantes = await prisma.outboundMailIntent.count({
      where: { connectionId, status: OutboundMailStatus.AWAITING_APPROVAL },
    });
    expect(vivantes, "aucune des deux ne remplace l'autre").toBe(2);
    expect(await solePendingMailIntent(userId)).toBeNull();
    expect(await resolveSpokenMailApproval(user, "Oui envoie")).toBeNull();
  });

  it("un message DÉJÀ APPROUVÉ ou parti n'est jamais remplacé par une nouvelle préparation", async () => {
    // Remplacer un message en cours d'envoi reviendrait à annuler quelque chose que le PDG a
    // déjà autorisé — et qui est peut-être déjà chez le destinataire.
    const parti = await prepare([AMINE], "Version envoyée.");
    await prisma.outboundMailIntent.update({
      where: { id: parti.id },
      data: { status: OutboundMailStatus.SENT, sentAt: new Date() },
    });

    await prepare([AMINE], "Version suivante.");
    const intact = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: parti.id } });
    expect(intact.status).toBe(OutboundMailStatus.SENT);
  });

  it("⚠ les messages d'une MISSION ne se remplacent pas entre eux", async () => {
    // Une mission qui prépare plusieurs relances au même fournisseur produit des messages
    // DISTINCTS voulus ensemble, pas des révisions successives. Les fondre perdrait du travail
    // commandé — et personne ne s'en apercevrait avant que le fournisseur ne réponde jamais.
    const mission = await prisma.mission.create({
      data: { ownerId: userId, title: `${TAG} relances`, objective: "Relancer le fournisseur." },
    });

    const withMission = (bodyText: string) => createOutboundIntent({
      connectionId, userId, recipients: [AMINE], cc: [],
      subject: "Relance", bodyText, threadId: null, inReplyTo: null, referencesHeader: null,
      attachments: [], missionId: mission.id, reason: "mission", generatedBy: "chief",
    });

    const a = await withMission("Première relance.");
    const b = await withMission("Seconde relance.");
    expect(a.id).not.toBe(b.id);

    const vivantes = await prisma.outboundMailIntent.count({
      where: { connectionId, status: OutboundMailStatus.AWAITING_APPROVAL },
    });
    expect(vivantes, "les deux relances de la mission survivent").toBe(2);

    await prisma.outboundMailIntent.deleteMany({ where: { missionId: mission.id } });
    await prisma.mission.deleteMany({ where: { id: mission.id } });
  });

  it("le remplacement est cloisonné par COMPTE — le brouillon d'un autre n'est pas touché", async () => {
    const autre = await prisma.user.create({
      data: { name: `${TAG} Autre`, email: `${TAG}.autre@adventum.example`, passwordHash: "x", role: "DIRECTION" },
    });
    const cx = await prisma.googleConnection.create({
      data: { userId: autre.id, address: `${TAG}.autre.adam@gmail.example`, displayName: "Adam", accessTokenEnc: "x", grantedScopes: "", status: "connected" },
    });
    const sien = await createOutboundIntent({
      connectionId: cx.id, userId: autre.id, recipients: [AMINE], cc: [],
      subject: "Suivi Regulatory — Export du 26/08/2026", bodyText: "Son message à lui.",
      threadId: null, inReplyTo: null, referencesHeader: null, attachments: [],
      missionId: null, reason: "x", generatedBy: "chief",
    });

    await prepare([AMINE], "Mon message à moi.");

    const intact = await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: sien.id } });
    expect(intact.status).toBe(OutboundMailStatus.AWAITING_APPROVAL);

    await prisma.outboundMailIntent.deleteMany({ where: { connectionId: cx.id } });
    await prisma.googleConnection.deleteMany({ where: { id: cx.id } });
    await retirerComptesEtSemis({ where: { id: autre.id } });
  });
});
