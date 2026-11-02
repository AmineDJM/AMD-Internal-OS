import { sansBloquer } from "@/lib/journal";
import { expect } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { sealSecret } from "@/lib/crypto/secret-box";
import { annulerGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import { retablirGeste } from "@/lib/effets/retablissement";
import { enregistrerExecuteur, executerEffetsSortantsDus } from "@/lib/effets/fenetre";
import { EXECUTEURS } from "@/lib/effets/executeurs";
import { installerPortReseau } from "@/lib/effets/reseau";
import { viderFile } from "@/lib/site-web/file";
import type { TransportSite } from "@/lib/site-web/transport";
import { sendMailAction } from "@/lib/actions/mail-actions";
import { sendMail as envoyerCourrielSmart } from "@/lib/actions/smart-mail-actions";
import {
  sendMessage, setMessageRead, moveMessage, saveDraft, linkMessageToEntity, saveAttachmentToDrive, disconnectMicrosoftMail,
} from "@/lib/actions/microsoft-mail-actions";
import { publishDirective, resendDirective } from "@/lib/actions/directive-actions";
import { enregistrerArticle, relancerEnvoiSite } from "@/lib/actions/site-web-actions";
import { publierOffreSiteDuRecrutement } from "@/lib/actions/recrutement-diffusion-actions";
import { aLEcran, cycle, fd, type CasReversible } from "./banc";

/**
 * K10b (décision 0035) — LES CAS « EXÉCUTER PUIS ANNULER » DES ENVOIS. Chaque cas vérifie les deux moitiés : la base
 * (statut rendu, lignes retirées) ET la file (`EffetSortantDiffere` du geste ANNULE après annulation, EN_ATTENTE après
 * rétablissement — compté dans `lire` ; pour le site : `SitePublication` revenue à l'avant). Rien ne sort : `fetch`
 * est remplacé le temps du cas (Graph simulé, tout autre hôte refusé et compté). Joués par `communications.test.ts`.
 */

// ── Le réseau du cas : Graph simulé, le reste refusé ───────────────────────────────────────────

interface MessageGraph { id: string; subject: string; isRead: boolean; folder: string; isDraft: boolean }

/** La boîte Microsoft simulée : ce que Graph détient, et chaque appel reçu. */
class FauxGraph {
  readonly boite = new Map<string, MessageGraph>();
  readonly appels: string[] = [];
  /** Les appels vers un autre hôte que Graph : ils ne doivent jamais exister. */
  readonly horsGraph: string[] = [];
  private n = 0;

  poser(m: Omit<MessageGraph, "id" | "isDraft"> & { id?: string }): string {
    const id = m.id ?? `msg-${++this.n}`;
    this.boite.set(id, { isDraft: false, ...m, id });
    return id;
  }

  /** L'état de la boîte, sans les identifiants (Microsoft en change à chaque déplacement). */
  etat(): { subject: string; folder: string; isRead: boolean }[] {
    return [...this.boite.values()].map(({ subject, folder, isRead }) => ({ subject, folder, isRead })).sort((a, b) => `${a.folder}${a.subject}`.localeCompare(`${b.folder}${b.subject}`));
  }

  private brut(m: MessageGraph) {
    return { id: m.id, subject: m.subject, isRead: m.isRead, parentFolderId: m.folder, isDraft: m.isDraft, from: { emailAddress: { address: "expediteur@exemple.dz" } }, receivedDateTime: "2026-10-30T09:00:00Z", body: { contentType: "HTML", content: "<p>x</p>" } };
  }

  private deplacer(m: MessageGraph, dossier: string): MessageGraph {
    this.boite.delete(m.id);
    const neuf = { ...m, id: `msg-${++this.n}`, folder: dossier };
    this.boite.set(neuf.id, neuf);
    return neuf;
  }

  async repondre(url: URL, init?: RequestInit): Promise<Response> {
    const methode = (init?.method ?? "GET").toUpperCase();
    const chemin = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    this.appels.push(`${methode} ${chemin}`);
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
    const corps = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const [, me, messages, id, sous, pj, valeur] = chemin.split("/");
    if (me !== "me" || messages !== "messages") return json({ error: { code: "BadRequest" } }, 400);
    if (!id && methode === "POST") {
      const nid = `msg-${++this.n}`;
      this.boite.set(nid, { id: nid, subject: String(corps.subject ?? ""), isRead: true, folder: "drafts", isDraft: true });
      return json(this.brut(this.boite.get(nid)!), 201);
    }
    const m = id ? this.boite.get(id) : undefined;
    if (!m) return json({ error: { code: "ErrorItemNotFound" } }, 404);
    if (!sous && methode === "GET") return json(this.brut(m));
    if (!sous && methode === "PATCH") {
      this.boite.set(m.id, { ...m, ...(typeof corps.isRead === "boolean" ? { isRead: corps.isRead } : {}), ...(typeof corps.subject === "string" ? { subject: corps.subject } : {}) });
      return json(this.brut(this.boite.get(m.id)!));
    }
    if (sous === "move" && methode === "POST") return json(this.brut(this.deplacer(m, String(corps.destinationId))), 201);
    if (sous === "attachments" && !pj) return json({ value: [{ id: "pj-1", name: "piece.pdf", contentType: "application/pdf", size: 3, isInline: false }] });
    if (sous === "attachments" && pj && !valeur) return json({ id: pj, name: PIECE.nom, contentType: "application/pdf", size: PIECE.octets.length });
    if (sous === "attachments" && valeur === "$value") return new Response(PIECE.octets, { status: 200, headers: { "content-type": "application/pdf" } });
    return json({ error: { code: "BadRequest" } }, 400);
  }
}

const PIECE = { nom: "", octets: new Uint8Array(Buffer.from("%PDF-1.4 piece de test")) };

const ENV_DU_CAS: Record<string, string> = {
  MICROSOFT_MAIL: "1", MICROSOFT_TENANT_ID: "banc", MICROSOFT_CLIENT_ID: "banc", MICROSOFT_CLIENT_SECRET: "banc", MICROSOFT_REDIRECT_URI: "https://erp.banc.test/api/mail/callback",
  ADVENTUM_BASE_URL: "https://site.banc.test", ADVENTUM_API_KEY: "cle-du-banc",
};

/**
 * LE CAS SOUS RÉSEAU SIMULÉ. `fetch` est remplacé à la main (pas de `vi` dans un module de cas), puis le PORT RÉSEAU
 * (`effets/reseau.ts`) est réinstallé PAR-DESSUS : sous un geste, il note chaque écriture sortante comme en production —
 * le cas éprouve donc ce que l'annulation dit de ces appels. Tout est rendu dans le `finally`.
 */
async function sousReseauSimule<T>(fn: (g: FauxGraph) => Promise<T>): Promise<T> {
  const g = new FauxGraph();
  const globale = globalThis as { fetch: typeof fetch; __amdPortReseau?: true };
  const fetchAvant = globale.fetch;
  const portAvant = globale.__amdPortReseau;
  const envAvant = Object.fromEntries(Object.keys(ENV_DU_CAS).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV_DU_CAS);
  globale.fetch = (async (entree: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof entree === "string" ? entree : entree instanceof URL ? entree.href : entree.url);
    if (url.hostname === "graph.microsoft.com") return g.repondre(url, init);
    g.horsGraph.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    throw new Error(`appel réseau refusé par le banc : ${url.host}`);
  }) as typeof fetch;
  delete globale.__amdPortReseau;
  installerPortReseau();
  try {
    const r = await fn(g);
    expect(g.horsGraph, "un appel est sorti vers le réseau").toEqual([]);
    return r;
  } finally {
    globale.fetch = fetchAvant;
    if (portAvant) globale.__amdPortReseau = portAvant; else delete globale.__amdPortReseau;
    for (const [k, v] of Object.entries(envAvant)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

// ── La file ─────────────────────────────────────────────────────────────────────────────────

/** Les envois de la personne vers `cible` qui attendent leur fenêtre — compté dans `lire` (0 → 1 → 0 → 1 → 0). */
const enAttente = (moi: CurrentUser, type: string, cible: string) =>
  prisma.effetSortantDiffere.count({ where: { principalId: moi.id, type, cible: { contains: cible }, statut: "EN_ATTENTE" } });

const statutsDuGeste = async (gesteId: string) =>
  (await prisma.effetSortantDiffere.findMany({ where: { gesteId }, select: { type: true, statut: true }, orderBy: { creeLe: "asc" } })).map((l) => `${l.type}:${l.statut}`);

/** Après le cycle (ré-annulé en dernier) : chaque envoi du geste est ANNULE — il n'est jamais parti. */
async function fileAnnulee(gesteId: string, types: string[]): Promise<void> {
  expect(await statutsDuGeste(gesteId)).toEqual(types.map((t) => `${t}:ANNULE`));
}

// ── Les fixtures ────────────────────────────────────────────────────────────────────────────

const adresseBoite = (tag: string) => `${tag}boite@exemple.dz`.toLowerCase();

/** La boîte Microsoft de la personne : jeton chiffré, valide une heure (aucun rafraîchissement, donc aucun appel). */
const connecterMicrosoft = (moi: CurrentUser, tag: string) => {
  const data = { address: adresseBoite(tag), accessTokenEnc: sealSecret("jeton-du-banc"), refreshTokenEnc: sealSecret("rafraichi-du-banc"), expiresAt: new Date(Date.now() + 3_600_000), status: "connected" };
  return prisma.mailConnection.upsert({ where: { userId: moi.id }, create: { userId: moi.id, ...data }, update: data });
};

const destinataire = async (tag: string, suffixe: string) =>
  prisma.user.create({ data: { name: `${tag}dest ${suffixe}`, email: `${tag}dest-${suffixe}@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } });

const directive = (moi: CurrentUser, tag: string, destId: string, publiee: boolean) => prisma.directive.create({
  data: {
    reference: `${tag}-DIR-${publiee ? "R" : "P"}`, title: `${tag} directive`, body: "corps", audience: "USERS", targetUserIds: [destId], targetUserId: destId, fromId: moi.id,
    ...(publiee ? { publication: "PUBLISHED", publishedAt: new Date("2026-10-01T08:00:00Z"), sendCount: 1, lastSentAt: new Date("2026-10-01T08:00:00Z") } : { publication: "PENDING_APPROVAL" }),
  },
});

const lireDirective = async (moi: CurrentUser, id: string, destId: string) => ({
  directive: await prisma.directive.findUnique({ where: { id }, select: { publication: true, approvedById: true, approvedAt: true, publishedAt: true, decisionNote: true, sendCount: true, lastSentAt: true } }),
  notifications: await prisma.notification.findMany({ where: { userId: destId, link: `/directives/${id}` }, select: { title: true, isRead: true } }),
  pousseesEnAttente: await enAttente(moi, "push", destId),
});

const lireSite = (kind: "POST" | "JOB", externalId: string) =>
  prisma.sitePublication.findUnique({ where: { kind_externalId: { kind, externalId } }, select: { operation: true, body: true, bodyHash: true, version: true, state: true, attempts: true, nextAttemptAt: true, lastError: true } });

/** La file du site attend la fenêtre : l'échéance est repoussée (au moins quelques secondes). */
const attendLaFenetre = (p: { nextAttemptAt: Date } | null | undefined) => expect(p!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 5_000);

const leFutur = () => new Date(Date.now() + 3_600_000);

// ── Courriels ───────────────────────────────────────────────────────────────────────────────

const rectificatifDe = (l: { compensation: string | null }) =>
  prisma.effetSortantDiffere.findUnique({ where: { id: /\[([a-z0-9]+)\]$/.exec(l.compensation ?? "")?.[1] ?? "" } });

/**
 * PARTI PUIS ANNULÉ : l'action est jouée à l'écran, la fenêtre passe (`maintenant` dans le futur) et la file exécute
 * l'envoi par un transport de test (`apresDepart` : ce que le vrai écrit en base en partant) ; puis le geste est annulé.
 * L'exécuteur réel est remis dans le `finally` (sa compensation, elle, est la vraie pendant tout le cas).
 */
async function partiPuisAnnule(moi: CurrentUser, capaciteId: string, type: string, faire: () => Promise<{ ok?: boolean }>, apresDepart?: (ligneId: string) => Promise<void>) {
  const partis: unknown[] = [];
  const vrai = await EXECUTEURS[type]!();
  enregistrerExecuteur(type, { ...vrai, executer: async (c, l) => { partis.push(c); await apresDepart?.(l.id); } });
  try {
    const debut = new Date();
    const r = await aLEcran(moi, faire);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: moi.id, capaciteId, creeLe: { gte: debut } } });
    const [l] = await prisma.effetSortantDiffere.findMany({ where: { gesteId: g.id } });
    expect((await executerEffetsSortantsDus({ maintenant: leFutur(), ids: [l!.id] })).partis).toBe(1);
    const compte = await annulerGeste(g.id, moi);
    return { compte, ligne: await prisma.effetSortantDiffere.findUniqueOrThrow({ where: { id: l!.id } }), partis };
  } finally {
    enregistrerExecuteur(type, vrai);
  }
}

/** La boîte SMTP de la personne (mot de passe chiffré) ; le courrier « smart » ouvert (drapeau au stade TEST : compte en mode test). */
const boiteSmtp = (moi: CurrentUser, tag: string) =>
  prisma.mailAccount.upsert({ where: { userId: moi.id }, create: { userId: moi.id, email: adresseBoite(tag), passwordEnc: sealSecret("mot-de-passe") }, update: {} });
const courrierSmartOuvert = (moi: CurrentUser) => prisma.user.update({ where: { id: moi.id }, data: { testMode: true } });

const COURRIELS: CasReversible[] = [
  { id: "mail-actions:sendMailAction", titre: "le courriel SMTP n'est jamais parti : sa ligne de file est annulée, puis rétablie", jouer: (moi, tag) => sousReseauSimule(async () => {
    await boiteSmtp(moi, tag);
    const to = `${tag}smtp@exemple.dz`;
    const { gesteId } = await cycle({ id: "mail-actions:sendMailAction", moi, faire: () => sendMailAction(fd({ to, subject: `${tag} SMTP`, body: "corps" })),
      lire: () => enAttente(moi, "courriel.smtp", to) });
    await fileAnnulee(gesteId, ["courriel.smtp"]);
  }) },
  { id: "smart-mail-actions:sendMail", titre: "le courriel par API : la ligne d'envoi est retirée, la file annulée", jouer: (moi, tag) => sousReseauSimule(async () => {
    await courrierSmartOuvert(moi);
    const to = `${tag}api@exemple.dz`;
    const { gesteId, apres } = await cycle({ id: "smart-mail-actions:sendMail", moi, faire: () => envoyerCourrielSmart({ to, subject: `${tag} API`, body: "corps" }),
      lire: async () => ({ journal: await prisma.outboundEmail.findMany({ where: { toAddress: to }, select: { subject: true, status: true } }), file: await enAttente(moi, "courriel.api", to) }) });
    expect(apres).toEqual({ journal: [{ subject: `${tag} API`, status: "QUEUED" }], file: 1 });
    await fileAnnulee(gesteId, ["courriel.api"]);
  }) },
  { id: "mail-actions:sendMailAction", titre: "parti puis annulé : COMPENSÉ par un rectificatif en attente, jamais « effacé »", jouer: (moi, tag) => sousReseauSimule(async () => {
    await boiteSmtp(moi, tag);
    const { compte, ligne, partis } = await partiPuisAnnule(moi, "mail-actions:sendMailAction", "courriel.smtp", () => sendMailAction(fd({ to: `${tag}smtp-parti@exemple.dz`, subject: `${tag} SMTP parti`, body: "corps" })));
    if ("refus" in compte) throw new Error(compte.refus);
    expect(compte.complet, JSON.stringify(compte.details)).toBe(true);
    expect(compte.details.map((d) => d.issue)).toEqual(["COMPENSE"]);
    expect(compte.details[0]!.pourquoi).toMatch(/n'est pas effacé chez son destinataire/);
    expect(ligne.statut).toBe("COMPENSE");
    expect(await rectificatifDe(ligne)).toMatchObject({ statut: "EN_ATTENTE", type: "courriel.smtp" });
    expect(partis).toHaveLength(1);
  }) },
  { id: "smart-mail-actions:sendMail", titre: "parti puis annulé : COMPENSÉ par un rectificatif, le journal des courriels garde la trace de l'envoi", jouer: (moi, tag) => sousReseauSimule(async () => {
    await courrierSmartOuvert(moi);
    // Ce que fait le vrai exécuteur au départ : le journal des courriels passe à SENT (executeurs.ts, « courriel.api »).
    const marquerParti = (id: string) => prisma.outboundEmail.updateMany({ where: { providerId: `differe:${id}` }, data: { status: "SENT", providerId: "banc-1", sentAt: new Date() } }).then(() => undefined);
    const { compte, ligne, partis } = await partiPuisAnnule(moi, "smart-mail-actions:sendMail", "courriel.api", () => envoyerCourrielSmart({ to: `${tag}api-parti@exemple.dz`, subject: `${tag} API parti`, body: "corps" }), marquerParti);
    // La ligne `OutboundEmail` écrite par l'exécuteur au départ est la TRACE de ce qui est sorti (MODELES_JOURNAUX_ENVOI) :
    // elle reste, et l'envoi est compensé par un rectificatif différé.
    if ("refus" in compte) throw new Error(compte.refus);
    expect(compte.complet, JSON.stringify(compte.details)).toBe(true);
    expect(compte.details.map((d) => d.issue).sort(), JSON.stringify(compte.details)).toEqual(["COMPENSE", "SANS_OBJET"]);
    expect(ligne.statut).toBe("COMPENSE");
    expect(await rectificatifDe(ligne)).toMatchObject({ statut: "EN_ATTENTE", type: "courriel.api" });
    expect(partis).toHaveLength(1);
  }) },
];

// ── Microsoft 365 ───────────────────────────────────────────────────────────────────────────

/**
 * LE GESTE MICROSOFT IMMÉDIAT (lu, déplacé, brouillon) : l'annulation exécute le geste inverse (la boîte simulée revient,
 * la ligne « inverse » est COMPENSE). L'appel Graph lui-même n'est pas compté en double (`noterEffetFait` le rattache) :
 * le compte rendu est complet. L'état de la boîte est vérifié ici, en plus du banc.
 */
async function inverseExecute(r: { compte: CompteRenduAnnulation; avant: unknown; gesteId: string }, etat: unknown, type: string): Promise<void> {
  expect(r.compte.details.map((d) => d.issue).sort()).toEqual(["COMPENSE"]);
  expect(r.compte.complet).toBe(true);
  expect(etat, "la boîte Microsoft ne revient pas à l'état d'avant").toEqual(r.avant);
  expect(await statutsDuGeste(r.gesteId)).toEqual([`${type}:COMPENSE`]);
}

const MICROSOFT: CasReversible[] = [
  { id: "microsoft-mail-actions:sendMessage", titre: "le message Microsoft attend sa fenêtre : ni brouillon ni envoi chez Microsoft", jouer: (moi, tag) => sousReseauSimule(async (g) => {
    await connecterMicrosoft(moi, tag);
    const to = `${tag}graph@exemple.dz`;
    const { gesteId } = await cycle({ id: "microsoft-mail-actions:sendMessage", moi, faire: () => sendMessage(fd({ to, subject: `${tag} Graph`, bodyHtml: "<p>corps</p>" })),
      lire: () => enAttente(moi, "courriel.graph", to) });
    await fileAnnulee(gesteId, ["courriel.graph"]);
    expect(g.appels).toEqual([]);
  }) },
  { id: "microsoft-mail-actions:setMessageRead", titre: "le message marqué lu redevient non lu chez Microsoft (geste inverse)", jouer: (moi, tag) => sousReseauSimule(async (g) => {
    await connecterMicrosoft(moi, tag);
    const id = g.poser({ subject: `${tag} à lire`, isRead: false, folder: "inbox" });
    const r = await cycle({ id: "microsoft-mail-actions:setMessageRead", moi, complet: false, faire: () => setMessageRead(id, true), lire: async () => g.etat() });
    await inverseExecute(r, g.etat(), "inverse.graph.lu");
  }) },
  { id: "microsoft-mail-actions:moveMessage", titre: "le message déplacé revient dans son dossier d'origine", jouer: (moi, tag) => sousReseauSimule(async (g) => {
    await connecterMicrosoft(moi, tag);
    const id = g.poser({ subject: `${tag} à ranger`, isRead: true, folder: "inbox" });
    // Rétablir puis ré-annuler sont joués ici, pour suivre l'identifiant que Microsoft change à chaque déplacement.
    const r = await cycle({ id: "microsoft-mail-actions:moveMessage", moi, complet: false, retablir: false, faire: () => moveMessage(id, "archive"), lire: async () => g.etat() });
    await inverseExecute(r, g.etat(), "inverse.graph.deplace");
    const re = await retablirGeste(r.gesteId, moi);
    if ("refus" in re) throw new Error(re.refus);
    expect(g.etat()).toEqual(r.apres);
    const encore = await annulerGeste(r.gesteId, moi);
    if ("refus" in encore) throw new Error(encore.refus);
    // Le rejeu a gardé le nouvel identifiant chez Microsoft : la ré-annulation ramène le message dans son dossier d'origine.
    expect(encore.complet, JSON.stringify(encore.details)).toBe(true);
    expect(g.etat()).toEqual(r.avant);
  }) },
  { id: "microsoft-mail-actions:saveDraft", titre: "le brouillon créé part à la corbeille de la boîte, puis est recréé", jouer: (moi, tag) => sousReseauSimule(async (g) => {
    await connecterMicrosoft(moi, tag);
    const r = await cycle({ id: "microsoft-mail-actions:saveDraft", moi, complet: false, reussi: (x) => x.ok && !!x.id,
      faire: () => saveDraft(fd({ to: `${tag}x@exemple.dz`, subject: `${tag} brouillon`, bodyHtml: "<p>b</p>" })),
      lire: async () => g.etat().filter((m) => m.folder === "drafts") });
    await inverseExecute(r, g.etat().filter((m) => m.folder === "drafts"), "inverse.graph.brouillon");
  }) },
  { id: "microsoft-mail-actions:linkMessageToEntity", titre: "le lien du courriel à l'objet est retiré (rien n'a bougé chez Microsoft)", jouer: (moi, tag) => sousReseauSimule(async (g) => {
    const c = await connecterMicrosoft(moi, tag);
    const id = g.poser({ subject: `${tag} à lier`, isRead: true, folder: "inbox" });
    await cycle({ id: "microsoft-mail-actions:linkMessageToEntity", moi, faire: () => linkMessageToEntity(fd({ messageId: id, entityType: "DOSSIER", entityId: `${tag}dossier` })),
      lire: () => prisma.mailLink.findMany({ where: { connectionId: c.id, messageId: id }, select: { id: true, entityType: true, entityId: true, subject: true } }) });
    expect(g.appels.filter((a) => !a.startsWith("GET"))).toEqual([]);
  }) },
  { id: "microsoft-mail-actions:saveAttachmentToDrive", titre: "la pièce jointe entrée au Drive (fichier et provenance) est retirée", jouer: (moi, tag) => sousReseauSimule(async (g) => {
    const c = await connecterMicrosoft(moi, tag);
    PIECE.nom = `${tag} piece.pdf`;
    const id = g.poser({ subject: `${tag} avec pièce`, isRead: true, folder: "inbox" });
    await cycle({ id: "microsoft-mail-actions:saveAttachmentToDrive", moi, reussi: (r) => r.ok && !!r.nodeId,
      faire: () => saveAttachmentToDrive(fd({ messageId: id, attachmentId: "pj-1" })),
      lire: async () => ({
        fichiers: await prisma.driveNode.findMany({ where: { name: PIECE.nom }, select: { id: true, name: true, size: true } }),
        liens: await prisma.mailLink.findMany({ where: { connectionId: c.id, messageId: id }, select: { id: true, attachmentId: true, driveNodeId: true } }),
      }) });
    expect(g.appels.filter((a) => !a.startsWith("GET"))).toEqual([]);
  }) },
  { id: "microsoft-mail-actions:disconnectMicrosoftMail", titre: "la connexion, ses jetons chiffrés et ses liens sont recréés à l'identique", jouer: (moi, tag) => sousReseauSimule(async () => {
    const c = await connecterMicrosoft(moi, tag);
    await prisma.mailLink.create({ data: { connectionId: c.id, messageId: "msg-lie", subject: `${tag} lié`, entityType: "DOSSIER", entityId: "d1", createdById: moi.id } });
    await cycle({ id: "microsoft-mail-actions:disconnectMicrosoftMail", moi, faire: () => disconnectMicrosoftMail(),
      lire: async () => ({
        connexion: await prisma.mailConnection.findUnique({ where: { userId: moi.id }, select: { id: true, address: true, accessTokenEnc: true, refreshTokenEnc: true, expiresAt: true, status: true } }),
        liens: await prisma.mailLink.findMany({ where: { connectionId: c.id }, select: { id: true, messageId: true, subject: true } }),
      }) });
  }) },
];

// ── Directives ──────────────────────────────────────────────────────────────────────────────

const DIRECTIVES: CasReversible[] = [
  { id: "directive-actions:publishDirective", titre: "la directive repasse en attente, la notification non lue est retirée, la poussée ne part pas", jouer: (moi, tag) => sousReseauSimule(async () => {
    const dest = await destinataire(tag, "publication");
    const d = await directive(moi, tag, dest.id, false);
    const { gesteId, apres } = await cycle({ id: "directive-actions:publishDirective", moi, faire: () => publishDirective(fd({ id: d.id, note: "validée" })), lire: () => lireDirective(moi, d.id, dest.id) });
    expect(apres).toMatchObject({ directive: { publication: "PUBLISHED", sendCount: 1 }, notifications: [{ isRead: false }], pousseesEnAttente: 1 });
    await fileAnnulee(gesteId, ["push"]);
  }) },
  { id: "directive-actions:resendDirective", titre: "le rappel est retiré, le compteur d'envois rendu, la poussée ne part pas", jouer: (moi, tag) => sousReseauSimule(async () => {
    const dest = await destinataire(tag, "rappel");
    const d = await directive(moi, tag, dest.id, true);
    const { gesteId, apres } = await cycle({ id: "directive-actions:resendDirective", moi, faire: () => resendDirective(fd({ id: d.id })), lire: () => lireDirective(moi, d.id, dest.id) });
    expect(apres).toMatchObject({ directive: { sendCount: 2 }, notifications: [{ title: "Directive — rappel" }], pousseesEnAttente: 1 });
    await fileAnnulee(gesteId, ["push"]);
  }) },
];

// ── Site web ────────────────────────────────────────────────────────────────────────────────

const lireArticle = async (titre: string) => {
  const articles = await prisma.blogArticle.findMany({ where: { title: { startsWith: titre } }, select: { id: true, title: true, body: true, published: true, firstPublishedAt: true } });
  return { articles, file: await Promise.all(articles.map((a) => lireSite("POST", a.id))) };
};

const SITE: CasReversible[] = [
  { id: "site-web-actions:enregistrerArticle", titre: "l'article publié et son envoi en file (qui attendait sa fenêtre) sont retirés", jouer: (moi, tag) => sousReseauSimule(async () => {
    const titre = `${tag} Article neuf`;
    const { apres } = await cycle({ id: "site-web-actions:enregistrerArticle", moi, faire: () => enregistrerArticle(fd({ title: titre, body: "Un paragraphe.", intention: "publier" })), lire: () => lireArticle(titre) });
    const { file } = apres as Awaited<ReturnType<typeof lireArticle>>;
    expect(file[0]).toMatchObject({ state: "PENDING", operation: "PUT", version: 1 });
    attendLaFenetre(file[0]);
  }) },
  { id: "site-web-actions:enregistrerArticle", titre: "parti puis annulé : COMPENSÉ, la version d'avant est remise en file", jouer: (moi, tag) => sousReseauSimule(async () => {
    const titre = `${tag} Article en ligne`;
    const a = await prisma.blogArticle.create({ data: { title: titre, body: "Version 1.", published: true, firstPublishedAt: new Date("2026-10-01T08:00:00Z"), publishedOn: new Date("2026-10-01T08:00:00Z"), createdById: moi.id } });
    const v1 = await prisma.sitePublication.create({ data: { kind: "POST", externalId: a.id, label: titre, operation: "PUT", body: "{\"v\":1}", bodyHash: "h1", version: 1, state: "DONE", confirmedHash: "h1", lastStatus: 200 } });
    const debut = new Date();
    const r = await aLEcran(moi, () => enregistrerArticle(fd({ id: a.id, title: titre, body: "Version 2.", intention: "publier" })));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: moi.id, capaciteId: "site-web-actions:enregistrerArticle", creeLe: { gte: debut } } });
    const enFile = await lireSite("POST", a.id);
    expect(enFile).toMatchObject({ state: "PENDING", version: 2 });
    attendLaFenetre(enFile);
    // La fenêtre passée, la file l'envoie (transport de test : le site répond 200).
    const recus: string[] = [];
    const transport: TransportSite = async (q) => { recus.push(`${q.methode} ${q.chemin}`); return { statut: 200, texte: "{}", erreur: null, ms: 1, retryAfterS: null, location: null }; };
    expect((await viderFile({ transport, seulement: [v1.id], maintenant: leFutur() })).reussis).toBe(1);
    expect(recus).toHaveLength(1);
    expect(await lireSite("POST", a.id)).toMatchObject({ state: "DONE", version: 2 });
    const compte = await annulerGeste(g.id, moi);
    if ("refus" in compte) throw new Error(compte.refus);
    expect(compte.details.find((d) => /site/.test(d.pourquoi) && d.issue === "COMPENSE"), JSON.stringify(compte.details)).toBeTruthy();
    expect(compte.complet, JSON.stringify(compte.details)).toBe(true);
    // La base revient ; le site recevra la version d'avant par la même file (une version neuve, en attente).
    expect(await prisma.blogArticle.findUnique({ where: { id: a.id }, select: { body: true } })).toEqual({ body: "Version 1." });
    expect(await lireSite("POST", a.id)).toMatchObject({ operation: "PUT", body: "{\"v\":1}", bodyHash: "h1", state: "PENDING", version: 3 });
    expect(recus).toHaveLength(1);
  }) },
  { id: "site-web-actions:relancerEnvoiSite", titre: "l'envoi relancé revient en échec, tel qu'il était", jouer: (moi, tag) => sousReseauSimule(async () => {
    const a = await prisma.blogArticle.create({ data: { title: `${tag} Article en échec`, body: "x", published: true, createdById: moi.id } });
    const p = await prisma.sitePublication.create({ data: { kind: "POST", externalId: a.id, label: a.title, operation: "PUT", body: "{}", bodyHash: "h", state: "FAILED", attempts: 5, lastStatus: 503, lastError: "site injoignable", nextAttemptAt: new Date("2026-10-30T10:00:00Z") } });
    const { apres } = await cycle({ id: "site-web-actions:relancerEnvoiSite", moi, faire: () => relancerEnvoiSite(fd({ publicationId: p.id })), lire: () => lireSite("POST", a.id) });
    expect(apres).toMatchObject({ state: "PENDING", attempts: 0, lastError: null });
    attendLaFenetre(apres as { nextAttemptAt: Date });
  }) },
  { id: "recrutement-diffusion-actions:publierOffreSiteDuRecrutement", titre: "l'offre repasse en brouillon, son envoi au site (en fenêtre) est retiré", jouer: (moi, tag) => sousReseauSimule(async () => {
    const req = await prisma.recruitmentRequest.create({ data: { reference: `${tag}-REC`, requesterId: moi.id, position: `${tag} Délégué`, contractType: "CDI", stage: "SOURCING" } });
    const o = await prisma.jobPosting.create({ data: { recruitmentRequestId: req.id, title: `${tag} Délégué médical`, location: "Alger", summary: "Résumé.", mission: ["Visiter"], createdById: moi.id } });
    const { apres } = await cycle({ id: "recrutement-diffusion-actions:publierOffreSiteDuRecrutement", moi, faire: () => publierOffreSiteDuRecrutement(fd({ id: req.id, intention: "publier" })),
      lire: async () => ({ offre: await prisma.jobPosting.findUnique({ where: { id: o.id }, select: { published: true, title: true } }), file: await lireSite("JOB", o.id) }) });
    expect(apres).toMatchObject({ offre: { published: true }, file: { state: "PENDING", operation: "PUT" } });
    attendLaFenetre((apres as { file: { nextAttemptAt: Date } }).file);
  }) },
];

const nettoyerEnvois = async (tag: string) => {
  const articles = await prisma.blogArticle.findMany({ where: { title: { startsWith: tag } }, select: { id: true } });
  const offres = await prisma.jobPosting.findMany({ where: { title: { startsWith: tag } }, select: { id: true } });
  await prisma.sitePublication.deleteMany({ where: { externalId: { in: [...articles, ...offres].map((x) => x.id) } } }).catch(sansBloquer("banc-k10b.cas-envois"));
  await prisma.blogArticle.deleteMany({ where: { title: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-envois"));
  await prisma.jobPosting.deleteMany({ where: { title: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-envois"));
  await prisma.recruitmentRequest.deleteMany({ where: { reference: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-envois"));
  await prisma.directive.deleteMany({ where: { reference: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-envois"));
  await prisma.outboundEmail.deleteMany({ where: { subject: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-envois"));
  await prisma.mailConnection.deleteMany({ where: { address: { startsWith: tag.toLowerCase() } } }).catch(sansBloquer("banc-k10b.cas-envois"));
  await prisma.mailAccount.deleteMany({ where: { email: { startsWith: tag.toLowerCase() } } }).catch(sansBloquer("banc-k10b.cas-envois"));
  await prisma.driveNode.deleteMany({ where: { name: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-envois"));
  const dests = await prisma.user.findMany({ where: { name: { startsWith: `${tag}dest` } }, select: { id: true } });
  await prisma.notification.deleteMany({ where: { userId: { in: dests.map((u) => u.id) } } }).catch(sansBloquer("banc-k10b.cas-envois"));
  await prisma.user.deleteMany({ where: { id: { in: dests.map((u) => u.id) } } }).catch(sansBloquer("banc-k10b.cas-envois"));
};

export const CAS_ENVOIS: CasReversible[] = [...COURRIELS, ...MICROSOFT, ...DIRECTIVES, ...SITE].map((c, i) => (i === 0 ? { ...c, nettoyer: nettoyerEnvois } : c));
