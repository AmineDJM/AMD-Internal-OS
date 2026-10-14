import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { deleteFileByKey, readFileByKey } from "@/lib/storage";
import {
  classerCandidatureSite, effacerCandidatureSite, rattacherCandidatureSite, remettreCandidatureATrier,
} from "@/lib/actions/candidatures-site-actions";
import { formatDuCv, lireCandidature, peutTraiterCandidaturesSite, recevoirCandidature, SOURCE_SITE, CV_TAILLE_MAX } from "./candidatures";
import { GET as cvDeLaCandidature } from "@/app/api/site-web/candidatures/[id]/cv/route";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CANDIDATURES DU SITE (§118.159) — de la réception au tri, par les VRAIES fonctions et les
 * VRAIES actions, contre la vraie base. Les acteurs n'ont PAS la vue globale quand la règle doit
 * pouvoir refuser (§118.104) : les Finances n'ont ni les RH ni la direction.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__candsite__";
const RUN = Date.now().toString(36);
const idSite = (n: string) => `banc${RUN}-${n}`;

// Des octets qui SONT des CV, par leurs premiers octets — pas seulement par leur nom.
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 0x20), Buffer.from("\n%%EOF")]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 0x01)]);
const DOC = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(200, 0x02)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(300, 0x90)]);

/**
 * Un CV PROPRE à chaque candidature : le stockage déduplique par contenu, et un même PDF partagé
 * par tous les cas ferait compter au même fichier les références de tout le banc — on ne pourrait
 * plus rien affirmer du compteur d'une candidature.
 */
const pdfDe = (n: string) => Buffer.concat([PDF, Buffer.from(`\n% ${RUN}-${n}\n`)]);

function candidature(n: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: idSite(n), submittedAt: new Date().toISOString(), fullName: `${TAG}Candidat ${n}`, email: `cand.${n}@exemple.test`,
    phone: "+213 555 12 34 56", message: "Bonjour, je suis intéressé.", consent: true, language: "fr",
    cv: { fileName: `cv-${n}.pdf`, contentType: "application/pdf", base64: pdfDe(n).toString("base64") },
    ...extra,
  };
}

/** Combien de références le stockage compte pour le fichier de cette clé (0 : plus rien). */
async function references(cle: string): Promise<number> {
  const f = await prisma.storedFile.findUnique({ where: { key: cle }, select: { blobId: true } });
  if (!f) return 0;
  return (await prisma.fileBlob.findUnique({ where: { id: f.blobId }, select: { refCount: true } }))?.refCount ?? 0;
}

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole as SessionUser["role"] | null, access, mustChangePassword: false } as CurrentUser;
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

const notifs = (userId: string, title: string) => prisma.notification.count({ where: { userId, title } });

describe("Lire ce que le site envoie (pur)", () => {
  const m = new Date("2026-09-30T10:00:00Z");

  it("le format du CV se lit dans ses OCTETS : un exécutable renommé en .pdf ne passe pas", () => {
    expect(formatDuCv("cv.pdf", PDF)).toEqual({ ext: "pdf", type: "application/pdf" });
    expect(formatDuCv("cv.docx", DOCX)?.ext).toBe("docx");
    expect(formatDuCv("cv.odt", DOCX)?.ext).toBe("odt");
    expect(formatDuCv("cv.doc", DOC)?.ext).toBe("doc");
    expect(formatDuCv("cv.pdf", EXE)).toBeNull();
    expect(formatDuCv("cv.docx", PDF), "un PDF renommé en .docx n'est pas un Word").toBeNull();
    expect(formatDuCv("cv.exe", EXE)).toBeNull();
    expect(formatDuCv("cv.pdf", Buffer.from("%PDF"))).toBeNull();
  });

  it("chaque faute est NOMMÉE — une réponse 422 muette ferait réessayer le site indéfiniment", () => {
    const lu = (j: unknown) => lireCandidature(j, m);
    const faute = (j: unknown) => { const r = lu(j); return r.ok ? null : r.erreur; };
    expect(faute(null)).toMatch(/objet JSON/);
    expect(faute(candidature("a", { id: "court" }))).toMatch(/`id`/);
    expect(faute(candidature("a", { id: "avec des espaces !" }))).toMatch(/`id`/);
    expect(faute(candidature("a", { fullName: " " }))).toMatch(/fullName/);
    expect(faute(candidature("a", { email: "pas-une-adresse" }))).toMatch(/email/);
    expect(faute(candidature("a", { consent: false }))).toMatch(/consent/);
    expect(faute(candidature("a", { consent: "true" })), "le consentement est un booléen VRAI, pas une chaîne").toMatch(/consent/);
    expect(faute(candidature("a", { phone: "appelez-moi" }))).toMatch(/phone/);
    expect(faute(candidature("a", { cv: { fileName: "cv.pdf", base64: "!!!" } }))).toMatch(/base64/);
    expect(faute(candidature("a", { cv: { fileName: "cv.pdf", base64: EXE.toString("base64") } }))).toMatch(/contenu ne correspond pas/);
    expect(faute(candidature("a", { cv: { fileName: "cv.pdf", base64: Buffer.alloc(CV_TAILLE_MAX + 1, 0x20).toString("base64") } }))).toMatch(/dépasse/);
    expect(faute(candidature("a", { cv: { fileName: "cv.pdf", base64: PDF.toString("base64"), sha256: "0".repeat(64) } }))).toMatch(/altéré/);
  });

  it("ce qui se lit : sans CV c'est permis ; une date du futur n'est pas crue ; l'adresse est mise en minuscules", () => {
    const r = lireCandidature(candidature("b", { cv: null, email: "Cand.B@Exemple.TEST", submittedAt: "2099-01-01T00:00:00Z" }), m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.c.cv).toBeNull();
    expect(r.c.email).toBe("cand.b@exemple.test");
    expect(r.c.soumiseLe.getTime(), "c'est la RÉCEPTION qui fait foi").toBe(m.getTime());
    const avecOffre = lireCandidature(candidature("c", { job: { externalId: "ck1", slug: "pharmacien", title: "Pharmacien" } }), m);
    expect(avecOffre.ok && avecOffre.c.offre).toEqual({ externalId: "ck1", slug: "pharmacien", titre: "Pharmacien" });
  });
});

suite("Candidatures du site — réception, rattachement, tri", () => {
  const ids: Record<string, string> = {};

  async function nettoyer() {
    const lignes = await prisma.siteCandidature.findMany({ where: { siteId: { startsWith: `banc${RUN}` } }, select: { cvCle: true } });
    const docs = await prisma.document.findMany({ where: { fileKey: { startsWith: `site-candidatures/banc${RUN}` } }, select: { id: true, fileKey: true } });
    await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
    for (const k of new Set([...lignes.map((l) => l.cvCle), ...docs.map((d) => d.fileKey)])) if (k) await deleteFileByKey(k).catch(() => undefined);
    await prisma.siteCandidature.deleteMany({ where: { siteId: { startsWith: `banc${RUN}` } } });
    await prisma.jobPosting.deleteMany({ where: { title: { startsWith: TAG } } });
    await prisma.recruitmentRequest.deleteMany({ where: { position: { startsWith: TAG } } });
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
  }

  const demande = (n: string, stage: string) => prisma.recruitmentRequest.create({
    data: { reference: `REC-${RUN}-${n}`, requesterId: ids.demandeur!, position: `${TAG}${n}`, contractType: "CDI", stage: stage as never },
    select: { id: true, reference: true },
  });
  const offre = (n: string, requestId: string | null) => prisma.jobPosting.create({
    data: { title: `${TAG}Offre ${n}`, recruitmentRequestId: requestId, published: true },
    select: { id: true, title: true },
  });

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [dir, fin, demandeur] = await Promise.all([faire("dir", "DIRECTION"), faire("fin", "FINANCE_BUDGET_MANAGER"), faire("dem", "HEAD_OF_SALES")]);
    Object.assign(ids, { dir: dir.id, fin: fin.id, demandeur: demandeur.id });
  });

  afterEach(() => { ACTOR = null; });
  afterAll(async () => { await nettoyer(); });

  it("PRÉMISSES : la Direction trie ; les Finances ne trient pas (sans quoi les refus ne prouveraient rien)", async () => {
    expect(peutTraiterCandidaturesSite(await actorFor(ids.dir!))).toBe(true);
    expect(peutTraiterCandidaturesSite(await actorFor(ids.fin!))).toBe(false);
  });

  it("SPONTANÉE : elle attend le tri, avec sa RAISON ; le CV est stocké tel quel ; les RH sont prévenues une fois", async () => {
    const avant = await notifs(ids.dir!, "Candidature reçue du site — à trier");
    const r = await recevoirCandidature(candidature("spont"));
    expect(r).toMatchObject({ ok: true, deja: false, etat: "NOUVELLE" });
    const l = await prisma.siteCandidature.findUniqueOrThrow({ where: { siteId: idSite("spont") } });
    expect(l).toMatchObject({ etat: "NOUVELLE", motif: "Candidature spontanée.", consentement: true, cvType: "application/pdf", cvTaille: pdfDe("spont").length });
    expect((await readFileByKey(l.cvCle!)).equals(pdfDe("spont"))).toBe(true);
    expect(await notifs(ids.dir!, "Candidature reçue du site — à trier")).toBe(avant + 1);

    // Renvoyée (le site n'a pas reçu la réponse) : rien n'est recréé, personne n'est re-dérangé.
    const r2 = await recevoirCandidature(candidature("spont"));
    expect(r2).toMatchObject({ ok: true, deja: true });
    expect(await prisma.siteCandidature.count({ where: { siteId: idSite("spont") } })).toBe(1);
    expect(await notifs(ids.dir!, "Candidature reçue du site — à trier")).toBe(avant + 1);
  });

  it("CINQ ENVOIS SIMULTANÉS de la même candidature : UNE ligne, UNE notification, le même identifiant pour tous", async () => {
    const avant = await notifs(ids.dir!, "Candidature reçue du site — à trier");
    const rs = await Promise.all(Array.from({ length: 5 }, () => recevoirCandidature(candidature("concurrence"))));
    expect(rs.every((r) => r.ok)).toBe(true);
    const idsRendus = new Set(rs.map((r) => (r.ok ? r.id : "")));
    expect(idsRendus.size).toBe(1);
    expect(rs.filter((r) => r.ok && !r.deja)).toHaveLength(1);
    expect(await prisma.siteCandidature.count({ where: { siteId: idSite("concurrence") } })).toBe(1);
    expect(await notifs(ids.dir!, "Candidature reçue du site — à trier")).toBe(avant + 1);
    // UNE référence au fichier, pas cinq : sinon effacer la candidature laisserait le CV en base.
    const l = await prisma.siteCandidature.findUniqueOrThrow({ where: { siteId: idSite("concurrence") } });
    expect(await references(l.cvCle!)).toBe(1);
  });

  it("POSTE OUVERT : elle entre D'ELLE-MÊME dans le recrutement, CV compris, et le demandeur est prévenu", async () => {
    const d = await demande("ouvert", "SOURCING");
    const o = await offre("ouvert", d.id);
    const avant = await notifs(ids.demandeur!, "CV reçu à présélectionner");
    const r = await recevoirCandidature(candidature("auto", { job: { externalId: o.id, title: o.title } }));
    expect(r).toMatchObject({ ok: true, etat: "RATTACHEE" });
    const l = await prisma.siteCandidature.findUniqueOrThrow({ where: { siteId: idSite("auto") } });
    expect(l.candidateId).not.toBeNull();
    expect(l.jobPostingId).toBe(o.id);
    const cand = await prisma.recruitmentCandidate.findUniqueOrThrow({ where: { id: l.candidateId! } });
    expect(cand).toMatchObject({ requestId: d.id, source: SOURCE_SITE, email: `cand.auto@exemple.test`, addedById: null });
    const doc = await prisma.document.findFirstOrThrow({ where: { entityType: "RECRUITMENT_CANDIDATE", entityId: cand.id } });
    expect(doc.fileKey).toBe(l.cvCle);
    expect(await notifs(ids.demandeur!, "CV reçu à présélectionner")).toBe(avant + 1);
  });

  it("POSTE FERMÉ, OFFRE SANS RECRUTEMENT, OFFRE INCONNUE : chacune attend le tri avec SA raison — rien n'est deviné", async () => {
    const ferme = await demande("ferme", "CLOSED");
    const oFerme = await offre("ferme", ferme.id);
    const oLibre = await offre("libre", null);
    await recevoirCandidature(candidature("ferme", { job: { externalId: oFerme.id, title: oFerme.title } }));
    await recevoirCandidature(candidature("libre", { job: { externalId: oLibre.id, title: oLibre.title } }));
    await recevoirCandidature(candidature("inconnue", { job: { externalId: "ck-inconnue", title: "Chef de projet" } }));
    const motif = async (n: string) => (await prisma.siteCandidature.findUniqueOrThrow({ where: { siteId: idSite(n) } })).motif;
    expect(await motif("ferme")).toMatch(/n'est plus ouvert \(étape CLOSED\)/);
    expect(await motif("libre")).toMatch(/n'est rattachée à aucun recrutement/);
    expect(await motif("inconnue")).toMatch(/Offre inconnue de l'ERP \(« Chef de projet » sur le site\)/);
    expect(await prisma.recruitmentCandidate.count({ where: { requestId: ferme.id } }), "un poste fermé ne reçoit rien en silence").toBe(0);
  });

  it("RATTACHER : la porte du tri ET celle de la demande ; un poste ouvert seulement ; deux clics simultanés ne font qu'un candidat", async () => {
    const ouvert = await demande("r-ouvert", "SOURCING");
    const ferme = await demande("r-ferme", "CLOSED");
    const r = await recevoirCandidature(candidature("rattacher"));
    expect(r.ok).toBe(true);
    const id = r.ok ? r.id : "";

    ACTOR = await actorFor(ids.fin!);
    expect((await rattacherCandidatureSite(form({ id, requestId: ouvert.id }))).ok).toBe(false);
    ACTOR = await actorFor(ids.dir!);
    const surFerme = await rattacherCandidatureSite(form({ id, requestId: ferme.id }));
    expect(surFerme.ok).toBe(false);
    expect(surFerme.error).toMatch(/OUVERT/);

    const [a, b] = await Promise.all([
      rattacherCandidatureSite(form({ id, requestId: ouvert.id })),
      rattacherCandidatureSite(form({ id, requestId: ouvert.id })),
    ]);
    expect([a, b].filter((x) => x.ok)).toHaveLength(1);
    expect([a, b].find((x) => !x.ok)?.error).toMatch(/traitée|déjà/);
    expect(await prisma.recruitmentCandidate.count({ where: { requestId: ouvert.id } })).toBe(1);
    const l = await prisma.siteCandidature.findUniqueOrThrow({ where: { id } });
    expect(l).toMatchObject({ etat: "RATTACHEE", traiteeParId: ids.dir, motif: null });
    expect(await prisma.document.count({ where: { entityType: "RECRUITMENT_CANDIDATE", entityId: l.candidateId!, fileKey: l.cvCle! } })).toBe(1);
  });

  it("CLASSER, REMETTRE, EFFACER : chaque geste une fois ; effacer retire le CV — sauf s'il est devenu la pièce d'un candidat", async () => {
    const r = await recevoirCandidature(candidature("tri"));
    const id = r.ok ? r.id : "";
    ACTOR = await actorFor(ids.fin!);
    expect((await classerCandidatureSite(form({ id }))).ok).toBe(false);
    expect((await effacerCandidatureSite(form({ id }))).ok).toBe(false);

    ACTOR = await actorFor(ids.dir!);
    expect((await classerCandidatureSite(form({ id, motif: "Profil éloigné" }))).ok).toBe(true);
    expect(await prisma.siteCandidature.findUniqueOrThrow({ where: { id } })).toMatchObject({ etat: "CLASSEE", motif: "Profil éloigné" });
    expect((await classerCandidatureSite(form({ id }))).ok, "déjà classée").toBe(false);
    expect((await remettreCandidatureATrier(form({ id }))).ok).toBe(true);
    expect((await prisma.siteCandidature.findUniqueOrThrow({ where: { id } })).etat).toBe("NOUVELLE");

    const cle = (await prisma.siteCandidature.findUniqueOrThrow({ where: { id } })).cvCle!;
    const blob = (await prisma.storedFile.findUniqueOrThrow({ where: { key: cle } })).blobId;
    expect((await effacerCandidatureSite(form({ id }))).ok).toBe(true);
    expect(await prisma.siteCandidature.count({ where: { id } })).toBe(0);
    expect(await prisma.storedFile.count({ where: { key: cle } }), "le droit à l'oubli emporte le CV").toBe(0);
    expect(await prisma.fileBlob.count({ where: { id: blob } }), "… jusqu'à ses octets chiffrés").toBe(0);

    // RATTACHÉE : elle se traite depuis la fiche du candidat, pas d'ici.
    const d = await demande("tri-ouvert", "SOURCING");
    const o = await offre("tri-ouvert", d.id);
    const r2 = await recevoirCandidature(candidature("tri-auto", { job: { externalId: o.id, title: o.title } }));
    const id2 = r2.ok ? r2.id : "";
    expect((await effacerCandidatureSite(form({ id: id2 }))).ok).toBe(false);

    // …sauf si ce candidat n'existe plus : la ligne part, mais le fichier reste tant qu'un Document le désigne.
    const l2 = await prisma.siteCandidature.findUniqueOrThrow({ where: { id: id2 } });
    await prisma.recruitmentCandidate.delete({ where: { id: l2.candidateId! } });
    expect((await effacerCandidatureSite(form({ id: id2 }))).ok).toBe(true);
    expect(await prisma.storedFile.count({ where: { key: l2.cvCle! } }), "le Document du candidat désigne encore ce fichier").toBe(1);
  });

  it("LE CV SE SERT DERRIÈRE LA SESSION ET LA PORTE DU TRI — et son téléchargement est tracé", async () => {
    const r = await recevoirCandidature(candidature("cv"));
    const id = r.ok ? r.id : "";
    const appel = (dl = false) => cvDeLaCandidature(new NextRequest(`http://erp.test/api/site-web/candidatures/${id}/cv${dl ? "?dl=1" : ""}`), { params: { id } });

    ACTOR = null;
    expect((await appel()).status).toBe(401);
    ACTOR = await actorFor(ids.fin!);
    expect((await appel()).status).toBe(403);
    ACTOR = await actorFor(ids.dir!);
    const ok = await appel();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await ok.arrayBuffer()).equals(pdfDe("cv"))).toBe(true);
    const avant = await prisma.auditLog.count({ where: { actorId: ids.dir, action: "EXPORT", entityId: id } });
    expect((await appel(true)).headers.get("content-disposition")).toMatch(/^attachment/);
    expect(await prisma.auditLog.count({ where: { actorId: ids.dir, action: "EXPORT", entityId: id } })).toBe(avant + 1);
  });
});
