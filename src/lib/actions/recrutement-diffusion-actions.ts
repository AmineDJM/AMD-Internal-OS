"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { recruitmentViewer } from "@/lib/recruitment/access";
import { abilities, CONTRACT_LABEL, isRecruitmentContract, type RecruitmentStage } from "@/lib/recruitment/request-flow";
import { CANAL_LABEL, estCanal, type Canal, type ContenuPostLinkedIn } from "@/lib/recruitment/diffusion";
import { redigerPostLinkedIn, envoyerAEmploitic } from "@/lib/recrutement-diffusion";
import { peutPublierOffres } from "@/lib/site-web/acces";
import { lignes } from "@/lib/site-web/contrat";
import { publicationsDe } from "@/lib/site-web/etat";
import { adresseDuSite } from "@/lib/site-web/config";
import { enregistrerOffre } from "@/lib/actions/offres-emploi-actions";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DIFFUSION D'UNE OFFRE DE RECRUTEMENT — la carte « Diffusion » de la fiche (Direction, 07/10).
 *
 * « Les différents canaux s'affichent et les RH décident le ou lesquels » : chaque geste est celui d'un canal, et
 * chacun repose la même question que l'écran — `abilities().diffuse` (les RH ou le sommet, demande validée : chez les
 * RH ou poste ouvert) ET `peutPublierOffres` (la porte des offres du site). Le SITE se lit et s'écrit par l'offre
 * (JobPosting, seule source de vérité de ce canal) et par l'action existante `enregistrerOffre` ; les autres canaux
 * vivent dans `RecruitmentChannelPost`.
 *
 * Rien n'est publié « automatiquement » sur LinkedIn : aucune API n'est configurée. Le post est PRÉPARÉ (par Luna, ou
 * sans IA), la personne le publie elle-même par le lien de partage, puis le MARQUE publié.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const AUDIT_MODULE = "Recrutement";
const REFUS = "La diffusion d'une offre appartient aux RH (ou à la direction), une fois la demande validée : chez les RH, ou poste ouvert.";

type Porte =
  | { ok: true; user: Awaited<ReturnType<typeof requireUser>>; req: { id: string; reference: string; position: string } }
  | { ok: false; error: string };

/** LA PORTE COMMUNE — la demande, dans le périmètre, à une étape de diffusion, par qui peut diffuser. */
async function porteDiffusion(id: string | null): Promise<Porte> {
  const user = await requireUser();
  if (!id) return { ok: false, error: "Demande introuvable." };
  const viewer = await recruitmentViewer(user, id);
  const req = viewer && await prisma.recruitmentRequest.findUnique({ where: { id }, select: { id: true, reference: true, position: true, stage: true } });
  if (!viewer || !req) return { ok: false, error: "Cette demande n'est pas dans votre périmètre." };
  if (!peutPublierOffres(user) || !abilities(req.stage as RecruitmentStage, viewer).diffuse) return { ok: false, error: REFUS };
  return { ok: true, user, req };
}

function revalider(id: string) {
  revalidatePath(`/recrutement/${id}`);
}

const CANAUX_MANUELS: readonly Canal[] = ["LINKEDIN", "AUTRE"];

// ───────────────────────────── LinkedIn ─────────────────────────────

/** Les lignes d'un champ libre de la demande (missions, compétences), puces retirées. */
const enLignes = (s: string | null | undefined) => lignes(s ?? "");

/** CE QUE LE POST A LE DROIT DE DIRE — la demande validée, son offre, sa société. Rien d'autre. */
async function contenuDuPost(id: string): Promise<ContenuPostLinkedIn | null> {
  const r = await prisma.recruitmentRequest.findUnique({
    where: { id },
    select: {
      position: true, contractType: true, missions: true, skills: true,
      department: { select: { name: true } },
      company: { select: { name: true, shortName: true } },
      jobPosting: {
        select: { id: true, title: true, department: true, location: true, contractLabel: true, summary: true, mission: true, profile: true, offer: true, published: true },
      },
    },
  });
  if (!r) return null;
  const o = r.jobPosting;
  // Le LIEN : la page de l'offre telle que le SITE l'a confirmée ; à défaut (offre pas encore en ligne), la page
  // carrières. Sans offre, aucun lien — on n'invente pas l'adresse d'une page qui n'existe pas.
  let lien: string | null = null;
  if (o) {
    const pubs = await publicationsDe("JOB", [o.id]).catch(sansBloquer("recrutement-diffusion-actions.contenuDuPost.publicationsDe", null));
    const site = adresseDuSite();
    lien = pubs?.get(o.id)?.urlPublique ?? (site.ok ? `${site.racine}/carrieres` : null);
  }
  return {
    societe: r.company ? (r.company.shortName || r.company.name) : null,
    poste: o?.title || r.position,
    departement: o?.department ?? r.department?.name ?? null,
    lieu: o?.location ?? null,
    contrat: o?.contractLabel ?? (isRecruitmentContract(r.contractType) ? CONTRACT_LABEL[r.contractType] : null),
    resume: o?.summary ?? null,
    missions: o && o.mission.length ? o.mission : enLignes(r.missions),
    profil: o && o.profile.length ? o.profile : enLignes(r.skills),
    // La rémunération et les avantages ne sortent que s'ils sont dans l'offre PUBLIÉE — jamais depuis la demande.
    avantages: o?.published ? o.offer : [],
    lien,
  };
}

/** PRÉPARER LE POST LINKEDIN — un clic : Luna rédige selon l'entité (ou le post de secours), le texte est gardé. */
export async function preparerPostLinkedIn(formData: FormData): Promise<ActionResult> {
  const p = await porteDiffusion(fdStr(formData, "id"));
  if (!p.ok) return p;
  const existant = await prisma.recruitmentChannelPost.findUnique({
    where: { requestId_channel: { requestId: p.req.id, channel: "LINKEDIN" } }, select: { status: true },
  });
  if (existant?.status === "PUBLIE") return { ok: false, error: "Le post est déjà marqué publié : modifiez son texte plutôt que d'en préparer un autre." };
  const contenu = await contenuDuPost(p.req.id);
  if (!contenu) return { ok: false, error: "Demande introuvable." };
  const { texte, parLuna } = await redigerPostLinkedIn(contenu);
  await prisma.recruitmentChannelPost.upsert({
    where: { requestId_channel: { requestId: p.req.id, channel: "LINKEDIN" } },
    create: { requestId: p.req.id, channel: "LINKEDIN", status: "PREPARE", content: texte },
    update: { status: "PREPARE", content: texte, error: null },
  });
  await recordAudit({
    actorId: p.user.id, action: "UPDATE", module: AUDIT_MODULE, entityType: "RECRUITMENT_REQUEST", entityId: p.req.id,
    summary: `${p.req.reference} — post LinkedIn préparé${parLuna ? " par Luna" : " (modèle sans IA)"}`,
  });
  revalider(p.req.id);
  return { ok: true, message: parLuna ? "Post préparé par Luna — relisez-le, puis publiez-le sur LinkedIn." : "Post préparé (modèle sans IA) — relisez-le, puis publiez-le sur LinkedIn." };
}

/** MODIFIER LE TEXTE d'un canal manuel (le post LinkedIn, la note « Autre ») — sans changer son état. */
export async function enregistrerTexteCanal(formData: FormData): Promise<ActionResult> {
  const p = await porteDiffusion(fdStr(formData, "id"));
  if (!p.ok) return p;
  const canal = fdStr(formData, "canal");
  if (!estCanal(canal) || !CANAUX_MANUELS.includes(canal)) return { ok: false, error: "Canal inconnu (attendu : LinkedIn ou Autre)." };
  const texte = fdStr(formData, "texte");
  if (!texte) return { ok: false, error: "Le texte est vide." };
  await prisma.recruitmentChannelPost.upsert({
    where: { requestId_channel: { requestId: p.req.id, channel: canal } },
    create: { requestId: p.req.id, channel: canal, status: "PREPARE", content: texte },
    update: { content: texte },
  });
  revalider(p.req.id);
  return { ok: true, message: "Texte enregistré." };
}

/**
 * MARQUER PUBLIÉ — la personne a publié elle-même (LinkedIn, un job board, un réseau). L'adresse est facultative pour
 * LinkedIn ; pour « Autre », une adresse OU une note est exigée : sinon on ne saurait pas où l'offre a paru.
 */
export async function marquerCanalPublie(formData: FormData): Promise<ActionResult> {
  const p = await porteDiffusion(fdStr(formData, "id"));
  if (!p.ok) return p;
  const canal = fdStr(formData, "canal");
  if (!estCanal(canal) || !CANAUX_MANUELS.includes(canal)) return { ok: false, error: "Canal inconnu (attendu : LinkedIn ou Autre)." };
  const url = fdStr(formData, "url");
  const texte = fdStr(formData, "texte");
  if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: "L'adresse doit commencer par https://." };
  if (canal === "AUTRE" && !url && !texte) return { ok: false, error: "Dites où l'offre a paru : une adresse, ou une note (« Job board X », « Groupe Y »)." };
  const maintenant = new Date();
  await prisma.recruitmentChannelPost.upsert({
    where: { requestId_channel: { requestId: p.req.id, channel: canal } },
    create: { requestId: p.req.id, channel: canal, status: "PUBLIE", url, content: texte, publishedAt: maintenant, publishedById: p.user.id },
    update: { status: "PUBLIE", url, ...(texte ? { content: texte } : {}), publishedAt: maintenant, publishedById: p.user.id, error: null },
  });
  await recordAudit({
    actorId: p.user.id, action: "UPDATE", module: AUDIT_MODULE, entityType: "RECRUITMENT_REQUEST", entityId: p.req.id,
    summary: `${p.req.reference} — offre marquée publiée sur ${CANAL_LABEL[canal]}${url ? ` (${url})` : ""}`,
  });
  revalider(p.req.id);
  return { ok: true, message: `Marquée publiée sur ${CANAL_LABEL[canal]}.` };
}

/** RETIRER — l'offre n'est plus diffusée sur ce canal (la personne l'a retirée elle-même). */
export async function retirerCanal(formData: FormData): Promise<ActionResult> {
  const p = await porteDiffusion(fdStr(formData, "id"));
  if (!p.ok) return p;
  const canal = fdStr(formData, "canal");
  if (!estCanal(canal) || canal === "SITE_WEB") return { ok: false, error: "Canal inconnu (le site se retire par son offre)." };
  const ecrit = await prisma.recruitmentChannelPost.updateMany({
    where: { requestId: p.req.id, channel: canal },
    data: { status: "RETIRE" },
  });
  if (ecrit.count === 0) return { ok: false, error: "Rien à retirer sur ce canal." };
  await recordAudit({
    actorId: p.user.id, action: "UPDATE", module: AUDIT_MODULE, entityType: "RECRUITMENT_REQUEST", entityId: p.req.id,
    summary: `${p.req.reference} — offre retirée de ${CANAL_LABEL[canal]}`,
  });
  revalider(p.req.id);
  return { ok: true, message: `Retirée de ${CANAL_LABEL[canal]}.` };
}

// ───────────────────────────── Le site (l'offre existante) ─────────────────────────────

/**
 * PUBLIER / RETIRER L'OFFRE DU SITE depuis la fiche — par l'action EXISTANTE `enregistrerOffre`, avec l'offre telle
 * qu'elle est enregistrée : mêmes refus (contrat du site), même file, même audit. Rien n'est réécrit au passage.
 */
export async function publierOffreSiteDuRecrutement(formData: FormData): Promise<ActionResult> {
  const p = await porteDiffusion(fdStr(formData, "id"));
  if (!p.ok) return p;
  const intention = fdStr(formData, "intention");
  if (intention !== "publier" && intention !== "retirer") return { ok: false, error: "Geste illisible (attendu : publier ou retirer)." };
  const o = await prisma.jobPosting.findUnique({
    where: { recruitmentRequestId: p.req.id },
    select: { id: true, title: true, department: true, location: true, contractLabel: true, experience: true, summary: true, mission: true, profile: true, offer: true },
  });
  if (!o) return { ok: false, error: "Aucune offre n'est encore préparée pour cette demande : préparez-la d'abord." };
  const f = new FormData();
  f.set("id", o.id);
  f.set("intention", intention);
  f.set("title", o.title);
  for (const [cle, valeur] of [
    ["department", o.department], ["location", o.location], ["contractLabel", o.contractLabel], ["experience", o.experience],
    ["summary", o.summary], ["mission", o.mission.join("\n")], ["profile", o.profile.join("\n")], ["offer", o.offer.join("\n")],
  ] as const) {
    if (valeur) f.set(cle, valeur);
  }
  const r = await enregistrerOffre(f);
  revalider(p.req.id);
  return r;
}

// ───────────────────────────── Emploitic ─────────────────────────────

/** ENVOYER À EMPLOITIC — par le point d'extension ; tant que la clé manque, le refus le dit. */
export async function envoyerOffreEmploitic(formData: FormData): Promise<ActionResult> {
  const p = await porteDiffusion(fdStr(formData, "id"));
  if (!p.ok) return p;
  const contenu = await contenuDuPost(p.req.id);
  if (!contenu) return { ok: false, error: "Demande introuvable." };
  const envoi = await envoyerAEmploitic({ titre: contenu.poste, texte: [contenu.resume, ...contenu.missions].filter(Boolean).join("\n"), lien: contenu.lien });
  if (!envoi.ok) {
    if (envoi.nonConfigure) return { ok: false, error: envoi.error };
    await prisma.recruitmentChannelPost.upsert({
      where: { requestId_channel: { requestId: p.req.id, channel: "EMPLOITIC" } },
      create: { requestId: p.req.id, channel: "EMPLOITIC", status: "ECHEC", error: envoi.error },
      update: { status: "ECHEC", error: envoi.error },
    });
    revalider(p.req.id);
    return { ok: false, error: envoi.error };
  }
  const maintenant = new Date();
  await prisma.recruitmentChannelPost.upsert({
    where: { requestId_channel: { requestId: p.req.id, channel: "EMPLOITIC" } },
    create: { requestId: p.req.id, channel: "EMPLOITIC", status: "PUBLIE", url: envoi.url, publishedAt: maintenant, publishedById: p.user.id },
    update: { status: "PUBLIE", url: envoi.url, error: null, publishedAt: maintenant, publishedById: p.user.id },
  });
  await recordAudit({
    actorId: p.user.id, action: "UPDATE", module: AUDIT_MODULE, entityType: "RECRUITMENT_REQUEST", entityId: p.req.id,
    summary: `${p.req.reference} — offre envoyée à Emploitic`,
  });
  revalider(p.req.id);
  return { ok: true, message: "Offre envoyée à Emploitic." };
}
