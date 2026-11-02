import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteFileByKey, saveFile } from "@/lib/storage";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { enSerie } from "@/lib/refs";
import { isTopManagement, rolesWithModule, userCan, type SessionUser } from "@/lib/rbac";
import { inscrireDocumentExistant } from "@/modules/bibliotheque/api-inscription";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CANDIDATURES DÉPOSÉES SUR LE SITE PUBLIC (§118.159).
 *
 * Avant, « Postuler » ouvrait la messagerie du candidat vers une adresse générale : le CV arrivait
 * dans une boîte, et l'ERP n'en savait rien. Le site envoie désormais chaque candidature ICI, et
 * elle entre dans le recrutement par le même chemin qu'un CV déposé à la main.
 *
 * ── OÙ ELLE VA ──────────────────────────────────────────────────────────────────────────
 *
 *   • à une offre rattachée à un recrutement OUVERT (étape SOURCING) → elle entre D'ELLE-MÊME dans
 *     le pipeline de ce recrutement (`RecruitmentCandidate`), CV compris, et le demandeur est
 *     prévenu comme pour un CV déposé par les RH ;
 *   • sinon — spontanée, offre sans recrutement, poste déjà pourvu, offre inconnue de l'ERP —
 *     elle attend dans la boîte d'arrivée des RH, avec la RAISON pour laquelle elle n'est pas
 *     entrée seule. Deviner le recrutement d'une candidature spontanée choisirait à la place d'un
 *     humain (§118.34) ; la perdre serait pire.
 *
 * ── CE QUI N'EST JAMAIS FAIT ────────────────────────────────────────────────────────────
 *
 *   • rien sans CONSENTEMENT : le site le fait cocher, l'ERP le revérifie et refuse sans lui ;
 *   • aucun doublon : l'identifiant du SITE est la clé d'idempotence — un renvoi (réessai du site,
 *     réponse perdue) rend la candidature déjà reçue, sans seconde notification ;
 *   • aucun fichier pris sur sa parole : l'extension ET les premiers octets doivent dire PDF,
 *     Word ou OpenDocument. Un exécutable renommé en `.pdf` ne passe pas.
 *
 * Un CV est une donnée PERSONNELLE : la boîte d'arrivée ne s'ouvre qu'aux RH (écriture) et à la
 * direction — la même porte que l'instruction d'un recrutement (`recruitment/access.ts`). Une fois
 * rattachée, la candidature suit la porte de SA demande, comme tout CV.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le CV : cinq mégaoctets, comme le site l'annonce au candidat. */
export const CV_TAILLE_MAX = 5 * 1024 * 1024;
/** La requête entière : le CV en base64 (+ un tiers) et les champs. */
export const REQUETE_TAILLE_MAX = 8 * 1024 * 1024;
export const SOURCE_SITE = "Site web — adventumdz.com";

export const ETATS_CANDIDATURE = ["NOUVELLE", "RATTACHEE", "CLASSEE"] as const;
export type EtatCandidature = (typeof ETATS_CANDIDATURE)[number];

/** Qui trie la boîte d'arrivée : les RH (écriture) et la direction — la porte du recrutement. */
export function peutTraiterCandidaturesSite(user: SessionUser): boolean {
  return userCan(user, "RH", "UPDATE") || isTopManagement(user);
}

// ───────────────────────────── Lire ce que le site envoie (pur) ─────────────────────────────

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
};

/**
 * LE FORMAT DU CV, lu dans ses OCTETS autant que dans son nom : `%PDF-` pour un PDF, l'en-tête
 * ZIP pour un .docx ou un .odt, l'en-tête OLE pour un .doc. Rend `null` sur tout le reste — une
 * extension n'est qu'une déclaration.
 */
export function formatDuCv(nom: string, octets: Buffer): { ext: string; type: string } | null {
  const ext = (nom.split(".").pop() ?? "").toLowerCase();
  const type = TYPES[ext];
  if (!type || octets.length < 8) return null;
  const debut = octets.subarray(0, 8);
  const pdf = debut.subarray(0, 5).toString("latin1") === "%PDF-";
  const zip = debut[0] === 0x50 && debut[1] === 0x4b && debut[2] === 0x03 && debut[3] === 0x04;
  const ole = debut.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const ok = (ext === "pdf" && pdf) || ((ext === "docx" || ext === "odt") && zip) || (ext === "doc" && ole);
  return ok ? { ext, type } : null;
}

/** Un nom de fichier sûr pour le stockage et pour l'en-tête de téléchargement. */
export function nomDeFichierSur(nom: string): string {
  const base = nom.normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim();
  return (base || "cv").slice(-120);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ID_SITE = /^[A-Za-z0-9-]{8,64}$/;

export interface CandidatureLue {
  siteId: string;
  soumiseLe: Date;
  offre: { externalId: string | null; slug: string | null; titre: string | null } | null;
  nom: string;
  email: string;
  telephone: string | null;
  message: string | null;
  consentement: boolean;
  langue: string | null;
  cv: { nom: string; type: string; taille: number; empreinte: string; octets: Buffer } | null;
}

const txt = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n/g, "\n").trim();
  return s ? s.slice(0, max) : null;
};

/**
 * LIT UNE CANDIDATURE telle que le site l'envoie (`docs/ERP-INTEGRATION.md` du site, §11) et rend
 * la PREMIÈRE faute — nommée, pour le journal du site : une réponse 422 qui ne dirait pas pourquoi
 * ferait réessayer le site indéfiniment sur la même faute.
 */
export function lireCandidature(j: unknown, maintenant: Date = new Date()): { ok: true; c: CandidatureLue } | { ok: false; erreur: string } {
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, erreur: "Le corps doit être un objet JSON." };
  const b = j as Record<string, unknown>;
  const siteId = typeof b.id === "string" ? b.id.trim() : "";
  if (!ID_SITE.test(siteId)) return { ok: false, erreur: "`id` : identifiant du site attendu (8 à 64 caractères, lettres, chiffres, tirets)." };
  const nom = txt(b.fullName, 160);
  if (!nom || nom.length < 2) return { ok: false, erreur: "`fullName` est obligatoire." };
  const email = (txt(b.email, 254) ?? "").toLowerCase();
  if (!EMAIL.test(email)) return { ok: false, erreur: "`email` n'est pas une adresse lisible." };
  if (b.consent !== true) return { ok: false, erreur: "`consent` doit valoir true : sans consentement, la candidature n'est pas traitée." };
  const telephone = txt(b.phone, 40);
  if (telephone && !/^[+()\d\s.-]{6,40}$/.test(telephone)) return { ok: false, erreur: "`phone` n'est pas un numéro lisible." };

  let soumiseLe = maintenant;
  if (typeof b.submittedAt === "string") {
    const d = new Date(b.submittedAt);
    // Une date du futur ou illisible n'est pas crue : c'est la RÉCEPTION qui fait foi.
    if (!Number.isNaN(d.getTime()) && d.getTime() <= maintenant.getTime() + 5 * 60_000) soumiseLe = d;
  }

  let offre: CandidatureLue["offre"] = null;
  if (b.job && typeof b.job === "object" && !Array.isArray(b.job)) {
    const o = b.job as Record<string, unknown>;
    offre = { externalId: txt(o.externalId, 128), slug: txt(o.slug, 120), titre: txt(o.title, 200) };
    if (!offre.externalId && !offre.slug && !offre.titre) offre = null;
  }

  let cv: CandidatureLue["cv"] = null;
  if (b.cv !== undefined && b.cv !== null) {
    if (typeof b.cv !== "object" || Array.isArray(b.cv)) return { ok: false, erreur: "`cv` doit être un objet." };
    const c = b.cv as Record<string, unknown>;
    const nomCv = nomDeFichierSur(txt(c.fileName, 200) ?? "cv");
    const b64 = typeof c.base64 === "string" ? c.base64.replace(/\s+/g, "") : "";
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, erreur: "`cv.base64` est absent ou illisible." };
    const octets = Buffer.from(b64, "base64");
    if (octets.length === 0) return { ok: false, erreur: "Le CV est vide." };
    if (octets.length > CV_TAILLE_MAX) return { ok: false, erreur: `Le CV dépasse ${CV_TAILLE_MAX / (1024 * 1024)} Mo.` };
    const format = formatDuCv(nomCv, octets);
    if (!format) return { ok: false, erreur: "Le CV doit être un PDF, un Word (.doc, .docx) ou un OpenDocument (.odt) — son contenu ne correspond pas." };
    const empreinte = createHash("sha256").update(octets).digest("hex");
    if (typeof c.sha256 === "string" && c.sha256.trim() && c.sha256.trim().toLowerCase() !== empreinte) {
      return { ok: false, erreur: "Le CV reçu ne correspond pas à son empreinte (`cv.sha256`) : il a été altéré en route." };
    }
    cv = { nom: nomCv, type: format.type, taille: octets.length, empreinte, octets };
  }

  return {
    ok: true,
    c: {
      siteId, soumiseLe, offre, nom, email, telephone, message: txt(b.message, 5_000), consentement: true,
      langue: txt(b.language, 12), cv,
    },
  };
}

// ───────────────────────────── Recevoir ─────────────────────────────

export type Reception =
  | { ok: true; id: string; deja: boolean; etat: EtatCandidature }
  | { ok: false; statut: 400 | 422; erreur: string };

/** Pourquoi une candidature n'entre pas seule dans un recrutement — lue par les RH sur l'écran de tri. */
function motifDeTri(offre: CandidatureLue["offre"], trouvee: { stage: string | null; titre: string } | null, rattachable: boolean): string | null {
  if (rattachable) return null;
  if (!offre) return "Candidature spontanée.";
  if (!trouvee) return `Offre inconnue de l'ERP${offre.titre ? ` (« ${offre.titre} » sur le site)` : ""} — sans doute saisie dans l'administration du site.`;
  if (trouvee.stage === null) return `L'offre « ${trouvee.titre} » n'est rattachée à aucun recrutement.`;
  return `Le poste « ${trouvee.titre} » n'est plus ouvert (étape ${trouvee.stage}) : à rattacher, ou à classer.`;
}

const cleDeStockage = (siteId: string, nom: string) => `site-candidatures/${siteId}/${nom}`;

/**
 * REÇOIT UNE CANDIDATURE du site. Idempotente sur l'identifiant du site ; le CV est écrit AVANT la
 * ligne (un CV sans ligne se réécrit au prochain essai, une ligne sans CV serait une candidature
 * amputée) ; les notifications partent APRÈS la transaction, et une seule fois.
 *
 * LES RENVOIS D'UNE MÊME CANDIDATURE PASSENT UN PAR UN (`enSerie`, par identifiant du site). Le site
 * réessaie quand il n'a pas reçu la réponse, et deux essais peuvent se croiser. Sans la file, tous
 * deux voient « pas encore de CV », l'écrivent, et le stockage dédupliqué compte DEUX références
 * pour un seul fichier : effacer la candidature (droit à l'oubli) n'en retirerait qu'une, et le CV
 * resterait physiquement en base. La contrainte d'unicité reste le filet entre deux processus.
 */
export async function recevoirCandidature(j: unknown, maintenant: Date = new Date()): Promise<Reception> {
  const lu = lireCandidature(j, maintenant);
  if (!lu.ok) return { ok: false, statut: 422, erreur: lu.erreur };
  return enSerie(`site-candidature:${lu.c.siteId}`, () => recevoirLue(lu.c, maintenant));
}

async function recevoirLue(c: CandidatureLue, maintenant: Date): Promise<Reception> {
  const deja = await prisma.siteCandidature.findUnique({ where: { siteId: c.siteId }, select: { id: true, etat: true } });
  if (deja) return { ok: true, id: deja.id, deja: true, etat: deja.etat as EtatCandidature };

  let cvCle: string | null = null;
  if (c.cv) {
    cvCle = cleDeStockage(c.siteId, c.cv.nom);
    // Réécrire la MÊME clé gonflerait le compteur de références du contenu (le stockage est
    // dédupliqué) : un réessai après une transaction perdue retrouve le fichier et ne le réécrit
    // pas. Sans cette garde, effacer la candidature laisserait le CV en base jusqu'au ramasse-miettes.
    const present = await prisma.storedFile.findUnique({ where: { key: cvCle }, select: { key: true } });
    if (!present) await saveFile(cvCle, c.cv.octets);
  }

  const offre = c.offre?.externalId
    ? await prisma.jobPosting.findUnique({
        where: { id: c.offre.externalId },
        select: { id: true, title: true, recruitmentRequest: { select: { id: true, reference: true, stage: true, requesterId: true, position: true } } },
      })
    : null;
  const demande = offre?.recruitmentRequest ?? null;
  const rattachable = demande?.stage === "SOURCING";
  const motif = motifDeTri(c.offre, offre ? { stage: demande?.stage ?? null, titre: offre.title } : null, rattachable);

  let cree: { id: string; candidateId: string | null };
  try {
    cree = await prisma.$transaction(async (tx) => {
      let candidateId: string | null = null;
      if (rattachable && demande) {
        const cand = await tx.recruitmentCandidate.create({
          data: {
            requestId: demande.id, fullName: c.nom, email: c.email, phone: c.telephone, source: SOURCE_SITE,
            notes: c.message, addedById: null,
          },
          select: { id: true },
        });
        candidateId = cand.id;
        if (c.cv && cvCle) {
          await tx.document.create({
            data: {
              name: c.cv.nom, category: "OTHER", entityType: "RECRUITMENT_CANDIDATE", entityId: cand.id, fileKey: cvCle,
              mimeType: c.cv.type, sizeBytes: c.cv.taille, version: 1, confidentiality: "INTERNAL", uploadedById: null,
            },
          });
        }
      }
      const ligne = await tx.siteCandidature.create({
        data: {
          siteId: c.siteId, jobPostingId: offre?.id ?? null, offreTitre: c.offre?.titre ?? offre?.title ?? null,
          offreRef: c.offre?.externalId ?? c.offre?.slug ?? null, nom: c.nom, email: c.email, telephone: c.telephone,
          message: c.message, cvCle, cvNom: c.cv?.nom ?? null, cvType: c.cv?.type ?? null, cvTaille: c.cv?.taille ?? null,
          cvEmpreinte: c.cv?.empreinte ?? null, etat: candidateId ? "RATTACHEE" : "NOUVELLE", motif, candidateId,
          consentement: true, langue: c.langue, soumiseLe: c.soumiseLe, recueLe: maintenant,
          traiteeLe: candidateId ? maintenant : null,
        },
        select: { id: true },
      });
      return { id: ligne.id, candidateId };
    });
  } catch (e) {
    // Deux envois simultanés de la MÊME candidature (réessai du site pendant que le premier
    // s'écrivait) : la contrainte d'unicité tranche, et le perdant rend celle du gagnant.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const g = await prisma.siteCandidature.findUnique({ where: { siteId: c.siteId }, select: { id: true, etat: true } });
      if (g) return { ok: true, id: g.id, deja: true, etat: g.etat as EtatCandidature };
    }
    throw e;
  }

  // Le CV rattaché à un candidat entre à la bibliothèque (J1), sous la clé de son document. Ne lève jamais.
  if (cree.candidateId && cvCle) await inscrireCvDuCandidat(cree.candidateId, cvCle);
  const offreLibre = c.offre?.titre ?? offre?.title ?? null;
  if (cree.candidateId && demande) {
    await notifyUser({
      userId: demande.requesterId, type: "GENERIC", title: "CV reçu à présélectionner",
      body: `${demande.reference} — ${c.nom} (candidature déposée sur le site)`, link: `/recrutement/${demande.id}`,
    });
    await notifyRoles(rolesWithModule("RH", "UPDATE"), {
      type: "GENERIC", title: "Candidature reçue du site",
      body: `${c.nom} — ${demande.reference} · ${demande.position}`, link: `/recrutement/${demande.id}`,
    });
  } else {
    await notifyRoles(rolesWithModule("RH", "UPDATE"), {
      type: "GENERIC", title: "Candidature reçue du site — à trier",
      body: `${c.nom} — ${offreLibre ?? "candidature spontanée"}. ${motif ?? ""}`.trim(), link: "/recrutement/candidatures",
    });
  }
  await recordAudit({
    actorId: null, action: "CREATE", module: "Recrutement",
    ...(cree.candidateId ? { entityType: "RECRUITMENT_CANDIDATE" as const, entityId: cree.candidateId } : { entityId: cree.id }),
    summary: `Candidature reçue du site : ${c.nom}${offreLibre ? ` — ${offreLibre}` : " — spontanée"}${cree.candidateId && demande ? ` (entrée dans ${demande.reference})` : " (à trier)"}`,
  });
  return { ok: true, id: cree.id, deja: false, etat: cree.candidateId ? "RATTACHEE" : "NOUVELLE" };
}

/** Le document du CV d'un candidat, écrit dans une transaction : inscrit à la bibliothèque une fois celle-ci acquise. */
async function inscrireCvDuCandidat(candidateId: string, cvCle: string): Promise<void> {
  const doc = await prisma.document.findFirst({ where: { entityType: "RECRUITMENT_CANDIDATE", entityId: candidateId, fileKey: cvCle }, select: { id: true } });
  if (doc) await inscrireDocumentExistant(doc.id);
}

// ───────────────────────────── Trier (RH) ─────────────────────────────

export type Geste = { ok: true; message: string; candidateId?: string } | { ok: false; erreur: string };

/**
 * RATTACHE une candidature de la boîte d'arrivée à un recrutement OUVERT : elle devient un candidat
 * de ce recrutement, CV compris — le même objet qu'un CV déposé à la main. La porte est double :
 * trier la boîte (RH, direction) ET être partie à CETTE demande.
 */
export async function rattacherCandidature(
  user: SessionUser,
  id: string,
  requestId: string,
  partieALaDemande: (requestId: string) => Promise<boolean>,
  maintenant: Date = new Date(),
): Promise<Geste> {
  if (!peutTraiterCandidaturesSite(user)) return { ok: false, erreur: "Les candidatures du site se trient par les RH." };
  const cand = await prisma.siteCandidature.findUnique({
    where: { id },
    select: { id: true, etat: true, nom: true, email: true, telephone: true, message: true, cvCle: true, cvNom: true, cvType: true, cvTaille: true, offreTitre: true },
  });
  if (!cand) return { ok: false, erreur: "Candidature introuvable." };
  if (cand.etat === "RATTACHEE") return { ok: false, erreur: "Cette candidature est déjà dans un recrutement." };
  if (!(await partieALaDemande(requestId))) return { ok: false, erreur: "Ce recrutement n'est pas dans votre périmètre." };
  const demande = await prisma.recruitmentRequest.findUnique({ where: { id: requestId }, select: { id: true, reference: true, stage: true, requesterId: true } });
  if (!demande) return { ok: false, erreur: "Recrutement introuvable." };
  if (demande.stage !== "SOURCING") return { ok: false, erreur: "Une candidature ne se rattache qu'à un poste OUVERT (les CV se déposent une fois le poste ouvert par les RH)." };

  const candidateId = await prisma.$transaction(async (tx) => {
    // La précondition EST le verrou : deux clics simultanés ne font pas deux candidats.
    const pris = await tx.siteCandidature.updateMany({
      where: { id, etat: { in: ["NOUVELLE", "CLASSEE"] } },
      data: { etat: "RATTACHEE", traiteeParId: user.id, traiteeLe: maintenant, motif: null },
    });
    if (pris.count !== 1) return null;
    const c = await tx.recruitmentCandidate.create({
      data: {
        requestId, fullName: cand.nom, email: cand.email, phone: cand.telephone, source: SOURCE_SITE, notes: cand.message,
        addedById: user.id,
      },
      select: { id: true },
    });
    if (cand.cvCle) {
      await tx.document.create({
        data: {
          name: cand.cvNom ?? "cv", category: "OTHER", entityType: "RECRUITMENT_CANDIDATE", entityId: c.id, fileKey: cand.cvCle,
          mimeType: cand.cvType, sizeBytes: cand.cvTaille, version: 1, confidentiality: "INTERNAL", uploadedById: null,
        },
      });
    }
    await tx.siteCandidature.update({ where: { id }, data: { candidateId: c.id } });
    return c.id;
  });
  if (!candidateId) return { ok: false, erreur: "Cette candidature vient d'être traitée par quelqu'un d'autre." };
  if (cand.cvCle) await inscrireCvDuCandidat(candidateId, cand.cvCle);

  await notifyUser({
    userId: demande.requesterId, type: "GENERIC", title: "CV reçu à présélectionner",
    body: `${demande.reference} — ${cand.nom} (candidature déposée sur le site)`, link: `/recrutement/${demande.id}`,
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Recrutement", entityType: "RECRUITMENT_CANDIDATE", entityId: candidateId,
    summary: `${demande.reference} — candidature du site rattachée : ${cand.nom}${cand.offreTitre ? ` (déposée pour « ${cand.offreTitre} »)` : ""}`,
  });
  return { ok: true, message: `Rattachée à ${demande.reference} : ${cand.nom} est maintenant un candidat de ce recrutement.`, candidateId };
}

/** CLASSE une candidature (ne correspond à rien d'ouvert) — elle reste lisible, et se remet à trier. */
export async function classerCandidature(user: SessionUser, id: string, motif: string | null, maintenant: Date = new Date()): Promise<Geste> {
  if (!peutTraiterCandidaturesSite(user)) return { ok: false, erreur: "Les candidatures du site se trient par les RH." };
  const r = await prisma.siteCandidature.updateMany({
    where: { id, etat: "NOUVELLE" },
    data: { etat: "CLASSEE", motif: motif?.slice(0, 500) ?? "Classée sans suite.", traiteeParId: user.id, traiteeLe: maintenant },
  });
  if (r.count !== 1) return { ok: false, erreur: "Cette candidature n'est plus à trier." };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Recrutement", entityId: id, summary: `Candidature du site classée${motif ? ` : ${motif}` : ""}` });
  return { ok: true, message: "Classée. Elle reste consultable et peut être remise à trier." };
}

export async function remettreATrier(user: SessionUser, id: string): Promise<Geste> {
  if (!peutTraiterCandidaturesSite(user)) return { ok: false, erreur: "Les candidatures du site se trient par les RH." };
  const r = await prisma.siteCandidature.updateMany({ where: { id, etat: "CLASSEE" }, data: { etat: "NOUVELLE", traiteeParId: null, traiteeLe: null } });
  if (r.count !== 1) return { ok: false, erreur: "Seule une candidature classée se remet à trier." };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Recrutement", entityId: id, summary: "Candidature du site remise à trier" });
  return { ok: true, message: "Remise à trier." };
}

/**
 * EFFACE une candidature et son CV — le droit d'une personne à ce qu'on oublie sa candidature
 * (loi 18-07). Une candidature RATTACHÉE ne s'efface pas d'ici : elle est devenue un candidat du
 * pipeline, avec son historique ; c'est là-bas qu'elle se traite. Sauf si ce candidat n'existe plus
 * (son recrutement a été supprimé) : il ne reste alors que cette ligne, et elle doit pouvoir partir.
 *
 * Le fichier n'est effacé que si PLUS RIEN ne le désigne : un rattachement en a fait la pièce d'un
 * candidat (`Document.fileKey`), et l'effacer d'ici amputerait une fiche que cet écran ne montre pas.
 */
export async function effacerCandidature(user: SessionUser, id: string): Promise<Geste> {
  if (!peutTraiterCandidaturesSite(user)) return { ok: false, erreur: "Les candidatures du site se trient par les RH." };
  const c = await prisma.siteCandidature.findUnique({ where: { id }, select: { etat: true, cvCle: true, nom: true, candidateId: true } });
  if (!c) return { ok: false, erreur: "Candidature introuvable." };
  if (c.etat === "RATTACHEE" && c.candidateId) {
    return { ok: false, erreur: "Cette candidature est devenue un candidat du recrutement : elle se traite depuis sa fiche." };
  }
  const r = await prisma.siteCandidature.deleteMany({
    where: { id, OR: [{ etat: { in: ["NOUVELLE", "CLASSEE"] } }, { etat: "RATTACHEE", candidateId: null }] },
  });
  if (r.count !== 1) return { ok: false, erreur: "Cette candidature vient d'être traitée par quelqu'un d'autre." };
  if (c.cvCle && (await prisma.document.count({ where: { fileKey: c.cvCle } })) === 0) {
    await deleteFileByKey(c.cvCle).catch((e) => console.error("[candidatures] CV non effacé du stockage", id, e));
  }
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Recrutement", entityId: id, summary: "Candidature du site effacée, CV compris" });
  return { ok: true, message: `La candidature de ${c.nom} et son CV sont effacés.` };
}
