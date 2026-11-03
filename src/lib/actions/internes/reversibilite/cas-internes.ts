import { sansBloquer } from "@/lib/journal";
import crypto from "node:crypto";
import http from "node:http";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { prisma } from "@/lib/prisma";
import { retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import { createMailEntry, editMailEntry, setMailDate, attachDriveNodeToMail } from "@/lib/actions/mail-register-actions";
import { addMailPiece, updateMailPiece } from "@/lib/actions/mail-piece-actions";
import { createMailPartner, updateMailPartner } from "@/lib/actions/mail-partner-actions";
import { createMailFolder, updateMailFolder, moveMailEntries } from "@/lib/actions/mail-folder-actions";
import { classerCandidatureSite, rattacherCandidatureSite, remettreCandidatureATrier } from "@/lib/actions/candidatures-site-actions";
import { modifierChampPersonnalise, saveCustomValues } from "@/lib/actions/custom-field-actions";
import { linkEmailToDossier } from "@/lib/actions/dossier-actions";
import { reglerAffectationKpi, reglerFrequenceRevue } from "@/lib/actions/kpi-actions";
import { reglerNumerotationPieces } from "@/lib/actions/fabrique-actions";
import { publierRegles } from "@/lib/actions/segmentation-actions";
import {
  enregistrerTexteCanal, envoyerOffreEmploitic, marquerCanalPublie, preparerPostLinkedIn, retirerCanal,
} from "@/lib/actions/recrutement-diffusion-actions";
import { abandonnerCleSite, genererCleSite, rapprocherSiteMaintenant, verifierConnexionSite } from "@/lib/actions/site-web-actions";
import { connectMailbox, disconnectMailbox } from "@/lib/actions/mail-actions";
import { encryptSecret } from "@/lib/mail";
import { cycle, fd, type CasReversible } from "./banc";

/**
 * K10b (décision 0035) — LES CAS « EXÉCUTER PUIS ANNULER » DES ÉCRITURES INTERNES (rien ne sort de l'ERP). Chaque cas joue
 * la vraie action de l'écran (`cycle`) contre la base locale. Joués par `communications.test.ts`.
 */

const pli = async (moi: CurrentUser, tag: string, suffixe = "") => (await prisma.mailEntry.create({ data: { title: `${tag} pli${suffixe}`, direction: "INCOMING", createdById: moi.id } })).id;
const lirePli = (id: string) => prisma.mailEntry.findUnique({ where: { id }, select: { title: true, reference: true, notes: true, receivedAt: true, acknowledgedAt: true, folderId: true } });

const COURRIER: CasReversible[] = [
  { id: "mail-register-actions:createMailEntry", titre: "le pli créé est retiré, puis rétabli à l'identique", jouer: (moi, tag) => cycle({ id: "mail-register-actions:createMailEntry", moi,
    faire: () => createMailEntry(undefined, fd({ title: `${tag} nouveau`, direction: "OUTGOING", reference: "R-1" })),
    lire: () => prisma.mailEntry.findMany({ where: { title: `${tag} nouveau` }, select: { id: true, title: true, reference: true, direction: true } }) }).then(() => undefined) },
  { id: "mail-register-actions:editMailEntry", titre: "les valeurs d'avant réécrites", jouer: async (moi, tag) => {
    const id = await pli(moi, tag, " édité");
    await cycle({ id: "mail-register-actions:editMailEntry", moi, faire: () => editMailEntry(id, undefined, fd({ title: `${tag} pli corrigé`, direction: "INCOMING", notes: "note" })), lire: () => lirePli(id) });
  } },
  { id: "mail-register-actions:setMailDate", titre: "la date posée est retirée", jouer: async (moi, tag) => {
    const id = await pli(moi, tag, " daté");
    await cycle({ id: "mail-register-actions:setMailDate", moi, faire: () => setMailDate({ id, field: "acknowledgedAt", value: "2026-10-30" }), lire: () => lirePli(id) });
  } },
  { id: "mail-register-actions:attachDriveNodeToMail", titre: "le pli né du fichier du Drive est retiré, le fichier reste", jouer: async (moi, tag) => {
    const node = await prisma.driveNode.create({ data: { name: `${tag} scan.pdf`, type: "FILE", ownerId: moi.id } });
    await cycle({ id: "mail-register-actions:attachDriveNodeToMail", moi, faire: () => attachDriveNodeToMail({ driveNodeId: node.id, title: `${tag} scanné` }),
      lire: async () => ({ plis: await prisma.mailEntry.count({ where: { driveNodeId: node.id } }), fichier: await prisma.driveNode.count({ where: { id: node.id } }) }) });
  } },
  { id: "mail-piece-actions:addMailPiece", titre: "la pièce ajoutée est retirée", jouer: async (moi, tag) => {
    const id = await pli(moi, tag, " pièces");
    const node = await prisma.driveNode.create({ data: { name: `${tag} annexe.pdf`, type: "FILE", ownerId: moi.id } });
    await cycle({ id: "mail-piece-actions:addMailPiece", moi, faire: () => addMailPiece(fd({ entryId: id, driveNodeId: node.id, label: `${tag} annexe`, recipient: "Karim" })),
      lire: () => prisma.mailEntryPiece.findMany({ where: { entryId: id }, select: { id: true, label: true, recipient: true } }) });
  } },
  { id: "mail-piece-actions:updateMailPiece", titre: "la pièce corrigée retrouve son libellé", jouer: async (moi, tag) => {
    const id = await pli(moi, tag, " pièce corrigée");
    const p = await prisma.mailEntryPiece.create({ data: { entryId: id, label: `${tag} pièce`, recipient: "A", createdById: moi.id } });
    await cycle({ id: "mail-piece-actions:updateMailPiece", moi, faire: () => updateMailPiece(fd({ id: p.id, label: `${tag} pièce corrigée`, recipient: "B" })),
      lire: () => prisma.mailEntryPiece.findUnique({ where: { id: p.id }, select: { label: true, recipient: true } }) });
  } },
  { id: "mail-partner-actions:createMailPartner", titre: "le partenaire créé est retiré", jouer: (moi, tag) => cycle({ id: "mail-partner-actions:createMailPartner", moi,
    faire: () => createMailPartner(undefined, fd({ name: `${tag} SARL Nouveau`, kind: "Fournisseur" })),
    lire: () => prisma.mailPartner.findMany({ where: { name: `${tag} SARL Nouveau` }, select: { id: true, name: true, kind: true } }) }).then(() => undefined) },
  { id: "mail-partner-actions:updateMailPartner", titre: "le partenaire modifié est remis", jouer: async (moi, tag) => {
    const p = await prisma.mailPartner.create({ data: { name: `${tag} SARL Ancien`, kind: "Client" } });
    await cycle({ id: "mail-partner-actions:updateMailPartner", moi, faire: () => updateMailPartner(fd({ id: p.id, name: `${tag} SARL Ancien`, kind: "Partenaire", contact: "0550" })),
      lire: () => prisma.mailPartner.findUnique({ where: { id: p.id }, select: { name: true, kind: true, contact: true, isActive: true } }) });
  } },
  { id: "mail-folder-actions:createMailFolder", titre: "le dossier créé est retiré", jouer: (moi, tag) => cycle({ id: "mail-folder-actions:createMailFolder", moi,
    faire: () => createMailFolder(undefined, fd({ name: `${tag} Dossier neuf` })),
    lire: () => prisma.mailEntryFolder.findMany({ where: { name: `${tag} Dossier neuf` }, select: { id: true, name: true } }) }).then(() => undefined) },
  { id: "mail-folder-actions:updateMailFolder", titre: "le renommage est défait", jouer: async (moi, tag) => {
    const d = await prisma.mailEntryFolder.create({ data: { name: `${tag} Dossier A` } });
    await cycle({ id: "mail-folder-actions:updateMailFolder", moi, faire: () => updateMailFolder(fd({ id: d.id, name: `${tag} Dossier A renommé`, description: "x" })),
      lire: () => prisma.mailEntryFolder.findUnique({ where: { id: d.id }, select: { name: true, description: true } }) });
  } },
  { id: "mail-folder-actions:moveMailEntries", titre: "les courriers rangés reviennent à leur place", jouer: async (moi, tag) => {
    const d = await prisma.mailEntryFolder.create({ data: { name: `${tag} Dossier B` } });
    const a = await pli(moi, tag, " à ranger 1");
    const b = await pli(moi, tag, " à ranger 2");
    await cycle({ id: "mail-folder-actions:moveMailEntries", moi, faire: () => moveMailEntries(fd({ entryId: [a, b], folderId: d.id })),
      lire: () => prisma.mailEntry.findMany({ where: { id: { in: [a, b] } }, select: { id: true, folderId: true }, orderBy: { id: "asc" } }) });
  } },
];

const nettoyerCourrier = async (tag: string) => {
  await prisma.mailEntryPiece.deleteMany({ where: { label: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-internes"));
  await prisma.mailEntry.deleteMany({ where: { title: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-internes"));
  await prisma.mailEntryFolder.deleteMany({ where: { name: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-internes"));
  await prisma.mailPartner.deleteMany({ where: { name: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-internes"));
  await retirerNoeudsDriveEtContenu({ where: { name: { startsWith: tag } } }).catch(sansBloquer("banc-k10b.cas-internes"));
};

// ───────────────────────────── Les auxiliaires des autres écritures internes ─────────────────────────────

/** Pose des variables d'environnement le temps d'un cas, puis rend les valeurs d'avant (absentes comprises). */
async function avecEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const avant = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(avant)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const ecouter = (s: http.Server | tls.Server): Promise<number> => new Promise((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as AddressInfo).port)));
const fermer = (s: http.Server | tls.Server): Promise<void> => new Promise((ok) => s.close(() => ok()));

/**
 * LE SITE PUBLIC, JOUÉ SUR LA MACHINE : un serveur HTTP local qui répond comme le site (santé authentifiée, aucune
 * offre, aucun article). `ADVENTUM_BASE_URL` en http n'est admise que vers un hôte local, et la garde de sortie la
 * laisse passer : rien ne quitte la machine.
 */
async function avecSiteLocal<T>(fn: () => Promise<T>): Promise<T> {
  const reponses: Record<string, unknown> = {
    "/api/v1/health": { configured: true, authenticated: true, capabilities: ["jobs", "posts", "applications"], bootId: "banc-k10b", serverTime: "2026-10-31T10:00:00Z" },
    "/api/v1/jobs": { jobs: [] },
    "/api/v1/posts": { posts: [] },
  };
  const site = http.createServer((req, res) => {
    const corps = reponses[(req.url ?? "").split("?")[0]!];
    res.writeHead(corps ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(corps ?? { error: "inconnu" }));
  });
  const port = await ecouter(site);
  try {
    return await avecEnv({ ADVENTUM_BASE_URL: `http://127.0.0.1:${port}`, ADVENTUM_API_KEY: "cle-banc-k10b" }, fn);
  } finally {
    await fermer(site);
  }
}

/** Un certificat X.509 auto-signé pour `localhost` (P-256, une heure), écrit en DER à la main : aucun outil externe. */
function certificatLocal(): { key: string; cert: string } {
  const der = (tag: number, ...p: Buffer[]) => {
    const b = Buffer.concat(p);
    const n = b.length;
    return Buffer.concat([Buffer.from([tag]), n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]), b]);
  };
  const seq = (...p: Buffer[]) => der(0x30, ...p);
  const temps = (d: Date) => der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const algo = seq(Buffer.from("06082a8648ce3d040302", "hex")); // ecdsa-with-SHA256
  const nom = seq(der(0x31, seq(Buffer.from("0603550403", "hex"), der(0x0c, Buffer.from("localhost"))))); // CN=localhost
  const tbs = seq(der(0x02, Buffer.from([1])), algo, nom, seq(temps(new Date(Date.now() - 60_000)), temps(new Date(Date.now() + 3_600_000))), nom,
    publicKey.export({ type: "spki", format: "der" }));
  const cert = seq(tbs, algo, der(0x03, Buffer.from([0]), crypto.sign("sha256", tbs, privateKey)));
  return { key: String(privateKey.export({ type: "pkcs8", format: "pem" })), cert: `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n` };
}

/**
 * LA BOÎTE IMAP, JOUÉE SUR LA MACHINE : un serveur TLS local qui accepte la connexion (salut, LOGIN, CAPABILITY, LIST,
 * LOGOUT). Son certificat est ajouté aux autorités le temps du cas, puis la liste d'avant est rendue : la vérification
 * TLS reste entière.
 */
async function avecImapLocal<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const { key, cert } = certificatLocal();
  const boite = tls.createServer({ key, cert }, (s) => {
    s.on("error", () => undefined);
    s.write("* OK [CAPABILITY IMAP4rev1] banc K10b\r\n");
    let tampon = "";
    s.on("data", (d) => {
      tampon += String(d);
      for (let i = tampon.indexOf("\r\n"); i >= 0; i = tampon.indexOf("\r\n")) {
        const [etiquette, commande] = tampon.slice(0, i).split(" ");
        tampon = tampon.slice(i + 2);
        if (commande?.toUpperCase() === "LOGOUT") s.end(`* BYE\r\n${etiquette} OK\r\n`);
        else s.write(`${etiquette} OK fait\r\n`);
      }
    });
  });
  const port = await ecouter(boite);
  // Node ≥ 22.19 (les types installés ne les décrivent pas encore).
  const ca = tls as unknown as { getCACertificates: (q: "default") => string[]; setDefaultCACertificates: (l: string[]) => void };
  const autorites = ca.getCACertificates("default");
  ca.setDefaultCACertificates([...autorites, cert]);
  try {
    return await fn(port);
  } finally {
    ca.setDefaultCACertificates(autorites);
    await fermer(boite);
  }
}

/** Une demande de recrutement au poste OUVERT (étape SOURCING) — la porte de la diffusion et du rattachement. */
const demande = async (moi: CurrentUser, tag: string, suffixe: string) => (await prisma.recruitmentRequest.create({
  data: { reference: `${tag}-REC-${suffixe}`, requesterId: moi.id, position: `${tag} Délégué ${suffixe}`, contractType: "CDI", stage: "SOURCING" },
})).id;
const lireCanal = (requestId: string, channel: string) => prisma.recruitmentChannelPost.findUnique({
  where: { requestId_channel: { requestId, channel } }, select: { status: true, content: true, url: true, error: true, publishedAt: true, publishedById: true },
});

const candidature = async (tag: string, suffixe: string, etat = "NOUVELLE") => (await prisma.siteCandidature.create({
  data: { siteId: `k10b-${Date.now().toString(36)}-${suffixe}`, nom: `${tag} Candidat ${suffixe}`, email: `${suffixe}@candidat.dz`, etat, consentement: true, soumiseLe: new Date() },
})).id;
const lireCandidature = (id: string) => prisma.siteCandidature.findUnique({ where: { id }, select: { etat: true, motif: true, candidateId: true, traiteeParId: true, traiteeLe: true } });

/** Un champ personnalisé de fichier du Drive, sur un nœud du Drive (le plus simple des objets qui portent `custom`). */
const champDuDrive = async (moi: CurrentUser, tag: string, suffixe: string) => {
  const cle = `${tag.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_${suffixe}`;
  await prisma.customFieldDef.create({ data: { entityType: "DRIVE_NODE", key: cle, label: `${tag} Lot ${suffixe}`, type: "TEXT" } });
  const node = await prisma.driveNode.create({ data: { name: `${tag} fiche ${suffixe}.pdf`, type: "FILE", ownerId: moi.id, custom: { [cle]: "L-100" } } });
  return { cle, nodeId: node.id, lire: () => prisma.driveNode.findUnique({ where: { id: node.id }, select: { custom: true } }) };
};

const lireLiaison = () => prisma.appSetting.findUnique({ where: { id: "global" }, select: { siteSante: true, siteSanteAt: true, siteBootId: true, siteBlocageEmpreinte: true } });
const lireCles = () => prisma.siteWebCle.findMany({ select: { id: true, etat: true, retireeLe: true }, orderBy: { creeLe: "asc" } });
const lireBoite = (moi: CurrentUser) => prisma.mailAccount.findUnique({ where: { userId: moi.id }, select: { id: true, email: true, displayName: true, imapHost: true, imapPort: true, smtpHost: true, smtpPort: true, passwordEnc: true, signature: true } });

const AUTRES: CasReversible[] = [
  // ── Les candidatures du site ──
  { id: "candidatures-site-actions:classerCandidatureSite", titre: "la candidature classée revient « à trier »", jouer: async (moi, tag) => {
    const id = await candidature(tag, "classer");
    await cycle({ id: "candidatures-site-actions:classerCandidatureSite", moi, faire: () => classerCandidatureSite(fd({ id, motif: "Profil hors besoin" })), lire: () => lireCandidature(id) });
  } },
  { id: "candidatures-site-actions:remettreCandidatureATrier", titre: "la candidature remise à trier redevient classée", jouer: async (moi, tag) => {
    const id = await candidature(tag, "remettre", "CLASSEE");
    await prisma.siteCandidature.update({ where: { id }, data: { motif: "Classée sans suite.", traiteeParId: moi.id, traiteeLe: new Date("2026-10-30T09:00:00Z") } });
    await cycle({ id: "candidatures-site-actions:remettreCandidatureATrier", moi, faire: () => remettreCandidatureATrier(fd({ id })), lire: () => lireCandidature(id) });
  } },
  { id: "candidatures-site-actions:rattacherCandidatureSite", titre: "le candidat créé au recrutement est retiré, la candidature revient « à trier »", jouer: async (moi, tag) => {
    const id = await candidature(tag, "rattacher");
    const requestId = await demande(moi, tag, "rattacher");
    await cycle({ id: "candidatures-site-actions:rattacherCandidatureSite", moi, faire: () => rattacherCandidatureSite(fd({ id, requestId })),
      lire: async () => ({ candidature: await lireCandidature(id), candidats: await prisma.recruitmentCandidate.findMany({ where: { requestId }, select: { id: true, fullName: true, source: true } }) }) });
  } },
  // ── Les champs personnalisés ──
  { id: "custom-field-actions:modifierChampPersonnalise", titre: "le champ modifié retrouve sa valeur", jouer: async (moi, tag) => {
    const c = await champDuDrive(moi, tag, "un");
    await cycle({ id: "custom-field-actions:modifierChampPersonnalise", moi, faire: () => modifierChampPersonnalise(fd({ entityType: "DRIVE_NODE", entityId: c.nodeId, field: c.cle, value: "L-204" })), lire: c.lire });
  } },
  { id: "custom-field-actions:saveCustomValues", titre: "les champs enregistrés retrouvent leurs valeurs", jouer: async (moi, tag) => {
    const c = await champDuDrive(moi, tag, "tous");
    await cycle({ id: "custom-field-actions:saveCustomValues", moi, faire: () => saveCustomValues(fd({ entityType: "DRIVE_NODE", entityId: c.nodeId, [`cf_${c.cle}`]: "L-305" })), lire: c.lire });
  } },
  // ── Les sujets ──
  { id: "dossier-actions:linkEmailToDossier", titre: "le courriel versé au sujet en est retiré", jouer: async (moi, tag) => {
    const d = await prisma.dossier.create({ data: { reference: `${tag}-DOS`, title: `${tag} Sujet`, createdById: moi.id } });
    await cycle({ id: "dossier-actions:linkEmailToDossier", moi,
      faire: () => linkEmailToDossier({ dossierId: d.id, from: "fournisseur@exemple.dz", subject: "Devis", date: "2026-10-30T09:00:00Z", body: "Ci-joint." }),
      lire: () => prisma.dossierMessage.findMany({ where: { dossierId: d.id }, select: { id: true, body: true, authorId: true } }) });
  } },
  // ── Les KPI ──
  { id: "kpi-actions:reglerAffectationKpi", titre: "l'affectation créée pour le rôle est retirée", jouer: async (moi, tag) => {
    await prisma.kpiDefinition.create({ data: { famille: `${tag}-kpi`, nom: `${tag} Visites`, nature: "DECLARE", unite: "NOMBRE", portee: "CATALOGUE" } });
    await cycle({ id: "kpi-actions:reglerAffectationKpi", moi, faire: () => reglerAffectationKpi(fd({ famille: `${tag}-kpi`, cible: "ROLE", role: "DELEGUE_MEDICAL", poids: "25" })),
      lire: () => prisma.kpiAssignment.findMany({ where: { famille: `${tag}-kpi` }, select: { id: true, cible: true, role: true, poids: true } }) });
  } },
  { id: "kpi-actions:reglerFrequenceRevue", titre: "le réglage de revue créé est retiré", jouer: (moi) => cycle({ id: "kpi-actions:reglerFrequenceRevue", moi,
    faire: () => reglerFrequenceRevue(fd({ frequence: "TRIMESTRIELLE" })),
    lire: () => prisma.kpiReviewSetting.findUnique({ where: { managerUserId: moi.id }, select: { id: true, frequence: true } }) }).then(() => undefined) },
  // ── La numérotation des pièces ──
  { id: "fabrique-actions:reglerNumerotationPieces", titre: "le profil documentaire né du réglage est retiré", jouer: async (moi, tag) => {
    const s = await prisma.company.create({ data: { name: `${tag} Société` } });
    await cycle({ id: "fabrique-actions:reglerNumerotationPieces", moi,
      faire: () => reglerNumerotationPieces(undefined, fd({ societe: s.id, type: "FACTURE", motif: "{n:3}/FS/{aa}", depart: "32", annee: "2026" })),
      lire: () => prisma.companyDocumentProfile.findUnique({ where: { companyId: s.id }, select: { id: true, settings: true } }) });
  } },
  // ── La segmentation ──
  { id: "segmentation-actions:publierRegles", titre: "la version publiée est retirée", jouer: async (moi, tag) => {
    const bu = await prisma.businessUnit.create({ data: { name: `${tag} BU` } });
    const p = await prisma.product.create({ data: { code: `${tag}-P`, canonicalName: `${tag} Produit`, dci: `${tag} dci`, identityKey: `${tag}-P` } });
    const s = await prisma.segmentationStrategie.create({ data: { businessUnitId: bu.id, nom: `${tag} Stratégie`, produits: { create: { productId: p.id, rang: 1 } } } });
    const regles = { produits: [{ productId: p.id, seuilPotentiel: 5, seuilAffinite: 0.5 }], h: { frequence: 1 } };
    await cycle({ id: "segmentation-actions:publierRegles", moi, faire: () => publierRegles(s.id, JSON.stringify(regles), "première version"),
      lire: () => prisma.segmentationRegle.findMany({ where: { strategieId: s.id }, select: { id: true, version: true, note: true } }) });
  } },
  // ── La diffusion d'une offre ──
  { id: "recrutement-diffusion-actions:enregistrerTexteCanal", titre: "le texte du canal retrouve sa version d'avant", jouer: async (moi, tag) => {
    const id = await demande(moi, tag, "texte");
    await prisma.recruitmentChannelPost.create({ data: { requestId: id, channel: "LINKEDIN", status: "PREPARE", content: "Premier jet" } });
    await cycle({ id: "recrutement-diffusion-actions:enregistrerTexteCanal", moi, faire: () => enregistrerTexteCanal(fd({ id, canal: "LINKEDIN", texte: "Texte relu" })), lire: () => lireCanal(id, "LINKEDIN") });
  } },
  { id: "recrutement-diffusion-actions:preparerPostLinkedIn", titre: "le post préparé (modèle sans IA, sans clé de modèle) est retiré", jouer: async (moi, tag) => {
    const id = await demande(moi, tag, "linkedin");
    await avecEnv({ OPENAI_API_KEY: "" }, () => cycle({ id: "recrutement-diffusion-actions:preparerPostLinkedIn", moi, faire: () => preparerPostLinkedIn(fd({ id })), lire: () => lireCanal(id, "LINKEDIN") }));
  } },
  { id: "recrutement-diffusion-actions:marquerCanalPublie", titre: "le canal marqué publié retrouve son état « préparé »", jouer: async (moi, tag) => {
    const id = await demande(moi, tag, "publie");
    await prisma.recruitmentChannelPost.create({ data: { requestId: id, channel: "LINKEDIN", status: "PREPARE", content: "Post" } });
    await cycle({ id: "recrutement-diffusion-actions:marquerCanalPublie", moi, faire: () => marquerCanalPublie(fd({ id, canal: "LINKEDIN", url: "https://www.linkedin.com/posts/banc" })), lire: () => lireCanal(id, "LINKEDIN") });
  } },
  { id: "recrutement-diffusion-actions:retirerCanal", titre: "le canal retiré redevient publié", jouer: async (moi, tag) => {
    const id = await demande(moi, tag, "retire");
    await prisma.recruitmentChannelPost.create({ data: { requestId: id, channel: "AUTRE", status: "PUBLIE", content: "Job board", publishedAt: new Date("2026-10-30T09:00:00Z"), publishedById: moi.id } });
    await cycle({ id: "recrutement-diffusion-actions:retirerCanal", moi, faire: () => retirerCanal(fd({ id, canal: "AUTRE" })), lire: () => lireCanal(id, "AUTRE") });
  } },
  { id: "recrutement-diffusion-actions:envoyerOffreEmploitic", titre: "l'état ÉCHEC écrit par l'envoi (clé posée, API non branchée : refus attendu) est retiré", jouer: async (moi, tag) => {
    const id = await demande(moi, tag, "emploitic");
    await avecEnv({ EMPLOITIC_API_KEY: "cle-banc-k10b" }, () => cycle({ id: "recrutement-diffusion-actions:envoyerOffreEmploitic", moi,
      faire: () => envoyerOffreEmploitic(fd({ id })), reussi: () => true, lire: () => lireCanal(id, "EMPLOITIC") }));
  } },
  // ── La liaison au site public ──
  { id: "site-web-actions:genererCleSite", titre: "la clé en attente générée est retirée", jouer: (moi) => cycle({ id: "site-web-actions:genererCleSite", moi, faire: () => genererCleSite(), lire: lireCles }).then(() => undefined) },
  { id: "site-web-actions:abandonnerCleSite", titre: "la clé en attente abandonnée est rétablie", jouer: async (moi, tag) => {
    // Une clé au sceau factice (jamais ouverte ici) ; retirée sitôt le cas joué, pour que la vérification de la liaison
    // ne trouve aucune clé en attente.
    const cle = await prisma.siteWebCle.create({ data: { etat: "ATTENTE", cle: "scellee", secret: "scelle", empreinte: tag.slice(-12), creeParId: moi.id } });
    try {
      await cycle({ id: "site-web-actions:abandonnerCleSite", moi, faire: () => abandonnerCleSite(), lire: lireCles });
    } finally {
      await prisma.siteWebCle.deleteMany({ where: { id: cle.id } });
    }
  } },
  { id: "site-web-actions:verifierConnexionSite", titre: "la santé du site (local) enregistrée par la vérification est rendue à sa valeur d'avant", jouer: (moi) => avecSiteLocal(() =>
    cycle({ id: "site-web-actions:verifierConnexionSite", moi, faire: () => verifierConnexionSite(), lire: lireLiaison })).then(() => undefined) },
  { id: "site-web-actions:rapprocherSiteMaintenant", titre: "le rapprochement avec le site (local) est retiré", jouer: (moi) => avecSiteLocal(() =>
    cycle({ id: "site-web-actions:rapprocherSiteMaintenant", moi, faire: () => rapprocherSiteMaintenant(),
      lire: () => prisma.siteReconciliation.findMany({ where: { byId: moi.id }, select: { id: true, ok: true, error: true, finishedAt: true } }) })).then(() => undefined) },
  // ── La boîte mail ──
  { id: "mail-actions:connectMailbox", titre: "la boîte connectée (serveur IMAP local) est retirée", jouer: (moi, tag) => avecImapLocal((port) =>
    cycle({ id: "mail-actions:connectMailbox", moi, lire: () => lireBoite(moi),
      faire: () => connectMailbox(fd({ email: `${tag}boite@t.dz`, password: "mot-de-passe-app", imapHost: "localhost", imapPort: String(port) })) })).then(() => undefined) },
  { id: "mail-actions:disconnectMailbox", titre: "la boîte déconnectée est recréée à l'identique", jouer: async (moi, tag) => {
    await prisma.mailAccount.create({ data: { userId: moi.id, email: `${tag}boite2@t.dz`, displayName: "Banc", passwordEnc: encryptSecret("mot-de-passe-app"), signature: "— Banc" } });
    await cycle({ id: "mail-actions:disconnectMailbox", moi, faire: () => disconnectMailbox(), lire: () => lireBoite(moi) });
  } },
];

const nettoyerAutres = async (tag: string) => {
  const ignorer = () => undefined;
  const moi = await prisma.user.findMany({ where: { name: { startsWith: tag } }, select: { id: true } });
  const ids = moi.map((u) => u.id);
  await prisma.siteCandidature.deleteMany({ where: { nom: { startsWith: tag } } }).catch(ignorer);
  await prisma.recruitmentRequest.deleteMany({ where: { reference: { startsWith: tag } } }).catch(ignorer);
  await prisma.customFieldDef.deleteMany({ where: { label: { startsWith: tag } } }).catch(ignorer);
  await prisma.dossier.deleteMany({ where: { reference: { startsWith: tag } } }).catch(ignorer);
  await prisma.kpiAssignment.deleteMany({ where: { famille: { startsWith: tag } } }).catch(ignorer);
  await prisma.kpiDefinition.deleteMany({ where: { famille: { startsWith: tag } } }).catch(ignorer);
  await prisma.kpiReviewSetting.deleteMany({ where: { managerUserId: { in: ids } } }).catch(ignorer);
  await prisma.company.deleteMany({ where: { name: { startsWith: tag } } }).catch(ignorer);
  await prisma.segmentationStrategie.deleteMany({ where: { nom: { startsWith: tag } } }).catch(ignorer);
  await prisma.product.deleteMany({ where: { code: { startsWith: tag } } }).catch(ignorer);
  await prisma.businessUnit.deleteMany({ where: { name: { startsWith: tag } } }).catch(ignorer);
  await prisma.siteWebCle.deleteMany({ where: { OR: [{ creeParId: { in: ids } }, { empreinte: tag.slice(-12) }] } }).catch(ignorer);
  await prisma.siteReconciliation.deleteMany({ where: { byId: { in: ids } } }).catch(ignorer);
  await prisma.mailAccount.deleteMany({ where: { email: { startsWith: tag } } }).catch(ignorer);
};

export const CAS_INTERNES: CasReversible[] = [
  ...COURRIER.map((c, i) => (i === 0 ? { ...c, nettoyer: nettoyerCourrier } : c)),
  ...AUTRES.map((c, i) => (i === 0 ? { ...c, nettoyer: nettoyerAutres } : c)),
];
